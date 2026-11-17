import { PLATFORMS, type Platform, type QuoteReview, type Slot } from '../domain/contracts.js';
import { breakdownKeys, profileApplies, sameEligibility, itemGate, normalize, type BreakdownKey, type LiveContext } from '../domain/competition.js';
import { STORES } from '../domain/catalog.js';
import type { RunInfo } from './ports.js';

const validCheckout = (s?: Slot) => {
  const o = s?.result?.observation;
  // 早期两平台采集器未验证实际店品，历史记录保留但不能进入可比结果。
  if (o && ['meituan-0.1.0','taobao-0.1.0'].includes(o.collector_version)) return null;
  if (o && /^(meituan|taobao)-/.test(o.collector_version) &&
      (!s?.result?.resolvedLive?.mapping || !o.details?.storeEvidence || !o.details?.itemEvidence)) return null;
  return s?.review?.decision!=='disputed' && o?.quote_valid && o.price_kind==='checkout_payable' && o.value_origin===(s?.task.data_mode==='live' ? 'observed' : 'synthetic') ? o : null;
};
export function comparePair(a?: Slot, b?: Slot) {
  const no = (reason: string) => ({deltaFen:null, reason, contributions:null});
  if (a?.review?.decision==='disputed' || b?.review?.decision==='disputed') return no('有报价在人工复核中发现不符');
  const first = validCheckout(a), second = validCheckout(b);
  if (!first || !second || !a || !b) return no('缺少可用的结算应付金额');
  const x = a.result?.resolvedLive ?? a.task.live,y = b.result?.resolvedLive ?? b.task.live;
  if (!x?.mapping || !y?.mapping || first.value_origin!=='observed' || second.value_origin!=='observed' ||
      a.task.comparison_group_id!==b.task.comparison_group_id || a.task.run_id!==b.task.run_id || a.task.platform===b.task.platform ||
      x.mapping.status!=='verified' || y.mapping.status!=='verified' || x.mapping.targetRevision!==x.target.revision || y.mapping.targetRevision!==y.target.revision ||
      x.target.id!==y.target.id || x.quantity!==y.quantity || x.meal!==y.meal ||
      a.task.delivery_point_id!==b.task.delivery_point_id || x.couponPolicy!==y.couponPolicy)
    return no('门店、商品、配送地址或监测条件不同');
  const xs=x.mapping.candidate.supply, ys=y.mapping.candidate.supply;
  if (!xs.store.name || !ys.store.name || !xs.store.address || !ys.store.address || !xs.store.city || !ys.store.city ||
      !xs.store.brand || !ys.store.brand || normalize(xs.store.city).replace(/市$/,'')!==normalize(ys.store.city).replace(/市$/,'') || normalize(xs.store.brand)!==normalize(ys.store.brand) ||
      normalize(xs.item.name)!==normalize(ys.item.name) || itemGate(xs,ys)) return no('实际门店或商品规格未核实为同城同品牌同品');
  if (!profileApplies(x.profile,Date.parse(first.observed_at)) || !profileApplies(y.profile,Date.parse(second.observed_at))) return no('账号资格核对已过期或未登记有效期');
  if (!sameEligibility(x.profile.eligibility[a.task.platform],y.profile.eligibility[b.task.platform])) return no('新老客或会员权益条件不同，或资格未核实');
  if (x.profile.eligibility[a.task.platform]?.storeKey!==xs.store.key || y.profile.eligibility[b.task.platform]?.storeKey!==ys.store.key)
    return no('实际分店的账号资格尚未分别核实');
  const skew = Math.abs(Date.parse(first.observed_at)-Date.parse(second.observed_at));
  if (!Number.isFinite(skew) || skew>300_000) return no('观察时间相差超过 5 分钟，或缺少观察时间');
  const deltaFen=first.amount_fen-second.amount_fen, f=first.details, s=second.details;
  let contributions: Partial<Record<BreakdownKey,number>>|null=null;
  if (f?.reconciled && s?.reconciled && f.subtotalBasis===s.subtotalBasis) {
    const deltas=Object.fromEntries(breakdownKeys.flatMap(key=>{
      if (key==='discount' && f.subtotalBasis==='after_discount') return [];
      return [[key,(f.components[key]!.fen-s.components[key]!.fen)*(key==='discount' ? -1 : 1)]];
    })) as Partial<Record<BreakdownKey,number>>;
    if (Object.values(deltas).reduce((a,b)=>a+b,0)===deltaFen) contributions=deltas;
  }
  return {deltaFen,reason:null,contributions};
}

export function comparisonRows(slots: Slot[], now = Date.now()) {
  const groups = new Map<string,Slot[]>();
  for (const s of slots) {
    const id = s.task.comparison_group_id;
    if (!groups.has(id)) groups.set(id,[]);
    groups.get(id)!.push(s);
  }
  return [...groups].map(([id,slots])=>{
    const task = slots[0]!.task, live = task.live;
    const fixture = !live ? STORES.find(s=>s.id===task.store_id) : null;
    const basket = fixture?.baskets.find(b=>b.id===task.basket_id);
    const byPlatform = (p: Platform) => slots.find(s=>s.task.platform===p);
    const pairs = {meituan:comparePair(byPlatform('jd'),byPlatform('meituan')),taobao_instant:comparePair(byPlatform('jd'),byPlatform('taobao_instant'))};
    const amounts = PLATFORMS.map(p=>validCheckout(byPlatform(p)));
    const three = Object.values(pairs).every(x=>x.deltaFen!==null) && comparePair(byPlatform('meituan'),byPlatform('taobao_instant')).deltaFen!==null;
    const lowest = three ? Math.min(...amounts.map(o=>o!.amount_fen)) : null;
    const cells = Object.fromEntries(PLATFORMS.map((p,i)=>{
      const slot = byPlatform(p), o = amounts[i], review = slot?.review ?? null;
      const raw = slot?.result?.observation ?? null;
      const timestamp = o?.observed_at ?? slot?.result?.market?.prices[0]?.evidence.captured_at ?? null;
      const actual=slot?.result?.resolvedLive ?? slot?.task.live;
      return [p,{observation:o,rawObservation:raw,review,market:slot?.result?.market ?? null,proof:slot?.result?.evidence ?? null,sourceId:slot?.task.source_id ?? null,
        entry:slot?.task.entry_point ?? null,couponPolicy:actual?.couponPolicy??null,mapping:actual?.mapping ?? null,
        actualStore:o && slot?.result?.resolvedLive?.mapping?.status==='verified' ? slot.result.resolvedLive.mapping.candidate.supply.store : null,
        eligibility:actual?.profile.eligibility[p] ?? null,state:review?.decision==='disputed' ? 'disputed' : slot?.state==='completed' ? slot.result?.status ?? slot.state : slot?.state ?? 'not_collected',
        reason:slot?.block_reason ?? slot?.result?.error_code ?? null,observedAt:timestamp,historical:timestamp ? now-Date.parse(timestamp)>900_000 : false}];
    })) as Record<Platform,{
      observation:ReturnType<typeof validCheckout>; rawObservation:ReturnType<typeof validCheckout>; review:QuoteReview|null; market:NonNullable<Slot['result']>['market'] | null; proof:NonNullable<Slot['result']>['evidence'];
      sourceId:string|null; entry:string|null; couponPolicy:string|null; mapping:LiveContext['mapping']; actualStore:LiveContext['target']['supply']['store']|null; eligibility:LiveContext['profile']['eligibility'][Platform] | null;
      state:string; reason:string|null; observedAt:string|null; historical:boolean
    }>;
    return {id,origin:task.data_mode==='live' ? 'observed' : 'synthetic', city:live?.target.supply.store.city ?? '模拟城市',
      brand:live?.target.supply.store.brand ?? fixture?.name ?? '',store:live?.target.supply.store.name ?? fixture?.name ?? '',
      address:live?.target.supply.store.address ?? fixture?.address ?? '',item:live?.target.supply.item.name ?? basket?.name ?? '',
      spec:live?.target.supply.item.spec ?? basket?.items.map(i=>i.variant).join('、') ?? '',quantity:live?.quantity ?? null, items:basket?.items ?? null,
      meal:live?.meal ?? null,profile:live?.profile.name ?? '模拟账号', point:task.delivery_point_id, dueAt:task.due_at,cells,pairs,lowestFen:lowest};
  });
}
export type ComparisonRow = ReturnType<typeof comparisonRows>[number];
export function selectRows(rows: ComparisonRow[], query: URLSearchParams) {
  return rows.filter(row=>['city','brand','store','item','spec','profile','meal'].every(k=>!query.get(k) || row[k as keyof ComparisonRow]===query.get(k)));
}
export function summarizeBatch(slots: Slot[], rows: ComparisonRow[]) {
  const stats = {planned:slots.length,quoted:0,verified:0,disputed:0,unavailable:0,blocked:0,failed:0,pending:0,cancelled:0,
    jdMeituan:rows.filter(r=>r.pairs.meituan.deltaFen!==null).length,jdTaobao:rows.filter(r=>r.pairs.taobao_instant.deltaFen!==null).length,
    threePlatforms:rows.filter(r=>r.lowestFen!==null).length};
  for (const s of slots) {
    if (s.review?.decision==='disputed') stats.disputed++;
    else if (validCheckout(s)) { stats.quoted++; if(s.review?.decision==='verified') stats.verified++; }
    else if (s.result?.status==='unavailable') stats.unavailable++;
    else if (s.state==='source_blocked' || s.result?.status==='blocked') stats.blocked++;
    else if (['queued','running'].includes(s.state)) stats.pending++;
    else if (s.state==='cancelled') stats.cancelled++;
    else stats.failed++;
  }
  return stats;
}
export function csv(rows: ComparisonRow[], run?: RunInfo, origin?: string) {
  const cols = ['批次','数据类型','城市','品牌','实体门店','营业地址','商品','规格','数量','餐期','用户分层','收货点位','平台','入口','优惠使用方式','来源','观察时间','结算应付分','商品标价原文','参考价原文','配送费分','包装费分','预计配送','费用明细','优惠规则与实抵','状态','人工核对','核对备注','缺失或失败原因','账号资格','映射版本','证据','京东减美团分','京东减淘宝闪购分','不可比原因'];
  const quote = (input: unknown) => {
    const s = String(input ?? '');
    return '"' + (/^[\s]*[=+\-@\t\r]/.test(s) && typeof input!=='number' ? "'" : '') + s.replaceAll('"','""') + '"';
  };
  const lines = rows.flatMap(r=>PLATFORMS.map(p=>{
    const c = r.cells[p], o = c.observation, d = o?.details;
    const proof=o?.evidence_refs[0] ?? c.proof ?? c.market?.prices[0]?.evidence;
    const link=proof?.screenshot && origin ? new URL(proof.screenshot,origin).href : proof?.screenshot;
    return [run?.id,r.origin,r.city,r.brand,c.actualStore?.name ?? '',c.actualStore?.address ?? '',r.item,r.spec,r.quantity,r.meal,r.profile,r.point,p,c.entry,c.couponPolicy,c.sourceId,c.observedAt,
      o?.amount_fen,c.market?.prices.find(v=>v.kind==='display_current')?.raw,c.market?.prices.find(v=>v.kind==='display_reference')?.raw,
      o?.components.delivery_fee.amount_fen,o?.components.packaging_fee.amount_fen,d?.eta?.raw,d ? JSON.stringify(d.components) : null,
      d?.coupons ? JSON.stringify(d.coupons) : null,c.state,c.review?.decision,c.review?.note,[c.reason,...Object.values(d?.missing ?? {})].filter(Boolean).join('；'),
      c.eligibility ? JSON.stringify(c.eligibility) : null,c.mapping?.id,link,
      r.pairs.meituan.deltaFen,r.pairs.taobao_instant.deltaFen,[r.pairs.meituan.reason,r.pairs.taobao_instant.reason].filter(Boolean).join('；')];
  }));
  return '\uFEFF'+[cols,...lines].map(r=>r.map(quote).join(',')).join('\r\n');
}
