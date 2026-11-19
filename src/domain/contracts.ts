import { Ajv2020 } from 'ajv/dist/2020.js';
import { BUSINESS_VERSION, digest, itemGate, liveSources, normalize, storeGate, type LiveContext, type MarketRead, type Profile, type QuoteDetails } from './competition.js';
import { matchesJdStore } from './jd-shelf.js';
import type { JdRunInput, JdShelfContext, JdShelfResult } from './jd-shelf.js';
export const CONTRACT_VERSION = '1.0.0-draft.1';
export const TENANT = 'local_pilot';
export const FIXTURE_PLATFORMS = ['meituan', 'taobao_instant'] as const;
export const PLATFORMS = ['jd', ...FIXTURE_PLATFORMS] as const;
export type Platform = typeof PLATFORMS[number];
export type ResultStatus = 'success' | 'partial' | 'unavailable' | 'blocked' | 'failed';
export const SCENARIOS = ['baseline', 'mixed', 'price_change', 'network_retry', 'cart_conflict', 'zero_quote'] as const;
export type Scenario = typeof SCENARIOS[number];
export type Fault = 'none' | 'missing_fee' | 'sold_out' | 'captcha' | 'schema_changed' | 'minimum_not_met' | 'network_once' | 'cart_not_owned' | 'price_change' | 'zero_quote';
export interface BasketItem { product_id: string; name: string; variant: string; quantity: number }
export interface Basket { id: string; name: string; items: BasketItem[] }
export interface Product { id: string; name: string; variants: { name: string; price_fen: number }[] }
export interface Store { id: string; name: string; address: string; category: string; products: Product[]; baskets: Basket[] }
export interface Task {
  contract_version: string; source_id: string; tenant_id: string; slot_id: string; run_id: string; comparison_group_id: string;
  platform: Platform; store_id: string; basket_id: string; scenario_id: string; entry_point: string;
  account_ref: string; device_ref: string; delivery_point_id: string; due_at: string; deadline_at: string;
  data_mode: 'synthetic' | 'live'; fault: Fault; max_attempts: number; timeout_seconds: number;
  requested_fields: string[]; required_fields: string[]; allowed_actions: string[];
  live?: LiveContext;
  shelf?: JdShelfContext & { profile: Profile };
  jdShelfParent?: string;
  jdOrigin?: JdRunInput;
  jdItemKey?: string;
  specified?: { catalogRevision:string; source:'internal'|'trial'; sourceVersion:string; couponCheckoutConsent?:{reference:string;confirmedAt:string} };
}
export interface TraceStep { phase: string; at: string; note: string }
export interface StepUpdate {
  phase:string; state:'started'|'succeeded'|'skipped'|'blocked'|'failed';
  data?:Record<string,unknown>; errorCode?:string; evidenceIds?:string[];
}
export type StepSink = (event:StepUpdate)=>void;
export interface AttemptStep {
  phase:string; state:StepUpdate['state']|'interrupted'; at:string; elapsedMs:number|null;
  data:Record<string,unknown>|null; errorCode:string|null; evidenceIds:string[];
}
export interface Evidence { id: string; sha256: string; screenshot: string; text_file: string; captured_at: string; page_stage: string }
export interface MoneyComponent { amount_fen: number | null; raw_value: string | null; basis: 'separately_displayed' | 'unknown'; included_in: 'checkout_payable' | null }
export interface Observation {
  observation_id: string; source_id: string; tenant_id: string; slot_id: string; attempt_id: string; platform: Platform;
  store_id: string; basket_id: string; scenario_id: string;
  price_kind: 'checkout_payable'; price_scope: 'basket'; currency: 'CNY'; amount_fen: number; raw_value: string;
  components: { delivery_fee: MoneyComponent; packaging_fee: MoneyComponent }; missing_reasons: Record<string, string>;
  observed_at: string; collected_at: string; value_origin: 'synthetic' | 'observed'; quote_valid: boolean; detail_complete: boolean;
  basket_items: BasketItem[]; account_ref: string; delivery_point_id: string; entry_point: string;
  evidence_refs: Evidence[]; contract_version: string; collector_version: string;
  details?: QuoteDetails;
}
export interface AttemptResult {
  pageMap?:{ontologyVersion:string;mapVersion:string;appVersion:string};
  resolvedLive?: LiveContext;
  quoteReadyAt?: string;
  timings?: {treeReads:number;treeMs:number;screenshots:number;screenshotMs:number;waitMs:number;retries:number;cleanupMs:number;cacheHits?:number};
  menuPriceReason?: string | null;
  status: ResultStatus; error_code: string | null; availability: string; observation: Observation | null;
  trace: TraceStep[]; evidence: Evidence | null; started_at: string; finished_at: string;
  cleanup: 'restored' | 'untouched' | 'quarantined' | 'needs_attention'; cost: { model_yuan: number | null; execution_ms: number };
  market?: MarketRead;
  shelf?: JdShelfResult;
}
export interface QuoteReview { observationId:string; decision:'verified'|'disputed'; note:string; minutes:number|null; reviewedAt:string }
export interface Slot { task: Task; state: string; attempts: number; result: AttemptResult | null; next_attempt_at: string | null; review?:QuoteReview|null; block_reason?:string }
export interface Collector {
  mode?: Task['data_mode'];
  platform: Platform;
  collect(task: Task, attempt_id: string, signal: AbortSignal, attempt_number?: number, emit?:StepSink): Promise<AttemptResult>;
  close(): Promise<void>;
}
// No model is connected in v0.1.0. Fixture selectors are deterministic and never labelled AI.
export interface PageAdvisor {
  suggest(input: { platform: Platform; phase: string; redacted_text: string }): Promise<{
    selector_candidates: string[]; expected_state: string; evidence_excerpt: string;
  }>;
}
export class CollectionError extends Error {
  constructor(public code: string, public status: ResultStatus = 'failed', public availability = 'unknown') { super(code); }
}
export const TASK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
  required: ['contract_version','source_id','tenant_id','slot_id','run_id','comparison_group_id','platform','store_id','basket_id','scenario_id','entry_point','account_ref','device_ref','delivery_point_id','due_at','deadline_at','data_mode','fault','max_attempts','timeout_seconds','requested_fields','required_fields','allowed_actions'],
  properties: {
    ...Object.fromEntries(['tenant_id','slot_id','run_id','comparison_group_id','store_id','basket_id','scenario_id','entry_point','account_ref','device_ref','delivery_point_id','due_at','deadline_at'].map(k => [k, { type: 'string', minLength: 1 }])),
    live: { type: 'object' }, shelf:{type:'object',required:['input','sourceRevision','profile']}, jdShelfParent:{type:'string',minLength:1},
    jdOrigin:{type:'object'}, jdItemKey:{type:'string',minLength:1}, specified:{type:'object',required:['catalogRevision','source','sourceVersion']},
    contract_version: { enum: [CONTRACT_VERSION,BUSINESS_VERSION] }, source_id: { enum: ['LOCAL_FIXTURE',...Object.values(liveSources)] }, platform: { enum: PLATFORMS }, data_mode: { enum: ['synthetic','live'] },
    fault: { enum: ['none','missing_fee','sold_out','captcha','schema_changed','minimum_not_met','network_once','cart_not_owned','price_change','zero_quote'] },
    max_attempts: { type: 'integer', minimum: 1, maximum: 2 }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 240 },
    requested_fields: { type: 'array', uniqueItems: true, items: { enum: ['checkout_payable','delivery_fee','packaging_fee'] } },
    required_fields: { type: 'array', uniqueItems: true, items: { enum: ['checkout_payable'] } },
    allowed_actions: { type: 'array', uniqueItems: true, items: { enum: ['browse','select_variant','modify_owned_test_cart','read_checkout'] } }
  }
} as const;
const ajv = new Ajv2020({ allErrors: true });
const taskCheck = ajv.compile(TASK_SCHEMA);
export function validateTask(task: Task): void {
  if (!taskCheck(task)) throw new CollectionError('invalid_task:' + ajv.errorsText(taskCheck.errors));
  if (task.tenant_id !== TENANT) throw new CollectionError('tenant_mismatch');
  if ((task.data_mode === 'synthetic') !== (task.source_id === 'LOCAL_FIXTURE')) throw new CollectionError('invalid_source_mode');
  if (task.data_mode === 'live' && (task.source_id !== liveSources[task.platform] || task.contract_version !== BUSINESS_VERSION || (!task.live && !task.shelf))) throw new CollectionError('invalid_live_context');
  if (task.data_mode === 'synthetic' && (task.platform === 'jd' || task.live || task.shelf || task.jdShelfParent || task.contract_version !== CONTRACT_VERSION)) throw new CollectionError('invalid_fixture_context');
  if (task.specified ? (!task.jdOrigin || task.jdShelfParent || task.shelf || task.platform!=='jd' || task.live?.quantity!==1 || task.live.target.supply.item.kind!=='single') :
    (Boolean(task.jdShelfParent)!==Boolean(task.jdOrigin) || Boolean(task.jdShelfParent)!==Boolean(task.jdItemKey))) throw new CollectionError('invalid_jd_shelf_origin');
  if(task.live?.couponPolicy==='claim_on_checkout'&&(!task.specified?.couponCheckoutConsent?.reference||task.specified.source!=='trial'))throw new CollectionError('coupon_claim_not_authorized');
  if (task.shelf ? (task.live || task.jdShelfParent || task.platform!=='jd' || task.allowed_actions.join()!=='browse' || task.requested_fields.length || task.required_fields.length) :
    (!task.requested_fields.length || !task.required_fields.length || (task.jdShelfParent && task.platform!=='jd'))) throw new CollectionError('invalid_task_operation');
  if (!task.required_fields.every(f => task.requested_fields.includes(f))) throw new CollectionError('invalid_required_fields');
  if (!Number.isFinite(Date.parse(task.due_at)) || !Number.isFinite(Date.parse(task.deadline_at)) || Date.parse(task.deadline_at) <= Date.parse(task.due_at)) throw new CollectionError('invalid_window');
  if ([task.due_at,task.deadline_at].some(s => new Date(s).toISOString() !== s)) throw new CollectionError('canonical_utc_required');
}
export function parseCny(raw: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(raw.trim().replace(/^[¥￥]\s*/, '').replace(/\s*元$/, ''));
  if (!match) throw new CollectionError('ambiguous_amount');
  const fen = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(fen) || fen < 0 || fen > 10_000_000) throw new CollectionError('invalid_amount');
  return fen;
}
export function checkObservation(task: Task, o: Observation): void {
  for (const f of ['source_id','tenant_id','slot_id','platform','store_id','basket_id','scenario_id','account_ref','delivery_point_id','entry_point'] as const) if (task[f] !== o[f]) throw new CollectionError('scenario_mismatch');
  if ((task.data_mode === 'synthetic') !== (o.value_origin === 'synthetic')) throw new CollectionError('mixed_data_mode');
  if (task.data_mode === 'live') {
    const context=task.live, mapping=context?.mapping;
    if (!o.details || o.contract_version!==BUSINESS_VERSION || !context) throw new CollectionError('invalid_live_quote');
    const line=o.basket_items?.[0];
    if (task.platform==='jd') {
      // 京东：必须命中已验证的货架映射，单品 ID 与规格都要对上。
      if (!mapping || mapping.status!=='verified' ||
        mapping.targetRevision!==context.target.revision || mapping.candidate.platform!==task.platform || mapping.candidate.entry!==task.entry_point ||
        storeGate(context.target.supply,mapping.candidate.supply) || itemGate(context.target.supply,mapping.candidate.supply)) throw new CollectionError('invalid_live_quote');
      if (!line || o.basket_items.length!==1 || line.product_id!==context.target.id || line.variant!==mapping.candidate.supply.item.spec ||
        line.quantity!==context.quantity) throw new CollectionError('basket_mismatch');
    } else {
      // 美团/淘宝闪购：没有京东货架映射概念，改为直接校验目标 ID、数量与单品名一致。
      if (!line || o.basket_items.length!==1 || line.product_id!==context.target.id ||
        line.quantity!==context.quantity || normalize(line.variant)!==normalize(context.target.supply.item.spec)) throw new CollectionError('basket_mismatch');
      if (normalize(line.name??'')!==normalize(context.target.supply.item.name)) throw new CollectionError('basket_mismatch');
    }
  }
  const at = Date.parse(o.observed_at);
  if (!Number.isFinite(at) || at < Date.parse(task.due_at) || at > Date.parse(task.deadline_at)) throw new CollectionError('window_missed');
  if (parseCny(o.raw_value) !== o.amount_fen) throw new CollectionError('amount_mismatch');
  if (!o.evidence_refs.length || !o.evidence_refs.every(e => /^[a-f0-9]{64}$/.test(e.sha256) && e.page_stage === 'checkout')) throw new CollectionError('evidence_unavailable');
  if (o.price_kind !== 'checkout_payable' || o.currency !== 'CNY' || o.price_scope !== 'basket') throw new CollectionError('price_kind_mismatch');
  if (!Array.isArray(o.basket_items) || !o.basket_items.length || o.basket_items.some(i => !i.product_id || !i.variant || !Number.isInteger(i.quantity) || i.quantity < 1)) throw new CollectionError('basket_mismatch');
  for (const f of ['delivery_fee','packaging_fee'] as const) {
    const component = o.components[f], v = component.amount_fen;
    if (v === null && task.requested_fields.includes(f) && !o.missing_reasons[f]) throw new CollectionError('missing_reason');
    if (v !== null && (!Number.isSafeInteger(v) || v < 0)) throw new CollectionError('invalid_component');
    if (v !== null && (component.raw_value === null || parseCny(component.raw_value) !== v)) throw new CollectionError('component_amount_mismatch');
  }
}
export function checkResult(task: Task, r: AttemptResult): void {
  if(r.resolvedLive) {
    // 用户确认同城门店价差很小：允许采集到品牌下任意门店，只校验商品与任务一致，不再按配置门店阻断。
    // jdOrigin、货架单品与价格带 gate 都是京东货架链路专有概念；美团与淘宝闪购没有货架映射，
    // 只校验「同一目标、数量 1、来源版本与套餐一致、单品名一致」，细节交给 observation 级校验。
    if(task.platform==='jd') {
      if(!task.specified || !task.live || !task.jdOrigin || r.resolvedLive.target.id!==task.live.target.id || r.resolvedLive.quantity!==1 ||
        digest(r.resolvedLive.profile)!==digest(task.live.profile) || r.resolvedLive.couponPolicy!==task.live.couponPolicy ||
        r.resolvedLive.sourceRevision!==task.live.sourceRevision || r.resolvedLive.meal!==task.live.meal ||
        normalize(r.resolvedLive.target.supply.item.name)!==normalize(task.live.target.supply.item.name) ||
        itemGate(task.live.target.supply,r.resolvedLive.target.supply))
        throw new CollectionError('resolved_target_mismatch');
    } else {
      const resolved=r.resolvedLive, mapping=resolved.mapping, actual=resolved.target.supply;
      if(!task.live || r.resolvedLive.target.id!==task.live.target.id || r.resolvedLive.quantity!==1 ||
        digest(r.resolvedLive.profile)!==digest(task.live.profile) ||
        r.resolvedLive.sourceRevision!==task.live.sourceRevision ||
        r.resolvedLive.meal!==task.live.meal || r.resolvedLive.couponPolicy!==task.live.couponPolicy ||
        !actual.store.name || !actual.store.city || !actual.store.brand ||
        // 商家页偶尔读不到营业地址，采集器会在 missing_reasons 里明确写“只按唯一门店名核对”；
        // 这种情况下允许地址为空，但门店名必须存在且唯一（v2 要求展示实际分店，门店名已经展示）。
        (!actual.store.address && !r.observation?.details?.missing?.store_address) ||
        normalize(actual.store.city).replace(/市$/,'')!==normalize(task.live.target.supply.store.city).replace(/市$/,'') ||
        normalize(actual.store.brand)!==normalize(task.live.target.supply.store.brand) ||
        normalize(actual.item.name)!==normalize(task.live.target.supply.item.name) || itemGate(task.live.target.supply,actual) ||
        !mapping || mapping.status!=='verified' || mapping.candidate.platform!==task.platform || mapping.candidate.entry!==task.entry_point ||
        // 同城同品牌不同分店时，实际门店变了会导致解析出的目标编号变化；只要映射配置本身还是同一版本，
        // 就允许目标编号不一致，分店差异由观察结果里的实际门店名和地址体现。
        (mapping.targetId!==resolved.target.id && digest(mapping.candidate.supply)===digest(actual)) || mapping.targetRevision!==resolved.target.revision)
        throw new CollectionError('resolved_target_mismatch');
      // 按 v2 规则允许同城同品牌不同分店，必须展示实际分店；分店差异体现在 observation 的实际门店名和地址里。
      if (['success','partial'].includes(r.status)) {
        const details=r.observation?.details, store=details?.storeEvidence, item=details?.itemEvidence;
        if (!store || !item || store.page_stage!=='store' || item.page_stage!=='item' || store.id===item.id ||
            !/^[a-f0-9]{64}$/.test(store.sha256) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new CollectionError('identity_evidence_unavailable');
      }
    }
    task={...task,live:r.resolvedLive};
  }
  if (!['success','partial','unavailable','blocked','failed'].includes(r.status)) throw new CollectionError('invalid_result_status');
  if (!Number.isFinite(Date.parse(r.started_at)) || !Number.isFinite(Date.parse(r.finished_at)) || Date.parse(r.finished_at) < Date.parse(r.started_at)) throw new CollectionError('invalid_result_time');
  if (task.shelf) {
    if (r.observation || r.cleanup!=='untouched' || (!!r.shelf !== ['success','partial'].includes(r.status))) throw new CollectionError('invalid_shelf_result');
    if (r.shelf && (!r.evidence || r.shelf.evidence.id!==r.evidence.id || r.shelf.selected.length>5 ||
      (r.status==='partial')!==(r.shelf.coverage!=='direct_single' && (r.shelf.coverage==='partial' || r.shelf.selected.length<5)))) throw new CollectionError('invalid_shelf_evidence');
    return;
  }
  if (r.shelf) throw new CollectionError('unexpected_shelf_result');
  if (r.status === 'success' || r.status === 'partial') {
    if (!r.observation?.quote_valid) throw new CollectionError('missing_valid_quote');
    checkObservation(task,r.observation);
    if (r.status === 'success' && !r.observation.detail_complete) throw new CollectionError('incomplete_success');
    if (!r.evidence || r.evidence.sha256 !== r.observation.evidence_refs[0]?.sha256) throw new CollectionError('evidence_mismatch');
    const complete = task.requested_fields.every(f => f === 'checkout_payable' || r.observation!.components[f as 'delivery_fee' | 'packaging_fee'].amount_fen !== null);
    if (r.observation.detail_complete !== complete || (r.status === 'success') !== complete) throw new CollectionError('field_completion_mismatch');
  } else if (r.observation !== null) throw new CollectionError('unexpected_quote');
  if (r.status === 'unavailable' && !['sold_out','closed','out_of_range','minimum_not_met'].includes(r.availability)) throw new CollectionError('invalid_unavailable');
}
