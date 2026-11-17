// 淘宝闪购采集器：把 collectTaobao 的视觉全链路包装成调度器需要的 Collector 契约。
//
// 与美团/京东采集器的差异：
//   - 淘宝 u2 读屏实测 0 节点，不能走「读节点 bounds 点击」那条路，全部依赖视觉定位；
//   - 采集器内部不再做 guardMainPath 断言（读不到节点必然误判），改由每步截图验真；
//   - 少量点击目标用 src/adapters/taobao-calibration.json 的标定比例（合规见 agent.md 5.4）。
//
// 数据口径：拿不到报价时返回 failed / blocked 并在 trace 里写明卡在哪一步，绝不用模拟数据填充。
import {randomUUID} from 'node:crypto';
import type {AttemptResult, Collector, Evidence, Observation, Task} from '../domain/contracts.js';
import type {AndroidSources} from './android-source.js';
import type {ModelGateway} from '../infra/model.js';
import {collectTaobao} from './taobao-collect.js';
import {reportProgress} from './live-progress.js';
import type {EvidenceStore} from '../infra/evidence.js';
import {digest,normalize} from '../domain/competition.js';
import {installedAppVersion} from './android-transport.js';

export interface TaobaoCollectorOptions {
  sources: AndroidSources;
  evidence: EvidenceStore;
  model: Pick<ModelGateway, 'status' | 'locate' | 'json' | 'text'>;
  /** adb 可执行文件，通常取 MIDSCENE_ADB_PATH */
  adbPath: string;
  /** 设备序列号 */
  serial: string;
  /** Midscene 自带的 yadb 二进制路径，用于中文输入 */
  yadbPath: string;
  collect?: typeof collectTaobao;
  appVersion?: typeof installedAppVersion;
  progress?: typeof reportProgress;
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

    async collect(task: Task, attemptId: string, signal: AbortSignal, _attemptNumber, emit): Promise<AttemptResult> {
      const progress=opts.progress ?? reportProgress;
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
      const actualVersion=await (opts.appVersion ?? installedAppVersion)(source.device,source.package,signal).catch(()=>null);
      if (!actualVersion || source.appVersion==='unknown' || actualVersion!==source.appVersion) {
        const at=new Date().toISOString();
        return {status:'blocked',error_code:'app_version_changed',availability:'unknown',observation:null,
          trace:[{phase:'source_check',at,note:'应用版本未登记或与设备不一致'}],evidence:null,started_at:at,finished_at:at,
          cleanup:'untouched',cost:{model_yuan:null,execution_ms:0}};
      }

      const live = task.live!;
      const brand = live.target.supply.store.brand;
      const itemName = live.target.supply.item.name;
      // v2 试点允许同城同品牌不同分店：不强制命中登记的负责门店编号，只要求同品牌同城，
      // 实际分店以进入后的页面核对为准（不允许串品牌或串城市）。
      const storeName = live.target.supply.store.name;
      const storeKeyword = undefined;

      let quote: Awaited<ReturnType<typeof collectTaobao>> | null = null;
      let status: AttemptResult['status'] = 'failed';
      let error_code: string | null = null;
      let availability = 'unknown';
      let observation: Observation | null = null;
      let evidence: Evidence | null = null;
      let cleanup: AttemptResult['cleanup'] = 'untouched';
      let verifiedLive:AttemptResult['resolvedLive'];

      try {
        emit?.({phase:'navigation',state:'started'});
        void progress({platform: 'taobao_instant', node: '进入首页', state: 'running'});
        quote = await (opts.collect ?? collectTaobao)({
          adbPath: opts.adbPath,
          serial: opts.serial,
          brand,
          itemName,
          itemSpec:live.target.supply.item.spec ?? '',
          city:live.target.supply.store.city,
          evidence:opts.evidence,
          onCleanup:state=>{ cleanup=state; },
          storeKeyword,
          model: opts.model,
          yadbPath: opts.yadbPath,
          signal,
          onStep: name => {
            emit?.({phase:'navigation',state:'succeeded',data:{step:name}});
            emit?.({phase:'navigation',state:'started',data:{step:name}});
            const node = STEP_TO_PROGRESS[name];
            if (node) void progress({platform: 'taobao_instant', node, state: 'running'});
          },
        });

        for (const s of quote.steps) note(s.name, s.ok ? 'ok' : 'failed');
        if (quote.rawText) note('checkout_raw_text', quote.rawText.slice(0, 400));

        // 结算页截图的 sha256 作为本笔报价的页面证据；没有证据就不产出报价，
        // 避免出现「有金额但没有页面依据」的不可核对数据。
        evidence = quote.checkoutEvidence ?? null;
        if (quote.totalFen != null && quote.totalFen >= 0 && evidence && quote.store && quote.storeAddress && quote.item && quote.itemSpec && quote.storeEvidence && quote.itemEvidence) {
          const previous=live.mapping?.candidate.supply.store;
          const storeKey=previous && normalize(previous.name)===normalize(quote.store) && normalize(previous.address)===normalize(quote.storeAddress)
            ? previous.key : digest(['taobao_instant',quote.store,quote.storeAddress]);
          const actualSupply={store:{...live.target.supply.store,key:storeKey,name:quote.store,address:quote.storeAddress},
            item:{...live.target.supply.item,name:quote.item,spec:quote.itemSpec}};
          const target={...live.target,supply:actualSupply,revision:digest(actualSupply)};
          const exact={relation:'exact' as const,reason:'本次页面已核对',missing:[]};
          verifiedLive={...live,target,mapping:{id:randomUUID(),targetId:target.id,targetRevision:target.revision,
            candidate:{platform:'taobao_instant',entry:task.entry_point,supply:actualSupply,reference:quote.storeEvidence.id,evidence:quote.storeEvidence},
            store:exact,item:exact,status:'verified',proposedAt:quote.storeEvidence.captured_at,reviewedAt:quote.storeEvidence.captured_at}};
          // 收窄为非空常量，供下方闭包安全引用
          const ev: Evidence = evidence;
          const money = (fen: number | null) => fen == null ? null : {raw: `¥${(fen / 100).toFixed(2)}`, fen, evidence: ev};
          observation = {
            observation_id: randomUUID(),
            source_id: task.source_id, tenant_id: task.tenant_id,
            slot_id: task.slot_id, attempt_id: attemptId, platform: 'taobao_instant',
            store_id: task.store_id, basket_id: task.basket_id, scenario_id: task.scenario_id,
            price_kind: 'checkout_payable', price_scope: 'basket', currency: 'CNY',
            amount_fen: quote.totalFen,
            // raw_value 必须是能被 parseCny 解析的纯金额文本；传整页 JSON 会触发 ambiguous_amount。
            raw_value: `¥${(quote.totalFen / 100).toFixed(2)}`,
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
              product_id: live.target.id,
              name: quote.item,
              variant: quote.itemSpec,
              quantity: 1,
            }],
            account_ref: task.account_ref,
            delivery_point_id: task.delivery_point_id,
            entry_point: task.entry_point,
            evidence_refs: [evidence],
            contract_version: task.contract_version,
            collector_version: 'taobao-0.2.0',
            details: {
              components: {
                subtotal: null,
                packaging: money(quote.packagingFen),
                delivery: money(quote.deliveryFen),
                other: null,
                discount: null,
              },
              subtotalBasis: 'unknown',
              feesSeparate: null,
              eta: null,
              coupons: null,
              missing: {},
              reconciled: false,
              contextEvidence: ev,
              storeEvidence: quote.storeEvidence,
              itemEvidence: quote.itemEvidence,
            },
          };
          status = observation.detail_complete ? 'success' : 'partial';
          availability = 'available';
          void progress({platform: 'taobao_instant', node: '采数完成', state: 'completed'});
        } else {
          const failedStep = quote.steps.find(s => !s.ok);
          // 步骤名是中文，直接拼进错误码会变成一串下划线；这里映射成稳定英文码，并保留原始步骤名。
          const TAOBAO_STEP_CODES: Record<string, string> = {
            '唤醒屏幕': 'wake_screen', '冷启动淘宝': 'cold_start', '进入闪购频道': 'channel_entry', '打开搜索框': 'open_searchbox',
            '搜索品牌': 'brand_search', '进入目标门店': 'store_entry', '打开店内搜索': 'store_search', '店内搜单品': 'item_search',
            '定位单品': 'item_locate', '加购结算': 'cart_checkout', '去结算': 'checkout', '采数完成': 'read_quote',
          };
          const stepCode = failedStep ? TAOBAO_STEP_CODES[failedStep.name] ?? 'step_failed' : null;
          error_code = quote.error ?? (stepCode ? `taobao_${stepCode}_failed` : 'taobao_no_quote');
          if (failedStep?.name) note('failed_step', failedStep.name);
          note('result', error_code);
          void progress({platform: 'taobao_instant', node: STEP_TO_PROGRESS[failedStep?.name ?? ''] ?? '采数完成', state: 'failed', message: error_code});
        }
      } catch (e) {
        error_code = (e as Error).message.slice(0, 120);
        note('exception', error_code);
        void progress({platform: 'taobao_instant', node: '采数完成', state: 'failed', message: error_code});
      }
      emit?.({phase:'navigation',state:status==='success'||status==='partial'?'succeeded':'failed',errorCode:error_code ?? undefined});

      const finished_at = new Date().toISOString();
      return {
        status, error_code, availability, observation, trace,
        evidence, started_at, finished_at,
        cleanup,
        cost: {model_yuan: null, execution_ms: Date.now() - started},
        ...(observation && verifiedLive ? {resolvedLive: verifiedLive} : {}),
      };
    },
  };
}
