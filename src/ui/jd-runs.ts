import type { RunInfo } from '../application/ports.js';
import type { MarketRead } from '../domain/competition.js';
import type { AttemptStep, Evidence, Observation, Platform, TraceStep } from '../domain/contracts.js';
import type { JdShelfItem, JdShelfResult } from '../domain/jd-shelf.js';
import { type Workspace, button, definitions, field, h, input, label, panel, proofLink, reason, state, time, yuan } from './presentation.js';

interface CollectionAttempt {
  id:string; number:number; startedAt:string; status:string|null; error:string|null; steps:AttemptStep[]; legacyTrace?:TraceStep[]; executionMs?:number|null;
}
interface CollectionSlot {
  cleanup?:'restored'|'untouched'|'quarantined'|null; quoteReadyAt?:string|null; quoteMs?:number|null;
  timings?:{treeReads:number;treeMs:number;screenshots:number;screenshotMs:number;waitMs:number;retries:number;cleanupMs:number}|null;
  id:string; kind:'shelf'|'quote'; item:string|null; spec:string|null; itemKey?:string|null;
  platform:Platform; state:string; status:string|null; error:string|null; menuPriceReason?:string|null;
  menuPrices:MarketRead['prices']; observation:Observation|null; proof:Evidence|null; attempts:CollectionAttempt[];
  availability?:string|null;
  context?:{couponPolicy?:string;couponConsent?:string|null;entry:string|null;store:string;address:string|null;user:string|null;delivery:string|null;quantity:number;options:string[]}|null;
}
export interface CollectionRun {
  run:Pick<RunInfo,'id'|'label'|'created_at'>; state:'queued'|'running'|'completed'|'interrupted';
  shelf:JdShelfResult|null; slots:CollectionSlot[]; elapsedMs?:number|null; queueMs?:number|null; executionMs?:number|null;
}

export function jdStartForm(_ws:Workspace,_submitting:boolean,_selectedId:string) {
  return panel(`<h2>指定单品采集</h2><p>在 UE 工作台保存包销品清单，再选择门店、商品规格和已登记的账号条件，采一份报价。</p><div class="actions group"><a class="primary btn" href="/ue?collection=1">打开采集工作台</a></div><p class="muted group">历史销量榜和原有执行记录继续保留。本版按指定商品采集。</p>`);
}
const coverageLabels={complete:'全店销量 Top 5',sales_order:'已核实店内销量排序 · Top 5',partial:'已扫描范围内 Top 5',direct_single:'单品试采'};
const kindLabels={single:'单品',set:'组合套餐',unknown:'类型待核对'};
const runStates={queued:'等待采集',running:'正在采集',completed:'已结束',interrupted:'运行中断'};
const stepStates:Record<string,string>={started:'开始',succeeded:'成功',skipped:'已跳过',blocked:'受限',failed:'失败',interrupted:'中断'};
const phases:Record<string,string>={
  preflight:'核对采集条件',page_context:'检查当前应用',cart_surface:'检查加购后的页面',source_check:'核对采集入口与设备',connect:'连接手机',device_connect:'连接手机',launch:'打开京东外卖',
  brand_search:'搜索品牌',brand_model_match:'识别品牌候选',store_match:'核对分店',store_verify:'核对分店',store_candidate:'检查候选分店',shelf_scan:'扫描菜单',spec_scan:'读取单品规格',
  hot_rank:'按销量排名',direct_single:'核对一款单品',item_match:'匹配单品',sku_match:'匹配单品',menu_price:'读取商品现价',cart:'加购一份',
    checkout:'读取结算页',store_address_open:'打开营业地址核对页',item_open_retry:'重新打开同一商品',coupon_checkout:'经授权进入领券结算',model_verify:'模型核对金额',menu_model:'模型核对商品现价',cart_add_intent:'核对本次加购',restore:'恢复购物车',worker:'执行采集'
};
const jdReasons:Record<string,string>={
  target_app_not_foreground:'京东已不在前台，已停止输入',foreground_state_unknown:'暂时无法确认前台应用，已停止输入',entry_mismatch:'当前页面不属于已登记的京东入口',
  current_store_title_with_recent_address_evidence:'当前完整店名与近期地址证据一致',verified_public_address:'已核对门店公开营业地址',
  combo:'组合套餐',not_single:'组合套餐',kind_unknown:'无法确认是单品',spec_unknown:'规格待核对',spec_missing:'规格待核对',
  sales_missing:'页面未显示销量',sales_unreadable:'页面销量无法读成数值',sales_zero:'页面显示销量为 0',sales_window_mismatch:'销量统计周期不同',evidence_missing:'缺少页面证据',
  sales_order_top5:'已核实店内销量排序并找到 5 个合格单品',shelf_end:'已到达菜单底部',
  scroll_limit:'已到本次滚动上限',scan_timeout:'已到本次扫描时限',shelf_repeat:'菜单没有继续加载',
  page_not_ready:'等待下一屏菜单超时',screen_unreadable:'手机控件暂时无法读取',spec_unreadable:'未能同时核对商品名和单份规格',spec_not_displayed:'商品详情未显示规格',
  unreadable_cards:'部分商品无法读取',shelf_coverage_gap:'菜单滚动后有一段未核实',jd_shelf_not_configured:'京东菜单控件尚未完成校准',
  pilot_single_product:'本轮只验收一款已校准单品',pilot_items_found:'本轮已找到配置的单品',
  store_identity_mismatch:'分店名称、城市或营业地址无法核对为一致',store_identity_incomplete:'页面未显示足以确认分店的信息',
  store_candidate_changed:'候选分店已从搜索结果中消失',brand_candidates_missing:'搜索结果中没有找到该品牌的候选分店',
  store_identity_changed:'本次打开的分店与榜单记录不一致',package_excluded:'组合套餐',product_kind_unknown:'无法确认是单品',
  product_spec_unknown:'规格或可选项待核对',duplicate_product_identity:'页面出现无法区分的同款记录',
  menu_price_not_visible:'页面未显示商品现价',menu_price_not_exact:'页面只显示起价、区间或无法核实的金额',
  menu_amount_evidence_mismatch:'页面和模型读取的现价不一致',menu_model_read_failed:'模型未能读出商品现价',
  shelf_unreadable:'菜单数据无法读取',shelf_no_rankable_items:'没有可以按销量排名的单品',
  pilot_direct_single:'只采价一款已核对的商品',jd_direct_single_unverified:'未找到可核对规格的试采商品'
};
const explain = (value:string|null|undefined) => value ? jdReasons[value] ?? reason(value) : '';
const duration = (ms:number|null) => ms===null?'':ms<1000?`${ms} 毫秒`:`${(ms/1000).toFixed(1)} 秒`;
const evidenceLink = (id:string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)
  ? `<a href="/api/evidence/${id}.png" target="_blank" rel="noopener">查看截图</a>` : '';
const dataLabels:Record<string,string>={
  rootPackage:'页面所属应用',ownNodeCount:'京东页面控件数',reason:'原因',target:'目标控件',relocated:'已重新定位',entryActions:'本次入口步骤',entryState:'入口页面',skipped:'已跳过',
  itemDetail:'仍在商品详情页',selectedSpec:'规格文字可读',cartVisible:'购物车入口可见',detailDismiss:'详情关闭按钮可见',
  pageState:'页面状态',pageMapVersion:'页面地图版本',identityAgeMs:'门店地址证据间隔（毫秒）',policy:'优惠使用方式',reference:'依据',action:'实际动作',verifiedFields:'已核对字段数',
  query:'搜索词',candidate:'候选分店',candidateCount:'候选数量',candidates:'候选分店',store:'分店',city:'城市',method:'核对方式',rejectedCount:'已排除分店数',
  coverage:'榜单范围',scannedCount:'已扫商品数',pageCount:'已扫页面数',stopReason:'扫描停止原因',unreadableCount:'无法读取的商品数',
  selectedCount:'入选数',items:'商品',rawName:'页面商品名',spec:'规格',sales:'销量',salesRaw:'页面销量原文',position:'菜单位置',excludedReason:'排除原因',
  menuPriceReason:'现价缺失原因',structuralFen:'页面结构读数',modelFen:'模型读数',checkoutFen:'结算应付',item:'商品名',
  quantity:'数量',cleanup:'购物车恢复',availability:'可售状态'
};

function salesText(sales:JdShelfItem['sales'],raw?:string|null) {
  if (!sales) return raw ? `页面显示 ${raw} · 销量未核实` : '销量未显示或无法读取';
  const window=sales.window==='month'?'按月':'统计周期未标注';
  return `${sales.raw} · ${window}${sales.qualifier==='lower_bound'?` · 至少 ${sales.value.toLocaleString('zh-CN')}`:''}`;
}

function stepData(data:Record<string,unknown>) {
  const display = (key:string,value:unknown):unknown => {
    if(key==='structuralFen' || key==='modelFen' || key==='checkoutFen')return typeof value==='number'?yuan(value):null;
    if(key==='coverage' && typeof value==='string')return coverageLabels[value as keyof typeof coverageLabels] ?? value;
    if(key==='cleanup' && typeof value==='string')return ({restored:'已恢复',untouched:'未变更',quarantined:'需人工核对'} as Record<string,string>)[value] ?? value;
    if(typeof value==='string')return explain(value);
    if(Array.isArray(value))return value.map(v=>display(key,v));
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[dataLabels[k] ?? k,display(k,v)]));
    return value;
  };
  return definitions(Object.entries(data).map(([key,value])=>{
    const result=display(key,value);
    return [dataLabels[key] ?? key, typeof result==='object' && result!==null?JSON.stringify(result,null,2):result];
  }));
}

function priceText(price:MarketRead['prices'][number]|undefined) {
  if (!price) return '未取得';
  if (price.qualifier==='exact' && price.fen!==null) return yuan(price.fen);
  return price.qualifier==='from' ? '起价 ' + price.raw : price.qualifier==='range' ? '区间 ' + price.raw : '未核实';
}

function slotState(slot:CollectionSlot) {
  if (slot.state==='queued' || slot.state==='running') return state(slot.state);
  if (slot.kind==='shelf' && (slot.status==='success' || slot.status==='partial')) return '已扫描菜单';
  return state(slot.status ?? slot.state);
}

function priceDetails(slot:CollectionSlot) {
  const o=slot.observation, d=o?.details, menu=slot.menuPrices.find(p=>p.kind==='display_current'), ref=slot.menuPrices.find(p=>p.kind==='display_reference');
  const proof=o?.evidence_refs[0] ?? slot.proof, context=slot.context;
  const configuredItem=context && slot.item ? [slot.item,slot.spec,...context.options].filter(Boolean).join(' · ')+' × '+context.quantity : null;
  const availability=slot.availability && slot.availability!=='unknown' ? slot.availability==='available' ? '可售' : explain(slot.availability) : null;
  return definitions([
    ['来源入口',context?.entry ?? o?.entry_point],['营业地址',context?.address],['商品与数量',configuredItem],
    ['用户条件',context?.user],['配送地址简称',context?.delivery],['观察时间',time(o?.observed_at ?? menu?.evidence.captured_at ?? proof?.captured_at)],
    ...(context?.couponPolicy==='claim_on_checkout'?[['优惠使用方式','本机试采允许领券结算'],['本次授权记录',context.couponConsent]] as [string,unknown][]:[]),
    ['可售状态',availability],['结算应付',o?.quote_valid ? yuan(o.amount_fen) : '未取得'],['预计配送',d?.eta?.raw],
    ['商品标价',menu ? priceText(menu) : '未取得'],
    ['划线参考价',priceText(ref)],
    ...([['subtotal','商品小计'],['packaging','包装费'],['delivery','配送费'],['other','其他费用'],['discount','实际优惠']] as const).map(([key,name])=>{
      const fallback=key==='packaging'?o?.components.packaging_fee.amount_fen:key==='delivery'?o?.components.delivery_fee.amount_fen:null;
      const amount=d ? d.components[key]?.fen : fallback;
      return [name,yuan(amount)] as [string,unknown];
    }),
    ...(slot.menuPriceReason ? [['商品标价说明',explain(slot.menuPriceReason)] as [string,unknown]] : []),
    ...(slot.error ? [['采集结果说明',explain(slot.error)] as [string,unknown]] : [])
  ])+(d?.coupons?.length ? `<div class="reading"><h3>优惠条件</h3>${d.coupons.map(c=>`<div><strong>${h(c.label)}</strong>
    ${definitions([['是否可用',c.eligible===null?'未取得':c.eligible?'可用':'不可用'],['抵扣金额',yuan(c.applied?.fen)],['优惠规则',c.rule],['门槛和计算依据',[c.threshold,c.basis].filter(Boolean).join(' · ')||null],
      ['适用范围',c.scope],['有效时间',c.validTime],['会员条件',c.memberCondition],['叠加规则',c.stacking]])}</div>`).join('')}</div>`:'')+
    `<div class="actions group">${proofLink(menu?.evidence,'商品页截图')}${proofLink(proof,'结算或采集截图')}${d?.supplementaryEvidence?.map((e,i)=>proofLink(e,`费用明细截图 ${i+1}`)).join('')??''}</div>`+
    (d?.fieldResults?`<details class="group"><summary>逐字段核对结果与缺失原因</summary><div class="table-wrap"><table><thead><tr><th>指标</th><th>页面文字</th><th>模型读数</th><th>核对结果</th></tr></thead><tbody>${Object.entries(d.fieldResults).map(([k,v])=>`<tr><td>${h(({payable:'结算应付',subtotal:'商品小计',packaging:'包装费',delivery:'配送费',other:'其他费用',discount:'实际优惠',eta:'预计配送',deliveryReference:'原配送费',packagingReference:'原包装费'} as Record<string,string>)[k]??k)}</td><td>${h(v.raw??'未取得')}</td><td>${h(v.modelRaw??'未取得')}</td><td>${h(v.status==='verified'?'已核对':v.reason??'待复核')}</td></tr>`).join('')}</tbody></table></div>${definitions(Object.entries(d.missing).map(([key,value])=>[({payable:'结算应付',subtotal:'商品小计',packaging:'包装费',delivery:'配送费',other:'其他费用',discount:'实际优惠',eta:'预计配送',reconciliation:'费用加减核对',coupons:'优惠明细'} as Record<string,string>)[key]??key,value]))}</details>`:'')+
    (slot.timings?definitions([['页面读取',`${slot.timings.treeReads} 次 · ${duration(slot.timings.treeMs)}`],['截图',`${slot.timings.screenshots} 次 · ${duration(slot.timings.screenshotMs)}`],['页面等待',duration(slot.timings.waitMs)],['重试次数',slot.timings.retries],['恢复购物车',duration(slot.timings.cleanupMs)]]):'');
}

function attemptLogs(slot:CollectionSlot) {
  return slot.attempts.length ? slot.attempts.map(a=>`<details class="run-log" data-detail-key="${h(a.id)}">
    <summary>第 ${h(a.number)} 次尝试 · ${h(time(a.startedAt))} · ${h(a.status ? state(a.status) : '进行中')}${a.executionMs==null?'':' · '+h(duration(a.executionMs))}</summary>
    ${a.error?`<p class="problem">${h(explain(a.error))}</p>`:''}
    ${a.steps.length?`<ol class="step-list">${a.steps.map((s,i)=>{
      const links=s.evidenceIds.map(evidenceLink).filter(Boolean).join(' ');
      return `<li><strong>${h(phases[s.phase] ?? s.phase)}</strong> · ${h(stepStates[s.state] ?? s.state)}
        <small class="sub">${h([time(s.at),duration(s.elapsedMs),explain(s.errorCode)].filter(Boolean).join(' · '))}</small>
        ${links ? `<div class="actions">${links}</div>` : ''}
        ${s.data && Object.keys(s.data).length ? `<details data-detail-key="${h(a.id)}-${i}"><summary>查看返回值</summary><div class="step-values">${stepData(s.data)}</div></details>`:''}
      </li>`;
    }).join('')}</ol>`:a.legacyTrace?.length?`<ol class="step-list">${a.legacyTrace.map(step=>`<li><strong>${h(phases[step.phase] ?? step.phase)}</strong>
      <small class="sub">${h(time(step.at))} · ${h(explain(step.note))}</small></li>`).join('')}</ol>`:'<p class="muted group">这次尝试没有记录逐步日志。</p>'}
  </details>`).join('') : '<p class="muted group">尚未开始执行。</p>';
}

function shelfReport(shelf:JdShelfResult,slots:CollectionSlot[]) {
  const direct=shelf.coverage==='direct_single';
  const selected=new Set(shelf.selected.map(item=>item.key));
  const others=shelf.items.filter(item=>!selected.has(item.key));
  return panel(`<div class="split"><div><h2>${h(coverageLabels[shelf.coverage])}</h2>
    <p class="muted">${h(shelf.store.name)} · ${h(shelf.store.address)}</p></div>${proofLink(shelf.evidence,'分店核对截图')}</div>
    <p class="group">${direct?'本次验证一款商品的报价。':`扫描 ${h(shelf.scannedCount)} 个商品，入选 ${h(shelf.selected.length)} 个单品。`}${shelf.stopReason&&!direct?' '+h(explain(shelf.stopReason))+'。':''}
    ${shelf.coverage==='partial'?'榜单只代表已扫描的菜单范围。':''}</p>
    ${shelf.selected.length ? `<div class="table-wrap"><table class="jd-results">
      <thead><tr><th scope="col">${direct?'试采商品':'排名与单品'}</th>${direct?'':'<th scope="col">销量</th>'}<th scope="col">商品现价</th><th scope="col">买一份的结算应付</th></tr></thead>
      <tbody>${shelf.selected.map((item,index)=>{
        const slot=slots.find(s=>s.itemKey===item.key);
        const o=slot?.observation, price=slot?.menuPrices.find(p=>p.kind==='display_current');
        return `<tr><td><strong>${direct?'':`${index+1}. `}${h(item.rawName)}</strong><small class="sub">${h(item.spec)}</small>${proofLink(item.evidence,direct?'规格截图':'菜单截图')}</td>
          ${direct?'':`<td>${h(salesText(item.sales,item.salesRaw))}</td>`}
          <td><strong>${h(priceText(price))}</strong>${slot?.menuPriceReason ? `<small class="sub">${h(explain(slot.menuPriceReason))}</small>`:''}</td>
          <td><strong>${h(o?.quote_valid ? yuan(o.amount_fen) : slot ? explain(slot.error)||slotState(slot) : '等待报价任务')}</strong>
          ${o?.details?.eta ? `<small class="sub">${h(o.details.eta.raw)}</small>`:''}</td></tr>`;
      }).join('')}</tbody></table></div>`:'<p class="muted">本次没有可以采价的热销单品。</p>'}
    ${others.length ? `<details class="group" data-detail-key="shelf-others"><summary>查看未入选的商品（${others.length} 个）</summary>
      <ul class="step-list">${others.map(item=>`<li><strong>${h(item.rawName)}</strong><small class="sub">${h([kindLabels[item.kind],item.spec,salesText(item.sales,item.salesRaw),explain(item.excludedReason)||'未排入本次前 5 名'].filter(Boolean).join(' · '))}</small>
        ${proofLink(item.evidence,'菜单截图')}</li>`).join('')}</ul></details>`:''}`);
}

// 采集进度条：把后端执行步骤映射成 8 个关键节点，让用户实时看到工具走到哪一步。
const PROGRESS_NODES = [
  { key: 'home', label: '进入首页', patterns: [/home|首页|MainActivity/i] },
  { key: 'takeout', label: '打开外卖频道', patterns: [/takeout|外卖频道|外卖入口/i] },
  { key: 'search', label: '搜索品牌名', patterns: [/brand_search|搜索品牌|搜索页/i] },
  { key: 'results', label: '进入门店结果页', patterns: [/results|搜索结果|门店卡/i] },
  { key: 'store', label: '进入店铺', patterns: [/store|门店页|进店/i] },
  { key: 'item', label: '定位爆品', patterns: [/item|店内搜索|单品|热门词/i] },
  { key: 'cart', label: '加购结算', patterns: [/cart|加购|去结算|checkout/i] },
  { key: 'done', label: '采数完成', patterns: [/quote|menu_model|采数完成|completed/i] },
] as const;

function progressIndex(slots: CollectionSlot[]): { index: number; failed: boolean } {
  const stepText = slots
    .flatMap(slot => (slot.attempts ?? []).flatMap((a: any) => (a.steps ?? []).map((x: any) => String(x?.name ?? x?.phase ?? x))))
    .join(' | ');
  let index = 0;
  for (let i = 0; i < PROGRESS_NODES.length; i++) {
    const node = PROGRESS_NODES[i]!;
    if (node.patterns.some((p: RegExp) => p.test(stepText))) index = i + 1;
  }
  return { index, failed: slots.some(s => s.error) };
}

function progressBar(slots: CollectionSlot[], state: string) {
  const { index, failed } = progressIndex(slots);
  const pct = Math.round((index / PROGRESS_NODES.length) * 100);
  const isFailed = failed && state !== 'completed';
  const cur = PROGRESS_NODES[Math.min(index, PROGRESS_NODES.length - 1)]!;
  const nodes = PROGRESS_NODES.map((node, i) => {
    const done = i < index;
    const current = i === index && state === 'running';
    const cls = done ? 'is-done' : current ? 'is-current' : isFailed && i === index ? 'is-failed' : '';
    return `<li class="${cls}"><span class="dot">${done ? '✓' : i + 1}</span><span class="label">${h(node.label)}</span></li>`;
  }).join('');
  const text = isFailed ? `采集在「${h(cur.label)}」失败`
    : index >= PROGRESS_NODES.length ? '采数完成'
    : `当前进度：${h(cur.label)}`;
  return `<div class="collect-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
    <div class="collect-progress-track"><div class="collect-progress-fill${isFailed ? ' is-failed' : ''}" style="width:${pct}%"></div></div>
    <ol class="collect-progress-nodes">${nodes}</ol>
    <p class="collect-progress-text">${text}（${pct}%）</p>
  </div>`;
}

export function renderRun(ws:Workspace,report:CollectionRun) {
  const {run,shelf,slots}=report;
  const quotes=slots.filter(slot=>slot.kind==='quote');
  const completed=quotes.filter(slot=>!['queued','running'].includes(slot.state)).length;
  const status=[runStates[report.state],quotes.length?`已处理 ${completed} / ${quotes.length} 个商品`:'',report.elapsedMs==null?'':`全程耗时 ${duration(report.elapsedMs)}`].filter(Boolean).join(' · ');
  return panel(`<h2>${h(run.label)}</h2><p class="muted">${h(time(run.created_at))} 发起</p><p role="status">${h(status)}</p>
    ${progressBar(slots,report.state)}
    ${report.queueMs!=null && report.executionMs!=null ? `<small class="sub">排队 ${h(duration(report.queueMs))} · 执行 ${h(duration(report.executionMs))}</small>`:''}
    <small class="sub">任务编号 ${h(run.id)}</small>`)+(shelf?shelfReport(shelf,slots):'')+
    (quotes.length ? panel(`<h2>报价与依据</h2>${quotes.map(slot=>`<details class="run-log" data-detail-key="quote-${h(slot.id)}">
      <summary>${h([slot.item,slot.spec,label(ws,slot.platform)].filter(Boolean).join(' · '))}</summary>${priceDetails(slot)}</details>`).join('')}`) : '')+
    panel(`<h2>执行日志</h2>${slots.length?slots.map(slot=>`<details class="run-log" data-detail-key="${h(slot.id)}">
      <summary>${slot.kind==='shelf'?'分店核对与菜单扫描':h([slot.item,slot.spec,label(ws,slot.platform)].filter(Boolean).join(' · '))}
      · ${h(slotState(slot))}</summary>
      ${slot.error?`<p class="problem">${h(explain(slot.error))}</p>`:''}
      ${proofLink(slot.proof,'采集截图')}
      ${attemptLogs(slot)}</details>`).join(''):'<p class="muted">暂无采集步骤。</p>'}`);
}
