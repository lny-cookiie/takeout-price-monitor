// 美团采集器：接入调度器，把 navigateMeituan 全链路 + 结算字段读取包装成 Collector 契约。
// 设计取舍：优先跑通真实链路并落库；字段缺失时返回 partial 并在 missing_reasons 说明原因，
// 不用任何模拟数据填充，保证落库数据可追溯。
import {createHash, randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type {AttemptResult, Collector, Evidence, Observation, Task} from '../domain/contracts.js';
import {connectAndroid} from './android-transport.js';
import type {AndroidSources, AndroidSource} from './android-source.js';
import type {ModelGateway} from '../infra/model.js';
import type {EvidenceStore} from '../infra/evidence.js';
import {createU2Semantic} from './meituan-semantic.js';
import {navigateMeituan, readMeituanSettlement, meituanActualPayable} from './meituan-collect.js';

export interface MeituanCollectorOptions {
  sources: AndroidSources;
  model: Pick<ModelGateway, 'status' | 'locate' | 'json'>;
  evidence: EvidenceStore;
  connect?: typeof connectAndroid;
}

export function liveMeituanCollector(opts: MeituanCollectorOptions): Collector {
  return {
    platform: 'meituan',
    mode: 'live',
    async close() {},
    async collect(task: Task, attemptId: string, signal: AbortSignal, _attemptNumber, emit): Promise<AttemptResult> {
      const started = Date.now(), started_at = new Date(started).toISOString();
      const trace: AttemptResult['trace'] = [];
      const note = (phase: string, text: string) => trace.push({phase, at: new Date().toISOString(), note: text});
      const source = opts.sources.get('meituan') as AndroidSource | undefined;
      if (!source) throw new Error('live_source_not_ready');
      if (!opts.model.status.configured) throw new Error('model_not_configured');

      const live = task.live!;
      const itemName = live.target.supply.item.name;
      const brand = live.target.supply.store.brand;
      let observation: Observation | null = null;
      let evidence: Evidence | null = null;
      let status: AttemptResult['status'] = 'failed';
      let error_code: string | null = null;
      let availability = 'unknown';

      try {
        emit?.({phase: 'connect', state: 'started'});
        const device = await (opts.connect ?? connectAndroid)(source, signal);
        note('connect', '已连接设备');
        emit?.({phase: 'connect', state: 'succeeded'});

        const logicalSize = async () => device.size();
        let physical = {width: 1260, height: 2844};
        try {
          const out = await (device as any).shell?.('wm size');
          const m = /(\d+)x(\d+)/.exec(String(out ?? ''));
          if (m) physical = {width: Number(m[1]), height: Number(m[2])};
        } catch { /* 用默认值 */ }

        // 视觉定位与点击：美团门店卡在 MRNX 容器里读不到节点，这两项是必要兜底能力，
        // 抽成变量后同时提供给语义层和导航流程，避免各写一套。
        const visualLocate = async (hint: string) => {
          const shot = await (device as any).screenshot();
          const [px, py] = await opts.model.locate('meituan', shot, hint, signal);
          const logical = await logicalSize();
          return {x: px / physical.width * logical.width, y: py / physical.height * logical.height};
        };
        const tapPoint = (x: number, y: number) => device.tap(x, y);
        const semantic = createU2Semantic({
          tapPoint,
          logicalSize,
          physicalSize: async () => physical,
          back: async () => { await device.back?.(); },
          sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
          visualLocate,
          brand, itemName,
        } as any);

        emit?.({phase: 'brand_search', state: 'started'});
        const steps = await navigateMeituan({
          semantic,
          sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
          brand,
          itemName,
          searchText: async (text: string) => { await (device as any).search?.(text, signal, true); },
          // 门店卡在 MRNX 容器里读不到节点，必须把视觉兜底传进去，
          // 否则 navigateMeituan 会直接抛 meituan_store_card_needs_visual。
          visualLocate,
          tapPoint,
        } as any);
        emit?.({phase: 'brand_search', state: 'succeeded', data: {steps}});
        note('nav', steps.join(' > '));

        // 读结算页
        emit?.({phase: 'checkout', state: 'started'});
        let quote: ReturnType<typeof readMeituanSettlement> | null = null;
        for (let i = 0; i < 20 && !quote?.raw?.['券前']; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const nodes = await semantic.read().catch(() => []);
          if (!nodes.length) continue;
          const parsed = readMeituanSettlement(nodes);
          if (parsed.raw?.['券前']) quote = parsed;
        }
        if (!quote) throw new Error('meituan_no_checkout');
        // 结算页截图：既做视觉取数的输入，也做这笔报价的页面证据。
        let checkoutShot: Buffer | null = null;
        try {
          checkoutShot = await (device as any).screenshot();
          if (checkoutShot) await writeFile('.runtime/mt-checkout-final.png', checkoutShot).catch(() => null);
        } catch { checkoutShot = null; }
        const payable = meituanActualPayable({
          discount_fen: quote.discount_fen ?? null,
          coupon_before_fen: quote.coupon_before_fen ?? null,
          payable_fen: quote.payable_fen ?? null,
        });
        let totalFen = Number((payable as any)?.actualFen ?? (payable as any)?.payable_fen ?? 0);
        if (!totalFen && checkoutShot) {
          // 美团结算页是 MRNX 自绘容器，u2 有时读不到金额节点；读不到时降级用视觉读同一屏。
          const askFen = async (task: string): Promise<number | null> => {
            try {
              const r = await opts.model.json<{value: string}>('meituan', 'meituan_checkout_amount',
                '读取这张美团结算页截图里的指定金额，只输出图中明确显示的数字（可带¥），读不到就输出空字符串。只依据可见内容，不猜。',
                {task}, (v: unknown) => v as {value: string}, {image: checkoutShot!, signal,
                  schema: {type: 'object', properties: {value: {type: 'string'}}, required: ['value'], additionalProperties: false}});
              const raw = (r as {value?: string})?.value?.trim();
              if (!raw) return null;
              const m = /-?\d+(?:\.\d+)?/.exec(raw.replace(/,/g, ''));
              return m ? Math.round(Number(m[0]) * 100) : null;
            } catch { return null; }
          };
          const beforeFen = await askFen('“券前”后面显示的商品合计金额');
          const cutFen = await askFen('“共减”后面显示的优惠金额');
          const netFen = await askFen('最下方“立即支付”按钮左侧显示的最终应付金额');
          if (beforeFen !== null && cutFen !== null) totalFen = Math.max(0, beforeFen - cutFen);
          else if (netFen !== null) totalFen = netFen;
          if (totalFen) note('checkout_visual', `券前=${beforeFen} 共减=${cutFen} 应付=${netFen} → ${totalFen}`);
        }
        if (!totalFen) throw new Error('meituan_payable_missing');

        // 报价证据：结算页截图的 sha256
        evidence = checkoutShot ? {
          id: randomUUID(),
          sha256: createHash('sha256').update(checkoutShot).digest('hex'),
          screenshot: '.runtime/mt-checkout-final.png',
          text_file: '',
          captured_at: new Date().toISOString(),
          page_stage: 'checkout',
        } : null;

        if (!evidence) throw new Error('meituan_no_evidence');
        observation = {
          observation_id: randomUUID(), source_id: task.source_id, tenant_id: task.tenant_id,
          slot_id: task.slot_id, attempt_id: attemptId, platform: 'meituan',
          store_id: task.store_id, basket_id: task.basket_id, scenario_id: task.scenario_id,
          price_kind: 'checkout_payable', price_scope: 'basket', currency: 'CNY',
          amount_fen: totalFen, raw_value: `¥${(totalFen / 100).toFixed(2)}`,
          components: {
            delivery_fee: {amount_fen: quote.delivery_fen ?? null, raw_value: quote.raw?.['用户配送费'] ?? null, basis: 'separately_displayed', included_in: 'checkout_payable'},
            packaging_fee: {amount_fen: quote.packaging_fen ?? null, raw_value: quote.raw?.['打包费'] ?? null, basis: 'separately_displayed', included_in: 'checkout_payable'},
          },
          missing_reasons: {
            ...(quote.delivery_fen == null ? {delivery_fee: 'not_displayed'} : {}),
            ...(quote.packaging_fen == null ? {packaging_fee: 'not_displayed'} : {}),
          },
          observed_at: new Date().toISOString(), collected_at: new Date().toISOString(),
          value_origin: 'observed', quote_valid: true,
          detail_complete: quote.delivery_fen != null && quote.packaging_fen != null,
          basket_items: [{product_id: live.target.supply.item.key, name: itemName, variant: live.target.supply.item.spec ?? '1人份', quantity: 1}],
          account_ref: task.account_ref, delivery_point_id: task.delivery_point_id, entry_point: task.entry_point,
          evidence_refs: [evidence],
          contract_version: task.contract_version, collector_version: 'meituan-0.1.0',
          details: {
            components: {
              subtotal: {raw: `¥${((quote.coupon_before_fen ?? totalFen) / 100).toFixed(2)}`, fen: quote.coupon_before_fen ?? totalFen, evidence},
              packaging: quote.packaging_fen == null ? null : {raw: `¥${(quote.packaging_fen / 100).toFixed(2)}`, fen: quote.packaging_fen, evidence},
              delivery: quote.delivery_fen == null ? null : {raw: `¥${(quote.delivery_fen / 100).toFixed(2)}`, fen: quote.delivery_fen, evidence},
              other: null,
              discount: quote.discount_fen == null ? null : {raw: `¥${(quote.discount_fen / 100).toFixed(2)}`, fen: quote.discount_fen, evidence},
            },
            subtotalBasis: 'after_discount',
            feesSeparate: true,
            eta: null,
            coupons: null,
            missing: {},
            reconciled: false,
            contextEvidence: evidence,
            storeEvidence: evidence,
            itemEvidence: evidence,
          },
        };
        status = observation.detail_complete ? 'success' : 'partial';
        availability = 'available';
        emit?.({phase: 'checkout', state: 'succeeded', data: {amountFen: totalFen, components: quote.raw}});
      } catch (e) {
        error_code = (e as Error).message.slice(0, 120);
        emit?.({phase: 'checkout', state: 'failed', errorCode: error_code});
        note('error', error_code);
      }

      const finished_at = new Date().toISOString();
      return {
        status, error_code, availability, observation, trace,
        evidence, started_at, finished_at,
        cleanup: 'untouched',
        cost: {model_yuan: null, execution_ms: Date.now() - started},
        ...(observation ? {resolvedLive: live} : {}),
      };
    },
  };
}
