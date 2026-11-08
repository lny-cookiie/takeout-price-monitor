import type { Meal, OrderImport, Plan, Profile, Target } from '../domain/competition.js';
import { type Records, type Workspace, button, customer, definitions, empty, field, h, heading, idAttr, input, label, mealNames, panel, proofLink, reason, select, state, supplyLabel, tabs, time, yuan } from './presentation.js';
import { jdStartForm } from './jd-runs.js';

const relation = {exact:'相同',similar:'尚未核实为相同',different:'不同',unknown:'信息不足'};
export function settings(ws:Workspace,section:string,profile?:Profile,plan?:Plan,jdSubmitting=false,selectedJdStore='') {
  return heading('监测设置')+tabs(section,[['jd','京东采集'],['targets','门店与商品'],['profiles','配送与账号'],['plans','采集计划']])+
    (section==='jd'?jdStartForm(ws,jdSubmitting,selectedJdStore):section==='profiles'?profiles(ws,profile):section==='plans'?plans(ws,plan):targets(ws));
}
function targets(ws:Workspace) {
  const rows=ws.targets.map(t=>{
    const s=t.supply;
    const confirmed=ws.platforms.filter(p=>ws.mappings.some(m=>m.targetId===t.id && m.targetRevision===t.revision && m.candidate.platform===p.id && m.status==='verified' && (!p.entry || p.entry===m.candidate.entry)));
    return `<div class="row"><div class="split"><div><strong>${h(supplyLabel(t))}</strong><small class="sub">${h([s.store.city,s.store.address].filter(Boolean).join(' · ') || '营业地址待补齐')}</small></div>
    ${button('candidate','识别候选',false,idAttr(t.id))}</div><small>${confirmed.length?'已确认 '+confirmed.map(p=>h(p.name)).join('、'):'待确认三平台对应关系'}${s.item.spec?'':' · 规格待补齐'}</small></div>`;
  }).join('');
  const suggestions=ws.mappings.map(m=>{
    const t=ws.targets.find(t=>t.id===m.targetId), c=m.candidate, stale=t?.revision!==m.targetRevision;
    const can=m.status==='proposed' && !stale && m.store.relation==='exact' && m.item.relation==='exact' && !m.store.missing.length && !m.item.missing.length;
    return `<div class="row"><div class="split"><div><strong>${h(label(ws,c.platform))} · ${h(c.supply.item.name)}</strong><small class="sub">对应 ${h(t?supplyLabel(t):'原目标')}${stale?' · 原资料已变化':''}</small></div><small>${m.status==='verified'?'已确认':m.status==='rejected'?'已拒绝':'待审核'}</small></div>
      <p>${h(c.supply.store.name)} · ${h(c.supply.store.address || '地址待补齐')} · ${h(c.supply.item.spec || '规格待补齐')}</p>
      <small>门店判断为${h(relation[m.store.relation])}。 ${h(m.store.reason)}</small><small>商品判断为${h(relation[m.item.relation])}。 ${h(m.item.reason)}</small>
      <small>${h(c.entry)} · ${h(c.reference)} ${proofLink(c.evidence)}</small>
      ${m.status==='proposed'?`<div class="actions">${can?button('mapping','审核并确认',true,idAttr(m.id)):''}${button('reject','拒绝候选',false,idAttr(m.id))}</div>`:''}</div>`;
  }).join('');
  return (rows?panel(`<div class="split"><h2>京东门店与商品</h2>${button('import-nav','导入资料')}</div>${rows}`):
    empty('等待导入京东资料','实际监测需要门店地址和商品规格。手头没有京东资料时，可以先用内置数据演练。',button('import-nav','导入京东资料',true)+button('open-demo','先试用')))+
    (suggestions?panel('<h2>匹配记录</h2>'+suggestions):'');
}
function profiles(ws:Workspace,p?:Profile) {
  const choices=Object.entries(customer) as [string,string][];
  const stores=[...new Map(ws.targets.map(t=>[t.supply.store.key,t.supply.store])).values()];
  const deliveryNames=[...new Set(ws.platforms.flatMap(platform=>platform.setup ? [platform.setup.deliveryName] : []))];
  const deliveryName=deliveryNames.length===1 ? deliveryNames[0] : undefined;
  const local=(value?:string)=>value ? new Date(Date.parse(value)+8*3_600_000).toISOString().slice(0,16) : '';
  const saved=ws.profiles.map(x=>`<div class="row"><div class="split"><div><strong>${h(x.name)}</strong><small class="sub">${h(x.city)} · ${h(x.point)}</small></div>${button('edit-profile','编辑',false,idAttr(x.id))}</div></div>`).join('');
  return (saved?panel('<h2>已保存的配送与账号</h2>'+saved):'')+panel(`<h2>${p?'编辑配送与账号':'添加配送与账号'}</h2>
    <p class="muted">先在各外卖 App 里选同一个实际配送地址。这里填写方便辨认的简称，例如“总部园区东门”。请与接入时登记的名称一致，详细地址留在手机里。</p>
    ${deliveryNames.length>1 ? '<p class="problem">各平台登记的配送地址名称不同。请先核对手机里是否设为同一个实际地址，再统一登记名称。</p>' : ''}
    <form data-form="profile"><div class="fields">
      ${field('这组设置叫什么',input('name',p?.name,'required maxlength="80" placeholder="例如：总部园区 · 老客非会员"'))}
      ${field('配送城市',input('city',p?.city,'required maxlength="80" placeholder="例如：北京市"'))}
      ${field('配送地址简称',input('point',p?.point ?? deliveryName,'required maxlength="80" placeholder="例如：总部园区东门"'))}
    </div>
    <h3>各平台用什么账号</h3>
    <p class="muted">已登记的测试账号名称会自动带出。在 App 会员页核对会员状态，新老客以平台明确显示的资格为准。核对后填上能回查的记录编号，例如测试核对表里的“账号核对-01”。看不到明确资格时选“待核实”。没有测试账号的平台可整栏留空。</p>
    <datalist id="membership-examples"><option value="非会员"></option></datalist>
    <div class="fields">${ws.platforms.map(x=>{
        const k=x.id,e=p?.eligibility[k];
        return `<fieldset><legend>${h(x.name)}</legend><div class="reading">
        ${field('测试账号名称',input(k+'-account',p ? e?.accountRef : x.setup?.accountName,`maxlength="80" placeholder="例如：${h(x.name)}测试账号 01"`))}
        ${field('对这个平台是新客还是老客',select(k+'-platform',choices,e?.platformCustomer ?? 'unknown'))}
        ${field('会员状态',input(k+'-segment',e?.memberSegment,'list="membership-examples" maxlength="80" placeholder="例如：非会员；不确定就留空"'))}
        ${field('账号核对记录编号',input(k+'-proof',e?.evidence,'maxlength="200" placeholder="例如：账号核对-01"'))}
        <details ${e?.memberProduct || e?.memberTier || e?.benefits.length ? 'open' : ''}><summary>会员详情（有会员时填写）</summary><div class="reading">
        ${field('App 显示的会员名称',input(k+'-product',e?.memberProduct))}${field('App 显示的会员等级',input(k+'-tier',e?.memberTier))}
        ${field('影响外卖报价的会员权益',input(k+'-benefits',e?.benefits.join('、'),'placeholder="例如：配送费减免、会员专享券"'))}
        </div></details>
        </div></fieldset>`;
      }).join('')}</div>
      <p class="muted">确认无会员时填“非会员”。有会员时，可按核实的权益起名，例如“配送费减免会员”，再展开填写 App 显示的会员名称、等级和具体权益。权益一致的账号才用同一个比较名称。</p>
      ${stores.length ? `<h3 class="group">各门店的新老客</h3><p class="muted">在每个平台分别核对。一个平台的老客，在某家店仍可能是新客。记录编号可复用能证明该门店资格的内部记录。</p>` : ''}
      ${stores.map((store,i)=>`<details class="group"><summary>${h(store.name)}${store.address ? ' · '+h(store.address) : ''}</summary><div class="fields">${ws.platforms.map(platform=>{
        const q=p?.storeQualifications?.find(q=>q.storeKey===store.key && q.platform===platform.id);
        return `<fieldset><legend>${h(platform.name)}</legend><div class="reading">
        ${field('对这家店是新客还是老客',select('shop-'+i+'-'+platform.id,choices,q?.customer ?? 'unknown'))}
        ${field('门店核对记录编号',input('shop-proof-'+i+'-'+platform.id,q?.evidence,'maxlength="200" placeholder="例如：门店核对-01"'))}</div></fieldset>`;
      }).join('')}</div></details>`).join('')}
      <h3 class="group">核对时间</h3>
      <p class="muted">已核实账号时，两个时间一起填。第一个填实际查看的时间，第二个填这些记录可以用到什么时候。过期或缺少核对依据的报价不会进入同条件价差。</p>
      <div class="fields">
        ${field('实际核对时间（北京时间）',input('checkedAt',local(p?.checkedAt),'type="datetime-local"'))}
        ${field('核对记录有效到（北京时间）',input('validUntil',local(p?.validUntil),'type="datetime-local"'))}
      </div>
      <button class="primary">保存配送与账号</button> ${p?button('new-profile','添加另一组设置'):''}</form>`);
}
function plans(ws:Workspace,p?:Plan) {
  if (!ws.targets.length || !ws.profiles.length) return empty('先设置监测商品、配送与账号','选好要监测的商品，以及手机上要用的配送地址和测试账号。',
    button('section','门店与商品',false,idAttr('targets'))+button('section','配送与账号',false,idAttr('profiles')));
  const available=ws.platforms.filter(p=>p.status==='ready_for_defined_scope');
  const saved=ws.plans.map(a=>`<div class="row"><div class="split"><div><strong>${h(a.name)}</strong><small class="sub">${h(a.startDate)}起 ${a.days} 天 · ${a.targetIds.length} 项商品 · ${a.enabled?'定时采集已开启':'定时采集未开启'}</small></div>${button('edit-plan','编辑',false,idAttr(a.id))}</div>
    <form class="actions" data-form="run" ${idAttr(a.id)}><label>本次归到哪个用餐时段 ${select('meal',Object.entries(mealNames))}</label>
    ${available.length ? `<label>本次采集平台 ${select('platform',[['','三个平台'],...available.map(p=>[p.id,p.name] as [string,string])])}</label>` : ''}
    <button class="btn">立即采集</button></form></div>`).join('');
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return (saved?panel('<h2>已保存的计划</h2>'+saved):'')+panel(`<h2>${p?'编辑采集计划':'添加采集计划'}</h2>
    <form data-form="plan"><div class="fields">${field('计划名称',input('name',p?.name,'required maxlength="100"'))}
    ${field('配送与账号',select('profileId',ws.profiles.map(f=>[f.id,f.name]),p?.profileId))}
    ${field('每项商品数量',input('quantity',String(p?.quantity ?? 1),'type="number" min="1" max="9" required'))}
    ${field('开始日期',input('startDate',p?.startDate ?? today,'type="date" required'))}
    ${field('持续天数',input('days',String(p?.days ?? 3),'type="number" min="1" max="30" required'))}</div>
    <h3>每天几点采集（北京时间）</h3><p class="muted">例如午餐在 11:30 开始。不想采集的用餐时段留空。</p>
    <div class="fields">${Object.entries(mealNames).map(([k,v],i)=>field(v,input(k,p?p.times[k as Meal] ?? '':['11:30','17:30','21:30'][i],'type="time"'))).join('')}</div>
    <h3>监测商品（最多 6 项）</h3><div class="check-list">${ws.targets.map(t=>`<label><input type="checkbox" name="target" value="${h(t.id)}" ${p?.targetIds.includes(t.id)?'checked':''}>${h(supplyLabel(t))}</label>`).join('')}</div>
    <p class="group"><label><input type="checkbox" name="enabled" ${p?.enabled?'checked':''}> 开启定时采集</label></p>
    <p class="muted">真实采集开始前，请让这台电脑保持唤醒、工作台服务和模型正常运行。测试手机需通过 USB 连接，保持联网和 App 登录。开始时可以自动亮屏，遇到锁屏则停止。可以关闭浏览器页面。错过的时间会记在采集记录里。</p>
    <button class="primary">保存计划</button> ${p?button('new-plan','添加另一计划'):''}</form>`);
}
export function candidateForm(ws:Workspace,t:Target) {
  return `<p class="muted">京东参考商品为 ${h(supplyLabel(t))}。请填写实际页面看到的候选及证据编号。</p>
    <form data-form="candidate" ${idAttr(t.id)}><div class="fields">
    ${field('平台',select('platform',ws.platforms.map(p=>[p.id,p.name])))}
    ${field('实际应用入口',input('entry',ws.platforms[0]?.entry ?? ws.platforms[0]?.defaultEntry,'required'))}
    ${field('原始证据编号',input('reference','','required placeholder="页面或资料的可定位编号"'))}
    ${field('品牌',input('brand',t.supply.store.brand))}${field('城市',input('city',t.supply.store.city))}
    ${field('平台门店名称',input('store','','required'))}${field('营业地址',input('address'),'wide')}
    ${field('平台商品名称',input('item','','required'))}${field('规格',input('spec'))}
    ${field('类型',select('kind',[['single','单品'],['set','套餐']],t.supply.item.kind))}
    ${field('已选口味、加料（顿号分隔）',input('options'))}<label><input type="checkbox" name="optionsKnown"> 已核对所选口味和加料（无选项时也需核对）</label>
    ${field('套餐组成（每行填写名称 | 规格 | 数量）','<textarea name="parts" rows="2"></textarea>','full')}
    </div><output class="muted" aria-live="polite"></output><div class="actions"><button class="primary">调用模型识别</button>${button('read-candidate','从当前手机页面读取')}</div></form>`;
}
export function mappingReview(ws:Workspace,id:string) {
  const m=ws.mappings.find(m=>m.id===id);
  const t=ws.targets.find(t=>t.id===m?.targetId);
  if (!m || !t) return '<p>未找到对应的匹配记录。</p>';
  const a=t.supply,b=m.candidate.supply;
  const detail=(s:Target['supply'])=>[s.store.name,s.store.address,s.item.name,s.item.spec,...(s.item.options ?? []),...(s.item.parts ?? []).map(p=>p.name+' '+p.spec+' × '+p.quantity)].join(' · ');
  return definitions([['京东参考',detail(a)],['候选商品',detail(b)],['来源记录',m.candidate.reference],['模型判断',m.store.reason+' '+m.item.reason]])+
    proofLink(m.candidate.evidence)+`<form data-form="review" ${idAttr(id)}><div class="group">${field('实际核对用时（分钟，可选）',input('minutes','','type="number" min="0" max="480"'))}</div><button class="primary">确认对应关系</button></form>`;
}
export interface ImportFile {name:string;payload:{records:OrderImport[]}}
export function dataRecords(ws:Workspace,section:string,r:Records|undefined,importFile:ImportFile|null,modelReport:string,deviceReport:string,runId='',runDetail='',showLegacy=false) {
  const top=heading('数据记录')+tabs(section,[['collection','采集记录'],['orders','京东历史订单'],['connection','连接设置']]);
  if (section==='connection') return top+panel(`<div class="split"><div><h2>大模型</h2><p class="muted">${ws.model.configured?h(ws.model.model):ws.model.problem?h(ws.model.problem):'在本地 .env 配置模型服务地址、名称和密钥后重启。'}</p></div>
    ${ws.model.configured?button('model-test','测试连接'):''}</div>${modelReport?`<p class="group" role="status">${h(modelReport)}</p>`:''}`)+panel(`
    <div class="split"><h2>Android 设备与采集入口</h2>${button('devices','检查设备')}</div>${deviceReport?`<p class="group" role="status">${h(deviceReport)}</p>`:''}${ws.sourceConfigurationError?`<p class="problem">${h(ws.sourceConfigurationError)}</p>`:''}
    ${ws.platforms.map(p=>`<div class="row"><div class="split"><div><strong>${h(p.name)}</strong><small class="sub">${h(p.entry ?? p.defaultEntry)}${p.appVersion?' · '+h(p.appVersion):''}</small>${p.problem?`<small class="sub problem">${h(p.problem)}</small>`:''}</div><small>${h(state(p.status))}</small></div></div>`).join('')}
    <p class="muted">入口、应用版本和设备通过本地 android-sources.json 配置。</p>
    ${ws.platforms.some(p=>p.status==='ready_for_defined_scope')?`<details class="group"><summary>核对手机控件</summary>
    <form data-form="device-control"><div class="fields">${field('已登记入口',select('platform',ws.platforms.filter(p=>p.status==='ready_for_defined_scope').map(p=>[p.id,p.name])))}
    ${field('手机当前页面的控件文字',input('text','','required maxlength="200" placeholder="例如：去结算"'),'wide')}</div>
    <div class="actions"><button class="btn">查找控件编号</button><output class="muted" aria-live="polite"></output></div></form></details>`:''}`)+
    (r?.modelCalls.length ? panel('<h2>最近模型调用</h2>'+r.modelCalls.map(a=>`<div class="row"><small>${h(a.operation)} · ${h(a.model)} · ${a.ok?'通过':'失败'} · ${(a.ms/1000).toFixed(1)} 秒${a.inputTokens!==null?' · 输入 '+a.inputTokens+' / 输出 '+(a.outputTokens ?? '未知')+' tokens':''}</small></div>`).join('')):'');
  if (section==='orders') return top+panel(`<h2>导入京东资料</h2><p class="muted">选择按模板整理的 CSV 或 JSON，预览后确认。订单实付按人民币分保存。</p>
    <div class="actions group">${button('order-template','下载 CSV 模板')}${button('order-template-json','下载 JSON 模板')}<label>选择文件 <input type="file" id="order-file" accept=".csv,.json,text/csv,application/json"></label></div>
    ${importFile?`<div class="group"><strong>${h(importFile.name)} · ${importFile.payload.records.length} 条记录</strong><div class="reading">
    ${importFile.payload.records.slice(0,5).map(x=>`<small>${h(x.supply?.store?.name)} · ${h(x.supply?.item?.name)} · ${h(x.supply?.item?.spec)} · ${h(yuan(x.actualPaidFen))}</small>`).join('')}</div></div>${button('confirm-import','确认导入',true)}`:''}`)+
    (r?.orders.length?`<section class="panel table-wrap"><table class="records"><thead><tr><th>门店</th><th>商品与规格</th><th>历史实付</th><th>支付时间</th><th>来源记录</th></tr></thead><tbody>
    ${r.orders.map(({record:x})=>`<tr><td>${h(x.supply.store.name)}</td><td>${h(x.supply.item.name)}<small class="sub">${h(x.supply.item.spec)}</small></td><td>${yuan(x.actualPaidFen)}</td><td>${h(time(x.paidAt))}</td><td>${h(x.reference)}</td></tr>`).join('')}</tbody></table></section>`:'');
  const trial=r?.trial.map(t=>`<div class="row"><strong>${h(t.name)}</strong><small>已生成 ${t.stats.planned} / ${t.expected} 次计划 · 已取得报价 ${t.stats.quoted} · 已人工核对 ${t.stats.verified} · 核对不符 ${t.stats.disputed} · 无报价 ${t.stats.unavailable} · 受限 ${t.stats.blocked} · 失败 ${t.stats.failed} · 待完成 ${t.stats.pending} · 三平台可比 ${t.stats.threePlatforms} 组</small>
    <small>设备执行 ${t.executionMinutes.toFixed(1)} 分钟 · 人工核对 ${t.manualMinutes===null?'未登记':t.manualMinutes+' 分钟'} · 每条有效报价模型费用 ${t.modelCostPerQuote===null?'未知':'¥'+t.modelCostPerQuote.toFixed(3)}</small></div>`).join('') ?? '';
  const runs=r?.runs ?? (r?.run?[r.run]:[]);
  const history=[['','最近一次'],...runs.map(run=>[run.id,run.label+' · '+time(run.created_at)])] as [string,string][];
  if(runId && !runs.some(run=>run.id===runId))history.push([runId,'本次采集']);
  const picker=runs.length || runId ? panel(`<div class="run-picker">${field('采集任务',select('recordsRun',history,runId))}${button('records-refresh','刷新记录')}</div>`):'';
  const legacy=!r?.slots.length ? '' :
    `<section class="panel table-wrap"><table class="records">
    <thead><tr><th>门店与商品</th><th>平台</th><th>计划时间</th><th>结果</th><th>尝试次数</th><th>证据</th></tr></thead><tbody>
    ${r.slots.map(s=>`<tr><td>${h(s.store)}<small class="sub">${h(s.item)}</small></td><td>${h(label(ws,s.platform))}</td><td>${h(time(s.dueAt))}</td><td>${h(state(s.review?.decision==='disputed'?'disputed':s.status ?? s.state))}<small class="sub">${h(reason(s.error))}</small>${s.error && s.phase?`<small class="sub">${h(s.phase)}</small>`:''}</td><td>${s.attempts}</td><td>${proofLink(s.proof)}</td></tr>`).join('')}</tbody></table></section>`;
  const noRecords=empty('还没有实际采集记录','启动采集后，可以查看价格、证据和未完成原因。',button('jd-nav','京东采集',true));
  return top+picker+`<div data-run-detail>${runDetail || (!showLegacy && legacy) || (showLegacy && legacy?'':r?noRecords:panel('<p class="muted" role="status">正在读取采集记录…</p>'))}</div>`+
    (showLegacy?legacy:'')+
    (trial?panel('<h2>试点进度</h2>'+trial):'');
}
