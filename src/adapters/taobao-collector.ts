// 淘宝闪购采集器：把 collectTaobao 的视觉全链路包装成调度器需要的 Collector 契约。
//
// 与美团/京东采集器的差异：
//   - 淘宝 u2 读屏实测 0 节点，不能走「读节点 bounds 点击」那条路，全部依赖视觉定位；
//   - 采集器内部不再做 guardMainPath 断言（读不到节点必然误判），改由每步截图验真；
//   - 少量点击目标用 src/adapters/taobao-calibration.json 的标定比例（合规见 agent.md 5.4）。
//
// 数据口径：拿不到报价时返回 failed / blocked 并在 trace 里写明卡在哪一步，绝不用模拟数据填充。
import {randomUUID} from 'node:crypto';
import type {AttemptResult, Collector, Observation, Task} from '../domain/contracts.js';
import type {AndroidSources} from './android-source.js';
import type {ModelGateway} from '../infra/model.js';
import {collectTaobao} from './taobao-collect.js';
import {reportProgress} from './live-progress.js';

export interface TaobaoCollectorOptions {
  sources: AndroidSources;
  model: Pick<ModelGateway, 'status' | 'locate' | 'json'>;
  /** adb 可执行文件，通常取 MIDSCENE_ADB_PATH */
  adbPath: string;
  /** 设备序列号 */
  serial: string;
  /** Midscene 自带的 yadb 二进制路径，用于中文输入 */
  yadbPath: string;
}

/** 采集链路节点 → 前端进度条节点名的映射，供 /ue 与 /bd 的进度条显示 */
const STEP_TO_PROGRESS: Record<string, string> = {
  '唤醒屏幕': '进入首页',
  '冷启动淘宝': '进入首页',
  '进入闪购频道': '打开外卖频道',
  '打开搜索框': '搜索品牌名',
  '搜索品牌': '搜索品牌名',
  '进入目标门店': '进入门店结果页',
  '打开店内搜索': '进入店铺',
  '店内搜单品': '定位爆品',
  '定位单品': '定位爆品',
  '加购结算': '加购结算',
  '去结算': '加购结算',
  '采数完成': '采数完成',
};

export function liveTaobaoCollector(opts: TaobaoCollectorOptions): Collector {
  return {
    platform: 'taobao_instant',
    mode: 'live',
    async close() {},

    async collect(task: Task, attemptId: string, signal: AbortSignal): Promise<AttemptResult> {
      const started = Date.now();
      const started_at = new Date(started).toISOString();
      const trace: AttemptResult['trace'] = [];
      const note = (phase: string, text: string) => trace.push({phase, at: new Date().toISOString(), note: text});

      const source = opts.sources.get('taobao_instant');
      // 淘宝闪购尚未取得书面采集许可，permitted() 会返回 false；这里与京东/美团保持同样的
      // 「先查来源可用性再干活」的顺序，避免在未授权状态下真的去操作 App。
      if (!source || !opts.sources.permitted('taobao_instant')) {
        const at = new Date().toISOString();
        note('source_check', 'live_source_not_ready');
        return {
          status: 'blocked', error_code: 'live_source_not_ready', availability: 'unknown',
          observation: null, trace, evidence: null, started_at: at, finished_at: at,
          cleanup: 'untouched', cost: {model_yuan: null, execution_ms: 0},
        };
      }
      if (!opts.model.status.configured) {
        const at = new Date().toISOString();
        note('model_check', 'model_not_configured');
        return {
          status: 'blocked', error_code: 'model_not_configured', availability: 'unknown',
          observation: null, trace, evidence: null, started_at: at, finished_at: at,
          cleanup: 'untouched', cost: {model_yuan: null, execution_ms: 0},
        };
      }

      const live = task.live!;
      const brand = live.target.supply.store.brand;
      const itemName = live.target.supply.item.name;
      // 门店关键字取登记门店名里有区分度的一段，例如「鞍山西」
      const storeName = live.target.supply.store.name;
      const storeKeyword = storeName.replace(/^.*?[（(]/, '').replace(/[)）].*$/, '').replace(/(店|分店)$/, '') || undefined;

      let quote: Awaited<ReturnType<typeof collectTaobao>> | null = null;
      let status: AttemptResult['status'] = 'failed';
      let error_code: string | null = null;
      let availability = 'unknown';
      let observation: Observation | null = null;

      try {
        reportProgress({platform: 'taobao_instant', node: '进入首页', state: 'running'});
        quote = await collectTaobao({
          adbPath: opts.adbPath,
          serial: opts.serial,
          brand,
          itemName,
          storeKeyword,
          model: opts.model,
          yadbPath: opts.yadbPath,
          signal,
          onStep: name => {
            const node = STEP_TO_PROGRESS[name];
            if (node) reportProgress({platform: 'taobao_instant', node, state: 'running'});
          },
        });

        for (const s of quote.steps) note(s.name, s.ok ? 'ok' : 'failed');

        if (quote.totalFen != null && quote.totalFen > 0) {
          observation = {
            observation_id: randomUUID(),
            source_id: task.source_id, tenant_id: task.tenant_id,
            slot_id: task.slot_id, attempt_id: attemptId, platform: 'taobao_instant',
            store_id: task.store_id, basket_id: task.basket_id, scenario_id: task.scenario_id,
            price_kind: 'checkout_payable', price_scope: 'basket', currency: 'CNY',
            amount_fen: quote.totalFen,
            raw_value: quote.rawText ?? String(quote.totalFen / 100),
            components: {
              delivery_fee: {
                amount_fen: quote.deliveryFen, raw_value: quote.deliveryFen == null ? null : String(quote.deliveryFen / 100),
                basis: 'separately_displayed', included_in: 'checkout_payable',
              },
              packaging_fee: {
                amount_fen: quote.packagingFen, raw_value: quote.packagingFen == null ? null : String(quote.packagingFen / 100),
                basis: 'separately_displayed', included_in: 'checkout_payable',
              },
            },
            missing_reasons: {
              ...(quote.deliveryFen == null ? {delivery_fee: 'not_displayed'} : {}),
              ...(quote.packagingFen == null ? {packaging_fee: 'not_displayed'} : {}),
            },
            observed_at: new Date().toISOString(),
            collected_at: new Date().toISOString(),
            value_origin: 'observed',
            quote_valid: true,
            detail_complete: quote.packagingFen != null && quote.deliveryFen != null,
            basket_items: [{
              product_id: live.target.supply.item.key,
              name: itemName,
              variant: live.target.supply.item.spec ?? '1人份',
              quantity: 1,
            }],
            account_ref: task.account_ref,
            delivery_point_id: task.delivery_point_id,
            entry_point: task.entry_point,
            evidence_refs: [],
            contract_version: task.contract_version,
            collector_version: 'taobao-0.1.0',
          };
          status = observation.detail_complete ? 'success' : 'partial';
          availability = 'available';
          reportProgress({platform: 'taobao_instant', node: '采数完成', state: 'completed'});
        } else {
          const failedStep = quote.steps.find(s => !s.ok);
          error_code = failedStep ? `taobao_${failedStep.name.replace(/[^\w]/g, '_')}_failed` : 'taobao_no_quote';
          note('result', error_code);
          reportProgress({platform: 'taobao_instant', node: STEP_TO_PROGRESS[failedStep?.name ?? ''] ?? '采数完成', state: 'failed', message: error_code});
        }
      } catch (e) {
        error_code = (e as Error).message.slice(0, 120);
        note('exception', error_code);
        reportProgress({platform: 'taobao_instant', node: '采数完成', state: 'failed', message: error_code});
      }

      const finished_at = new Date().toISOString();
      return {
        status, error_code, availability, observation, trace,
        evidence: null, started_at, finished_at,
        cleanup: 'untouched',
        cost: {model_yuan: null, execution_ms: Date.now() - started},
        ...(observation && live ? {resolvedLive: live} : {}),
      };
    },
  };
}
