import type { ComparisonRow } from '../application/comparison.js';
import type { Mapping, Meal, OrderImport, Plan, Profile, Target } from '../domain/competition.js';
import type { Evidence, Platform, QuoteReview } from '../domain/contracts.js';
import type { RunInfo } from '../application/ports.js';
import type { JdSavedStore } from '../domain/jd-shelf.js';

export type Page = 'compare'|'settings'|'records';
export interface Workspace {
  ueWorkspacePath?:string;
  platforms: {id:Platform;name:string;entry:string|null;defaultEntry:string;status:string;appVersion:string|null;problem?:string|null;
    shelfReady?:boolean; setup?: {accountName:string;deliveryName:string}}[];
  model: {configured:boolean;model:string|null;problem?:string|null};
  sourceConfigurationError?:string|null;
  targets: Target[]; profiles: Profile[]; jdStores?:JdSavedStore[]; plans: Plan[]; mappings: Mapping[]; meals: Record<Meal,string>;
}
interface Stats {planned:number;quoted:number;verified:number;disputed:number;unavailable:number;blocked:number;failed:number;pending:number;cancelled:number;jdMeituan:number;jdTaobao:number;threePlatforms:number}
export interface Batch {
  rows: ComparisonRow[]; run: RunInfo|null; runs:RunInfo[]; stats:Stats;
  facets: Pick<ComparisonRow,'city'|'brand'|'store'|'item'|'spec'|'profile'|'meal'>[];
}
export interface Records {
  orders: {record:OrderImport}[]; run:RunInfo|null;
  runs?: Pick<RunInfo,'id'|'label'|'created_at'>[];
  slots:{platform:Platform;store:string;item:string;dueAt:string;state:string;status:string|null;attempts:number;error:string|null;phase:string|null;proof:Evidence|null;review:QuoteReview|null}[];
  trial:{name:string;expected:number;stats:Stats;manualMinutes:number|null;executionMinutes:number;modelCostPerQuote:number|null}[];
  modelCalls:{operation:string;ok:boolean;model:string;ms:number;inputTokens:number|null;outputTokens:number|null}[];
}
export const pages:Record<Page,string> = {compare:'三平台对比',settings:'监测设置',records:'数据记录'};
export const mealNames:Record<Meal,string> = {lunch:'午餐',dinner:'晚餐',night:'夜宵'};
const states:Record<string,string> = {
  not_collected:'未采集',queued:'待采集',running:'采集中',success:'已取得报价',partial:'部分费用未取得',
  disputed:'人工复核不符',unavailable:'当前无报价',blocked:'受限',failed:'采集失败',source_blocked:'来源或设备已暂停',cancelled:'已取消',
  pending:'待核实',invalid_configuration:'配置有误',ready_for_defined_scope:'已登记使用范围',restricted:'入口受限',interrupted:'运行中断',window_missed:'错过采集时间'
};
const reasons:Record<string,string> = {
  coupon_claim_required:'京东显示领券结算；当前任务未允许领券，已停止并恢复本次加购',checkout_control_missing:'未找到已核实的结算按钮',jd_single_item_search_timeout:'指定商品查找超时，未换成其他商品',variant_quantity_mismatch:'当前规格的默认数量不是一份，已停止加购',variant_text_unavailable:'指定商品详情的规格文字仍不可读取，未加购',
  live_source_not_ready:'采集入口未获准或使用范围已到期',mapping_unverified:'店品对应关系未确认',mapping_changed:'店品资料已变化，请重新确认并采集',
  profile_unverified:'测试账号或配送地址未核实',model_not_configured:'模型未配置',device_unavailable:'未连接指定的测试手机',
  adb_unavailable:'本机未找到 ADB',adb_failed:'ADB 无法读取设备列表',device_unauthorized:'请在手机上确认 USB 调试授权',app_version_changed:'应用版本变化，需复核采集配置',source_changed:'来源配置已变更',
  device_screen_locked:'测试手机已锁屏，解锁后再运行',device_lock_state_unknown:'无法确认测试手机是否已解锁',device_wake_failed:'测试手机未能唤醒',
  screen_changed:'页面与已核实的操作配置不符',entry_mismatch:'当前页面不是已登记的应用',foreign_window:'当前前台是其他应用或系统窗口',screen_unreadable:'无法读取手机页面',
  page_not_ready:'等待页面就绪超时，已停止操作',control_missing:'页面缺少已核实的控件',
  checkout_control_moved:'结算按钮位置变化，已停止操作',page_changed_during_capture:'截图时页面发生变化，证据未保存',
  evidence_capture_failed:'证据截图无法生成',evidence_unavailable:'没有可保存的证据节点',blank_screen:'截图为空白',screen_geometry_changed:'截图尺寸与手机页面比例不一致',
  access_restricted:'平台限制了当前访问',rate_limited:'平台限制了请求频率',quantity_control_unverified:'尚未核对增加数量的控件',
  variant_controls_unverified:'尚未核对选项或套餐组成',minimum_not_met:'未达起送金额',sold_out:'已售罄',closed:'门店休息',
  out_of_range:'超出配送范围',captcha_required:'页面要求安全验证',cart_not_owned:'购物车已有其他商品',
  schema_changed:'页面字段变化',model_invalid_output:'模型输出无法核验',amount_evidence_mismatch:'结算金额与截图读取不一致',
  model_timeout_or_cancelled:'模型请求超时或已取消',model_location_failed:'模型未能定位指定控件',
  model_location_mismatch:'模型定位与已核实的控件不一致',network_error:'网络故障',checkout_amount_missing:'未看到明确的结算应付金额',
  amount_breakdown_mismatch:'费用明细与结算应付无法核对',not_visible:'页面未显示',model_http_401:'模型密钥未通过验证',model_http_429:'模型接口限流',
  jd_store_mismatch:'门店名称或营业地址与填写的信息不一致',jd_store_unverified:'未能核对完整分店名和营业地址',
  jd_store_not_found:'没有找到符合条件的分店',jd_item_mismatch:'商品名称、类型或规格与榜单记录不一致',
  menu_price_missing:'未看到可核对的商品现价',menu_amount_evidence_mismatch:'商品现价与页面读数不一致',
  process_interrupted:'上次采集中断，购物车状态待核对',cleanup_failed:'购物车状态未确认恢复',window_missed:'错过采集时间',
  jd_request_conflict:'这次请求已用另一组门店信息提交，请重新填写后再试',invalid_shelf_result:'榜单证据或商品顺序无法核对',
  jd_saved_store_missing:'找不到这家负责门店，请刷新后重新选择',jd_saved_store_ambiguous:'找到同名分店，接入人员需核对门店证据后才能采集',
  jd_pilot_store_scope:'这台手机当前只登记了指定试点门店',
  jd_search_layout_changed:'京东搜索页布局变化，门店入口需要重新核对',
  jd_search_opened_product:'搜索结果打开了商品详情，已在加购前停止',
  jd_merchant_tab_obstructed:'商家标签被商品弹层遮挡，已在加购前停止',
  jd_single_item_not_found:'在已检查的菜单范围内未找到该单品和规格',ambiguous_control:'页面上有多个相同控件，无法确认操作位置',
  android_collection_failed:'手机操作未完成，请查看失败步骤',collector_crashed:'采集程序运行中断',
  run_in_progress:'已有一轮模拟采集在运行，请等本轮结束。'
};
export const h = (v:unknown) => String(v ?? '').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]!));
export const yuan = (fen:number|null|undefined) => fen == null ? '未取得' : '¥'+(fen/100).toFixed(2);
export const time = (at:string|null|undefined) => !at ? '未取得' : new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(at));
export const reason = (v:string|null) => {
  if (!v) return '';
  const cause=v.replace(/^scope_paused_after_/,'');
  if(/^model_http_\d+$/.test(cause))return '模型服务返回错误（HTTP '+cause.slice(11)+'）';
  return reasons[cause] ?? (cause!==v ? '前次采集需人工核对' : v);
};
export const state = (v:string) => states[v] ?? v;
export const customer = {new:'新客',existing:'老客',unknown:'待核实'};
export const label = (ws:Workspace,p:Platform) => ws.platforms.find(x=>x.id===p)?.name ?? p;
export const supplyLabel = (t:Target) => t.supply.store.name+' / '+t.supply.item.name+' '+t.supply.item.spec;
export const button = (action:string,text:string,primary=false,extra='') => `<button type="button" class="${primary?'primary':'btn'}" data-action="${action}" ${extra}>${h(text)}</button>`;
export const idAttr = (id:string) => `data-id="${h(id)}"`;
export const field = (name:string,input:string,cls='') => `<label class="field ${cls}"><span>${h(name)}</span>${input}</label>`;
export const input = (name:string,value='',extra='') => `<input name="${name}" value="${h(value)}" ${extra}>`;
export const select = (name:string,rows:[string,string][],value='') => `<select name="${name}">${rows.map(([v,t])=>`<option value="${h(v)}" ${v===value?'selected':''}>${h(t)}</option>`).join('')}</select>`;
export const panel = (body:string) => '<section class="panel"><div class="panel-body">'+body+'</div></section>';
export const heading = (title:string,desc='',action='') => `<div class="heading"><div><h1>${h(title)}</h1>${desc?`<p class="muted">${h(desc)}</p>`:''}</div>${action}</div>`;
export const tabs = (active:string,rows:[string,string][],action='section') => '<div class="tabs">'+rows.map(([id,t])=>`<button data-action="${action}" ${idAttr(id)} aria-pressed="${id===active}">${h(t)}</button>`).join('')+'</div>';
export const empty = (title:string,body:string,actions='') => `<section class="panel empty"><h2>${h(title)}</h2><p>${h(body)}</p>${actions && `<div class="actions">${actions}</div>`}</section>`;
export const definitions = (items:[string,unknown][]) => '<dl>'+items.map(([a,b])=>`<dt>${h(a)}</dt><dd>${h(b ?? '未取得')}</dd>`).join('')+'</dl>';
export const proofPath = (e?:Evidence|null) => e && /^\/api\/evidence\/[a-f0-9-]{36}\.png$/.test(e.screenshot) ? e.screenshot : '';
export const proofLink = (e?:Evidence|null,text='查看截图') => proofPath(e) ? `<a href="${proofPath(e)}" target="_blank" rel="noopener">${h(text)}</a>` : '';

// 实时采集进度条：轮询 /api/market/live-progress，展示采集脚本当前走到第几个节点。
const LIVE_NODES = ['进入首页','打开外卖频道','搜索品牌名','进入门店结果页','进入店铺','定位爆品','加购结算','采数完成'];

export function liveProgressBar():string {
  const nodes = LIVE_NODES.map((label,i)=>`<li data-live-node="${i}"><span class="dot">${i+1}</span><span class="label">${h(label)}</span></li>`).join('');
  return `<div class="collect-progress" id="live-progress" data-live-progress role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
    <div class="collect-progress-head"><strong data-live-title>采集进度</strong><span data-live-status class="muted">待开始</span></div>
    <div class="collect-progress-track"><div class="collect-progress-fill" data-live-fill style="width:0%"></div></div>
    <ol class="collect-progress-nodes">${nodes}</ol>
    <p class="collect-progress-text" data-live-text>当前没有正在进行的采集。</p>
  </div>`;
}

export function comparison(ws:Workspace,batch:Batch|undefined,mode:string,query:URLSearchParams,menu:boolean,advanced:boolean) {
  const demo=mode==='synthetic', platforms=demo ? ws.platforms.filter(p=>p.id!=='jd') : ws.platforms;
  const showDifference=!demo && !menu;
  const title = heading('三平台对比',batch?.run ? batch.run.label+' · '+time(batch.run.created_at) : '',
    batch?.rows.length ? `<a class="btn" href="/api/comparisons.csv?${h(query.toString())}" download>导出本批对比</a>` : '');
  const switcher=tabs(mode,[['live','实际数据'],['synthetic','模拟演练']],'mode');
  const sample=demo ? '<p class="notice">使用内置的美团和淘宝闪购测试页面演练，无需京东资料、手机或平台账号。报价、店铺和截图均为演练数据。</p>'+
    (batch?.stats.pending ? button('fixture-run','正在模拟采集…',true,'disabled') : button('fixture-run','运行模拟采集',true)) : '';
  if (!batch) return liveProgressBar()+title+switcher+sample+panel('<p class="muted">正在读取监测数据…</p>');
  const dims = [['city','城市'],['brand','品牌'],['store','门店'],['item','商品'],['spec','规格'],['profile','配送与账号'],['meal','用餐时段']] as const;
  const filter = batch.runs.length ? panel(`<div class="filters">
    ${field('监测批次',select('run',[['','最近一次'],...batch.runs.map(r=>[r.id,r.label+' · '+time(r.created_at)] as [string,string])],query.get('run') ?? ''),'wide')}
    ${field('日期',input('date',query.get('date') ?? '','type="date"'))}
    ${field('价格类型',select('priceMode',[['checkout','结算应付'],['menu','商品标价']],menu?'menu':'checkout'))}
    </div><div class="filter-toggle">${button('advanced-filters',advanced?'收起筛选条件':'按门店、商品和用户条件筛选')}</div>
    ${advanced ? `<div class="filters additional">${dims.filter(([id])=>mode==='live' || !['meal','profile'].includes(id)).map(([id,name])=>{
      const rows = batch.facets.filter(r=>dims.every(([k])=>k===id || !query.get(k) || r[k]===query.get(k)));
      const values = id==='meal' ? Object.keys(mealNames) : [...new Set([...rows.map(r=>r[id]),query.get(id)].filter(Boolean))] as string[];
      return field(name,select(id,[['','全部'],...values.map(v=>[v,id==='meal'?mealNames[v as Meal]:v] as [string,string])],query.get(id) ?? ''));
    }).join('')}</div>` : ''}${query.size>1?'<div class="group">'+button('clear-filter','清除筛选')+'</div>':''}`) : '';
  if (!batch.rows.length) return title+switcher+sample+filter+empty(batch.runs.length?'没有符合条件的记录':'还没有监测记录',
    batch.runs.length?'可以调整日期、批次或其他筛选条件。':mode==='live'?'填写一家京东外卖门店，就可以开始采集热销单品价格。也可以用内置数据练习查看报价。':'运行模拟采集后，可以查看结算金额和截图。',
    mode==='live' && !batch.runs.length ? button('jd-nav','京东采集',true)+button('open-demo','先试用（无需京东订单）')+button('import-nav','导入京东资料'):'');
  const cell=(r:ComparisonRow,p:Platform,i:number)=>{
    const c=r.cells[p], o=c.observation;
    const value=menu ? c.market?.prices.find(v=>v.kind==='display_current')?.raw : o ? yuan(o.amount_fen):null;
    const note=reason(c.reason) || (c.observedAt ? (c.historical?'历史 · ':'')+time(c.observedAt) : '');
    return `<td class="platform-cell" data-label="${h(label(ws,p))}"><button class="link ${value?'money':''}" data-action="quote" data-index="${i}" data-platform="${p}">${h(value ?? (menu && o?'未取得标价':state(c.state)))}</button>
      ${!menu && o?.details?.eta?`<small class="sub">${h(o.details.eta.raw)}</small>`:''}${note?`<small class="sub">${h(note)}</small>`:''}</td>`;
  };
  const delta=(v:number|null)=>v===null?'—':`<span class="delta ${v>0?'hot':''}">${v>0?'+':v<0?'−':''}${yuan(Math.abs(v))}</span>`;
  return title+switcher+sample+filter+`<div class="summary"><span>本批计划 <b>${batch.stats.planned}</b> 次</span><span>已取得结算金额 <b>${batch.stats.quoted}</b> 条</span>
    ${mode==='live'?`<span>京东与美团可比 <b>${batch.stats.jdMeituan}</b> 组</span><span>京东与淘宝闪购可比 <b>${batch.stats.jdTaobao}</b> 组</span>`:''}
    ${batch.stats.disputed?`<span>人工复核不符 <b>${batch.stats.disputed}</b> 条</span>`:''}
    ${batch.stats.pending?`<span>待完成 <b>${batch.stats.pending}</b> 次</span>`:''}</div>
    <section class="panel table-wrap" aria-label="平台报价"><table class="compare${demo?' fixture-compare':''}"><thead><tr><th scope="col">门店与商品</th>
    ${platforms.map(p=>`<th scope="col">${h(p.name)}</th>`).join('')}${showDifference?'<th scope="col">京东较美团</th><th scope="col">京东较淘宝闪购</th>':''}
    <th scope="col">观察条件</th></tr></thead><tbody>${batch.rows.map((r,i)=>`<tr><td><strong>${h(r.item)}</strong><small class="sub spec">${h(r.spec)}${r.quantity?' · '+r.quantity+' 份':''}</small><small class="sub">${h(r.store)}</small></td>
    ${platforms.map(p=>cell(r,p.id,i)).join('')}${showDifference?`<td class="pair-cell" data-label="京东较美团" title="${h(r.pairs.meituan.reason)}">${delta(r.pairs.meituan.deltaFen)}</td><td class="pair-cell" data-label="京东较淘宝闪购" title="${h(r.pairs.taobao_instant.reason)}">${delta(r.pairs.taobao_instant.deltaFen)}</td>`:''}
    <td class="condition-cell">${r.meal?h(mealNames[r.meal])+' · ':''}${h(r.profile)}<small class="sub">计划 ${h(time(r.dueAt))}</small>${r.lowestFen!==null?`<small class="sub">三平台最低 ${yuan(r.lowestFen)}</small>`:''}</td></tr>`).join('')}</tbody></table></section>`;
}
export function quoteDetails(row:ComparisonRow,p:Platform) {
  const c=row.cells[p], o=c.observation ?? c.rawObservation, d=o?.details, e=c.eligibility, proof=o?.evidence_refs[0] ?? c.proof;
  const amounts = {subtotal:'商品小计',packaging:'包装费',delivery:'配送费',other:'其他费用',discount:'实际优惠'} as const;
  const explain = (platform:'meituan'|'taobao_instant',name:string) => {
    const pair = row.pairs[platform];
    const items = pair.contributions ? Object.entries(pair.contributions).filter(([,n])=>n!==0)
      .map(([key,n])=>amounts[key as keyof typeof amounts]+' '+(n>0?'+':'−')+yuan(Math.abs(n))) : [];
    return '<small>京东与'+name+'：'+h(pair.reason ?? (items.length ? items.join('，') : '同条件可比'))+'</small>';
  };
  return `<h3>${h(row.store)}</h3>${definitions([
    ['来源入口',row.origin==='synthetic'?'模拟演练':c.entry],['营业地址',row.address],
    ['商品与数量',o?.basket_items.map(i=>i.name+' '+i.variant+' × '+i.quantity).join('、') ?? row.spec],
    ['用户条件',e ? [customer[e.platformCustomer],'门店'+customer[e.storeCustomer],e.memberProduct,e.memberTier,e.memberSegment,...e.benefits].filter(Boolean).join(' · ') : row.profile],
    ['配送地址简称',row.point],['观察时间',time(c.observedAt)],['结算应付',o ? yuan(o.amount_fen) : reason(c.reason)||state(c.state)],
    ['预计配送',d?.eta?.raw],['商品标价',c.market?.prices.find(x=>x.kind==='display_current')?.raw],['划线参考价',c.market?.prices.find(x=>x.kind==='display_reference')?.raw],
    ...Object.entries(amounts).map(([k,n])=>[n,d?.components[k as keyof typeof amounts] ? yuan(d.components[k as keyof typeof amounts]?.fen) :
      !d && k==='packaging' && o ? yuan(o.components.packaging_fee.amount_fen) : !d && k==='delivery' && o ? yuan(o.components.delivery_fee.amount_fen) : d?.missing[k] ?? '未取得'] as [string,unknown])
  ])}
  ${c.review?`<p class="${c.review.decision==='disputed'?'notice':'muted'}">${c.review.decision==='disputed'?'复核发现不符，已从价差统计中移出。':'已人工核对一致。'} ${h(c.review.note)}</p>`:''}
  ${d ? `<p class="muted">${d.reconciled?'费用明细与结算应付一致。':'费用明细或计算口径未完全核实。'}</p>`:''}
  ${d?.coupons?.map(c=>`<div class="row"><strong>${h(c.label)}</strong>${definitions([['是否可用',c.eligible===null?'未取得':c.eligible?'可用':'不可用'],
    ['抵扣金额',yuan(c.applied?.fen)],['规则',c.rule],['门槛与基数',[c.threshold,c.basis].filter(Boolean).join(' · ')||null],['适用范围',c.scope],['时段',c.validTime],['会员条件',c.memberCondition],['叠加规则',c.stacking]])}</div>`).join('') ?? ''}
  ${c.mapping ? `<p class="muted">匹配版本 ${h(c.mapping.id)} · ${h(c.mapping.candidate.reference)}</p>`:''}
  ${row.origin==='observed' ? `<div class="reading">${explain('meituan','美团')}${explain('taobao_instant','淘宝闪购')}</div>`:''}
  <div class="actions group">${proofLink(d?.storeEvidence,'门店证据')}${proofLink(d?.itemEvidence,'规格证据')}${proofLink(d?.contextEvidence,'购物车证据')}${proofLink(proof,'打开原图')}</div>
  ${proofPath(proof) ? `<img class="proof" alt="采集页面证据" src="${proofPath(proof)}">`:''}
  ${o?.value_origin==='observed'?`<details class="group"><summary>人工复核报价</summary>
    <form data-form="quote-review" ${idAttr(o.observation_id)}><div class="fields">
      ${field('核对结果',select('decision',[['verified','与证据一致'],['disputed','发现不符']],c.review?.decision ?? 'verified'))}
      ${field('核对用时（分钟，可选）',input('minutes','','type="number" min="0" max="480"'))}
      ${field('差异说明',input('note',c.review?.note ?? '','maxlength="250"'),'full')}
    </div><button class="primary">保存复核结果</button></form></details>`:''}`;
}
