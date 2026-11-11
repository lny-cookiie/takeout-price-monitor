// 美团采集器：接入调度器，把 navigateMeituan 全链路 + 结算字段读取包装成 Collector 契约。
// 设计取舍：优先跑通真实链路并落库；字段缺失时返回 partial 并在 missing_reasons 说明原因，
// 不用任何模拟数据填充，保证落库数据可追溯。
import {randomUUID} from 'node:crypto';
import type {AttemptResult, Collector, Observation, Task} from '../domain/contracts.js';
import {connectAndroid} from './android-transport.js';
import type {AndroidSources, AndroidSource} from './android-source.js';
import type {ModelGateway} from '../infra/model.js';
import type {EvidenceStore} from '../infra/evidence.js';
import {createU2Semantic} from './meituan-semantic.js';
import {navigateMeituan, readMeituanSettlement, meituanActualPayable} from './meituan-collect.js';

export interface MeituanCollectorOptions {
  sources: AndroidSources;
  model: Pick<ModelGateway, 'status' | 'locate'>;
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

        const semantic = createU2Semantic({
          tapPoint: (x: number, y: number) => device.tap(x, y),
          logicalSize,
          physicalSize: async () => physical,
          back: async () => { await device.back?.(); },
          sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
          visualLocate: async (hint: string) => {
            const shot = await (device as any).screenshot();
            const [px, py] = await opts.model.locate('meituan', shot, hint, signal);
            const logical = await logicalSize();
            return {x: px / physical.width * logical.width, y: py / physical.height * logical.height};
          },
          brand, itemName,
        } as any);

        emit?.({phase: 'brand_search', state: 'started'});
        const steps = await navigateMeituan({
          semantic,
          sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
          brand,
          itemName,
          searchText: async (text: string) => { await (device as any).search?.(text, signal, true); },
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
        const payable = meituanActualPayable({
          discount_fen: quote.discount_fen ?? null,
          coupon_before_fen: quote.coupon_before_fen ?? null,
          payable_fen: quote.payable_fen ?? null,
        });
        const totalFen = Number((payable as any)?.actualFen ?? (payable as any)?.payable_fen ?? 0);
        if (!totalFen) throw new Error('meituan_payable_missing');

        observation = {
          observation_id: randomUUID(), source_id: task.source_id, tenant_id: task.tenant_id,
          slot_id: task.slot_id, attempt_id: attemptId, platform: 'meituan',
          store_id: task.store_id, basket_id: task.basket_id, scenario_id: task.scenario_id,
          price_kind: 'checkout_payable', price_scope: 'basket', currency: 'CNY',
          amount_fen: totalFen, raw_value: String((payable as any)?.raw ?? totalFen / 100),
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
          evidence_refs: [], contract_version: task.contract_version, collector_version: 'meituan-0.1.0',
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
        evidence: null, started_at, finished_at,
        cleanup: 'untouched',
        cost: {model_yuan: null, execution_ms: Date.now() - started},
        ...(observation ? {resolvedLive: live} : {}),
      };
    },
  };
}
