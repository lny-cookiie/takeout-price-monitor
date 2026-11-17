// BD 报价采集页：通过正式接口创建比较组并读取各平台的执行状态。
const PLATFORMS={jd:{name:'京东'},meituan:{name:'美团'},taobao:{name:'淘宝闪购'}};
const $=id=>document.getElementById(id),sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
// 平台标识映射：前端用简短标识，后端来源配置用完整契约标识 taobao_instant
const API_PLATFORM={jd:'jd',meituan:'meituan',taobao:'taobao_instant'};
const UI_PLATFORM={jd:'jd',meituan:'meituan',taobao_instant:'taobao'};
const form=$('bd-form'),runPanel=$('run-panel'),summary=$('run-summary'),runsBox=$('platform-runs'),logBox=$('run-log'),logCount=$('log-count'),stateEl=$('run-state'),actions=$('run-actions'),openResult=$('open-result'),startBtn=$('start-btn');
const resultPanel=$('result-panel'),resultBody=$('result-body'),resultState=$('result-state'),stopBtn=$('stop-btn');
let busy=false,failedPlatforms=new Set(),lastPayload=null,lastGroupId=null,logLines=0;
function toast(message){const t=$('bd-toast');t.textContent=message;clearTimeout(t._timer);t._timer=setTimeout(()=>{t.textContent='';},3200);}
function addLog(line){logLines++;logBox.textContent+=`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] ${line}\n`;logBox.scrollTop=logBox.scrollHeight;logCount.textContent=logLines+' 条';}
function resetRunView(){logBox.textContent='';logLines=0;logCount.textContent='0 条';failedPlatforms=new Set();actions.hidden=true;openResult.hidden=true;stopBtn.hidden=true;stopBtn.disabled=false;runsBox.innerHTML='';summary.innerHTML='';}
function renderSummary(payload,platforms){summary.innerHTML=`<div><span>城市 / 品牌</span><strong>${esc(payload.city)} · ${esc(payload.brand)}</strong></div>
<div><span>门店</span><strong>${payload.store?esc(payload.store):'同城自动匹配'}</strong></div>
<div><span>爆品</span><strong>${esc(payload.item)}</strong></div>`;
  runsBox.innerHTML=platforms.map(p=>`<div class="platform-run" id="run-${p}" data-platform="${p}"><span class="pr-name">${PLATFORMS[p].name}</span><span class="pr-bar"><i></i></span><span class="pr-state">排队中</span></div>`).join('');}
function setRun(platform,state,percent,label){const row=document.getElementById('run-'+platform);if(!row)return;row.className='platform-run '+state;row.querySelector('.pr-bar i').style.width=percent+'%';row.querySelector('.pr-state').textContent=label;}
function offerCartConfirmation(platform,slot){
  if(!slot.id||!['quarantined','needs_attention'].includes(slot.cleanup))return;
  const row=document.getElementById('run-'+platform);if(!row||row.querySelector('.confirm-cart'))return;
  const button=document.createElement('button');button.type='button';button.className='confirm-cart';button.textContent='确认购物车已空';
  button.addEventListener('click',async()=>{
    if(!window.confirm('请先在手机上亲自检查该平台购物车。只有明确为空时才能确认；确认会解除设备和账号的购物车隔离。是否已经确认？'))return;
    button.disabled=true;
    try{const res=await fetch('/api/bd/slots/'+encodeURIComponent(slot.id)+'/confirm-empty-cart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true})});const data=await res.json();if(!res.ok)throw new Error(data.message||data.error||'确认失败');button.remove();addLog(`${PLATFORMS[platform].name} · 已记录人工空车确认；失败任务可手动重试，已有报价的任务需重新发起`);}
    catch(e){button.disabled=false;toast(e.message);}
  });row.appendChild(button);
  button.addEventListener('click',()=>{setTimeout(()=>refreshResult(),800);});
}
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function startCollection(payload,platforms,requestId){
  const res = await fetch('/api/bd/runs',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({city:payload.city,brand:payload.brand,store:payload.store||'',item:payload.item,platforms:platforms.map(p=>API_PLATFORM[p]||p),requestId})});
  const data = await res.json().catch(()=>({error:'bad_response'}));
  if(!res.ok) throw new Error(data.message||data.error||('HTTP '+res.status));
  return data;
}
// 轮询一次采集运行的进度（真实后端）
async function pollRun(runId){
  const res = await fetch('/api/market/runs/'+encodeURIComponent(runId),{cache:'no-store'});
  if(!res.ok) return null;
  return res.json();
}
// 三个平台的后端阶段名各不相同，所以各用一张映射表，避免进度条显示成别人家的步骤。
const STAGE_TABLES={
  jd:{source_check:'检查采集源',device_connect:'连接手机',launch:'启动京东App',brand_search:'搜索品牌',
    brand_model_match:'匹配品牌',store_verify:'校验门店',store_address_open:'打开门店',sku_match:'匹配规格',
    menu_price:'读取菜单价',menu_model:'菜单页识别',cart:'加购结算',checkout:'进入结算页',
    fee_probe:'探测费用',freight_probe:'探测运费',model_verify:'结算页识别',restore:'恢复现场'},
  meituan:{connect:'连接手机',brand_search:'搜索品牌',checkout:'结算采数'},
  taobao_instant:{navigation:'淘宝采集', '进入首页':'进入首页','打开外卖频道':'打开外卖频道','搜索品牌名':'搜索品牌名','进入门店结果页':'进入门店结果页',
    '进入店铺':'进入店铺','定位爆品':'定位爆品','加购结算':'加购结算','采数完成':'采数完成'}};
// 每个平台的主链路阶段数，用来算进度百分比
const STAGE_TOTAL={jd:12,meituan:3,taobao_instant:8};
async function pollProgress(apiPlatform){
  const res=await fetch('/api/market/live-progress?platform='+encodeURIComponent(apiPlatform),{cache:'no-store'});
  if(!res.ok) return null;
  return res.json().catch(()=>null);
}
// 结果与证据在比价页内展示，不再跳去 UE；刷新页面后按比较组恢复查看。
const money=fen=>fen==null?'—':'¥'+(fen/100).toFixed(2);
const timeText=iso=>iso?new Date(iso).toLocaleString('zh-CN',{hour12:false}):'—';
function platformCard(platform,slot){
  const obs=slot.observation||null;
  const valid=!!obs?.quote_valid;
  const cleanup=slot.cleanup;
  const cleanupLabel={untouched:'未变更（立即购买不碰购物车）',restored:'已恢复',quarantined:'需人工核对',needs_attention:'需人工处理'}[cleanup]||'未知';
  const detail=obs?.details||{};
  const missing=Object.entries(detail.missing||{}).filter(([k])=>!['verification','reconciliation'].includes(k));
  const store=obs?(slot.context?.store||'未记录'):'未采集到门店';
  const refs=(obs?.evidence_refs||[]);
  const visual=String(detail.missing?.verification||'').includes('视觉');
  const tag=valid?(obs?.detail_complete?'ok':'warn'):'bad';
  const tagText=valid?(obs?.detail_complete?'有效报价 · 明细完整':'有效报价 · 明细部分缺失'):(slot.status==='blocked'?'被安全规则拦截':'未取得报价');
  const tagSuffix=visual?' · 视觉读取':'';
  const attempts=Array.isArray(slot.attempts)?slot.attempts:[];
  const firstAttempt=attempts[0];
  const attemptNote=attempts.length?`尝试 ${attempts.length} 次${firstAttempt?.status?`，首次结果 ${esc(firstAttempt.status)}`:''}${slot.quoteMs!=null?` · 报价耗时 ${(slot.quoteMs/1000).toFixed(1)} 秒`:''}`:'';
  const failedPhase=(()=>{const steps=(attempts.at(-1)?.steps||[]);const failed=steps.filter(st=>st.state==='failed'||st.state==='blocked').at(-1);return failed?String(failed.phase||'')+(failed.errorCode?`（${failed.errorCode}）`:''):'';})();
  return `<article class="result-card" data-platform="${platform}">
    <div class="rc-head"><strong>${PLATFORMS[platform].name}</strong><span class="rc-tag ${tag}">${esc(tagText+tagSuffix)}</span></div>
    <div class="rc-amount">${valid?money(obs.amount_fen):'—'}<small>${valid?'结算应付':esc(slot.error||slot.status||slot.state||'')}</small></div>
    ${attemptNote?`<p class="rc-note">${attemptNote}${failedPhase?` · 卡在 ${esc(failedPhase)}`:''}</p>`:''}
    <dl class="rc-meta">
      <div><dt>实际分店</dt><dd>${esc(store)}</dd></div>
      <div><dt>商品</dt><dd>${esc(slot.item||'')}${slot.spec?' · '+esc(slot.spec):''} · 1 份</dd></div>
      <div><dt>观察时间</dt><dd>${timeText(obs?.observed_at)}</dd></div>
      <div><dt>购物车</dt><dd>${esc(cleanupLabel)}</dd></div>
      <div><dt>证据</dt><dd>${refs.length?refs.map(r=>`<a href="${esc(r.screenshot)}" target="_blank" rel="noopener">结算截图</a> <a href="${esc(r.text_file)}" target="_blank" rel="noopener">证据原文</a>`).join(''):'无'}</dd></div>
    </dl>
    ${missing.length?`<details class="rc-missing"><summary>未采用或缺失的明细（${missing.length} 项）</summary><ul>${missing.map(([k,v])=>`<li>${esc(k)}：${esc(v)}</li>`).join('')}</ul></details>`:''}
    ${(slot.quotes||[]).length?`<details class="rc-missing"><summary>历史报价（${(slot.quotes||[]).length} 次尝试）</summary><ul>${(slot.quotes||[]).map(q=>`<li>${timeText(q.observedAt)} · ${q.amountFen==null?'无金额':'¥'+(q.amountFen/100).toFixed(2)} · ${q.quoteValid?'有效':'未通过核验'}</li>`).join('')}</ul></details>`:''}
    ${detail.reconciliation?`<p class="rc-note">${esc(detail.reconciliation)}</p>`:''}
  </article>`;
}
function resultSummary(slots,timing){
  const valid=slots.filter(s=>s.observation?.quote_valid);
  const warnings=[];
  if(slots.length<3)warnings.push('本组只选了部分平台');
  if(valid.length<slots.length)warnings.push(`${slots.length-valid.length} 个平台未取得有效报价`);
  const badCleanup=slots.filter(s=>!['untouched','restored'].includes(s.cleanup));
  if(badCleanup.length)warnings.push(`${badCleanup.length} 个平台购物车状态未确认`);
  const times=valid.map(s=>Date.parse(s.observation.observed_at)).filter(Number.isFinite);
  const skew=times.length>1?(Math.max(...times)-Math.min(...times))/60000:null;
  if(skew!=null&&skew>5)warnings.push(`三平台观察时差 ${skew.toFixed(1)} 分钟，超过 5 分钟口径`);
  const complete=slots.length===3&&valid.length===3&&!badCleanup.length&&(skew==null||skew<=5);
  const deltas=[];
  const byPlatform=Object.fromEntries(slots.map(s=>[s.platform,s]));
  for(const other of ['meituan','taobao_instant']){
    const a=byPlatform.jd,b=byPlatform[other];
    if(a?.observation?.quote_valid&&b?.observation?.quote_valid){
      const d=a.observation.amount_fen-b.observation.amount_fen;
      deltas.push(`${PLATFORMS[UI_PLATFORM[other]].name} 比京东 ${d===0?'相同':(d>0?'低':'高')+' '+Math.abs(d/100).toFixed(2)+' 元'}`);
    }
  }
  return `<div class="result-banner ${complete?'ok':'warn'}">${complete?'本组达到完整比较组口径':'本组未达到完整组口径'}${warnings.length?'：'+warnings.map(esc).join('；'):''}</div>
    ${timing?`<p class="rc-note">${esc(timing)}</p>`:''}
    ${deltas.length?`<p class="rc-note">实测样本差额：${deltas.map(esc).join('；')}。会员、新客资格和优惠条件可能不同，未经核实时只能当作同城同品牌同品样本差额，不能推断平台补贴差异。</p>`:''}
    ${skew!=null?`<p class="rc-note">三平台观察时差 ${skew.toFixed(1)} 分钟。</p>`:''}`;
}
async function loadResult(runId){
  if(!runId)return;
  lastGroupId=runId;
  try{localStorage.setItem('bd-last-group',runId);}catch{}
  const data=await pollRun(runId).catch(()=>null);
  if(!data){resultBody.innerHTML='<p class="rc-note">读取结果失败，请稍后刷新。</p>';resultPanel.hidden=false;return;}
  const slots=data.slots||[];
  resultState.textContent=slots.every(s=>['completed','interrupted','source_blocked','window_missed','cancelled'].includes(s.state))?'已完成':'进行中';
  const queueMs=Number(data.queueMs??NaN), executionMs=Number(data.executionMs??NaN), elapsedMs=Number(data.elapsedMs??NaN);
  const timing=[Number.isFinite(queueMs)?`排队 ${(queueMs/1000).toFixed(1)} 秒`:null,Number.isFinite(executionMs)?`执行 ${(executionMs/1000).toFixed(1)} 秒`:null,
    Number.isFinite(elapsedMs)?`完整耗时 ${(elapsedMs/1000).toFixed(1)} 秒`:null].filter(Boolean).join(' · ');
  resultBody.innerHTML=resultSummary(slots,timing)+`<div class="result-grid">${slots.map(s=>platformCard(UI_PLATFORM[s.platform]||s.platform,s)).join('')}</div>`;
  resultPanel.hidden=false;
  return data;
}
async function refreshResult(){if(lastGroupId)await loadResult(lastGroupId);}
async function runPlatform(platform,payload,runId,state){
  if(!runId||state==='not_integrated'||state==='not_licensed'){
    const label = state==='not_licensed' ? '待授权' : state==='not_integrated' ? '未接入' : '未启动';
    setRun(platform,'failed',100,label);
    addLog(`${PLATFORMS[platform].name}：${state==='not_licensed'?'采集许可未满足，需补书面授权后才能发起':state==='not_integrated'?'采集链路尚未接入调度':'任务未创建'}`);
    failedPlatforms.add(platform);return false;}
  const apiPlatform=API_PLATFORM[platform]||platform;
  const table=STAGE_TABLES[apiPlatform]||{};
  const total=STAGE_TOTAL[apiPlatform]||8;
  setRun(platform,'running',5,'已提交');
  let last='',percent=5;
  for(let i=0;i<1200;i++){
    // 两个进度来源：淘宝只上报 live-progress，京东/美团走 worker 步骤。
    // 进度必须属于当前任务；平台共享进度文件可能残留上一次结果。
    const lp=await pollProgress(apiPlatform).catch(()=>null);
    let label=null;
    const lpFresh=lp&&lp.platform===apiPlatform&&lp.updatedAt&&Date.now()-Date.parse(lp.updatedAt)<15*60_000;
    if(lpFresh&&lp.node){
      const lpLabel=table[lp.node]||lp.node;
      const lpPercent=Number.isFinite(lp.percent)?lp.percent:5;
      if(lpPercent>=percent){label=lpLabel;percent=Math.max(percent,Math.min(95,lpPercent));}
      if(lp.state==='failed'){setRun(platform,'failed',percent,lp.message||'失败');addLog(`${PLATFORMS[platform].name} · ${lpLabel} 失败${lp.message?'：'+lp.message:''}`);failedPlatforms.add(platform);return false;}
    }
    const data=await pollRun(runId).catch(()=>null);
    if(data){
      const slot=(data.slots||[]).find(s=>s.platform===apiPlatform)||{};
      const latestAttempt=(slot.attempts||[]).at(-1);
      const phases=(latestAttempt?.steps||[]).map(x=>String(x.phase||x.name||''));
      if(phases.length){
        const lastPhase=phases[phases.length-1];
        const mapped=table[lastPhase]||lastPhase;
        const p2=Math.min(95,Math.round(phases.length/total*95));
        if(p2>=percent||mapped){label=mapped;percent=Math.max(percent,p2);}
      }
      // v2 要求把“等待手机、正在进入门店、已取得报价正在恢复、需要处理”分开显示，不混成一个进度。
      if(slot.cleanup==='quarantined'||slot.cleanup==='needs_attention')label='需要处理：购物车状态未确认';
      else if(slot.observation?.quote_valid&&slot.state==='running')label='已取得报价，正在恢复';
      else if(slot.state==='queued')label=phases.length?'排队等待手机':'等待手机';
      const runState=String(data.state||data.status||'');
      if(slot.state==='completed'||['interrupted','source_blocked','window_missed','cancelled'].includes(slot.state)||runState==='failed'||runState==='cancelled'){
        if(slot.state==='cancelled'){setRun(platform,'failed',percent,'已停止');addLog(`${PLATFORMS[platform].name} · 已按请求停止`);failedPlatforms.add(platform);return false;}
        if(slot.error||!['success','partial'].includes(slot.status)||!slot.observation?.quote_valid||!['untouched','restored'].includes(slot.cleanup)){
          offerCartConfirmation(platform,slot);
          setRun(platform,'failed',percent,'未取得可用报价');addLog(`${PLATFORMS[platform].name} · 未取得可用报价（${slot.error||slot.status||slot.state}；购物车：${slot.cleanup||'未知'}）`);failedPlatforms.add(platform);return false;}
        setRun(platform,'success',100,'完成');addLog(`${PLATFORMS[platform].name} · 采集完成`);return true;}
    }
    if(label&&label!==last){last=label;setRun(platform,'running',percent,label);addLog(`${PLATFORMS[platform].name} · ${label}`);}
    await sleep(1000);
  }
  setRun(platform,'failed',100,'超时');addLog(`${PLATFORMS[platform].name} · 等待超时`);failedPlatforms.add(platform);return false;}
form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;
  const data=new FormData(form),payload={city:String(data.get('city')||'').trim(),brand:String(data.get('brand')||'').trim(),store:String(data.get('store')||'').trim(),item:String(data.get('item')||'').trim()};
  const platforms=[...form.querySelectorAll('input[name="platform"]:checked')].map(input=>input.value);
  if(!payload.city||!payload.brand||!payload.item){toast('请先填写城市、品牌和爆品名称');return;}
  if(!platforms.length){toast('至少选择一个采集平台');return;}
  lastPayload=payload;busy=true;startBtn.disabled=true;startBtn.textContent='采集中…';resetRunView();runPanel.hidden=false;stateEl.textContent='采集中';stopBtn.hidden=false;stopBtn.disabled=false;
  renderSummary(payload,platforms);addLog(`开始采集：${payload.city} / ${payload.brand} / ${payload.item}，平台 ${platforms.map(p=>PLATFORMS[p].name).join('、')}`);
  const started=Date.now();
  const requestId=crypto.randomUUID();
  let created={platforms:[]};
  try{created=await startCollection(payload,platforms,requestId);}
  catch(e){toast('提交失败：'+e.message);busy=false;startBtn.disabled=false;startBtn.textContent='开始采集';addLog('提交失败：'+e.message);return;}
  if(created.matched)addLog(`匹配到：${created.matched.storeName} · ${created.matched.itemName}`);
  lastGroupId=created.platforms?.[0]?.runId??null;
  // 三平台并行轮询：各自跑各自的进度条，不再一个跑完才轮到下一个。
  await Promise.all(platforms.map(platform=>{
    const r=(created.platforms||[]).find(x=>UI_PLATFORM[x.platform]===platform)||{};
    return runPlatform(platform,payload,r.runId,r.state);
  }));
  busy=false;startBtn.disabled=false;startBtn.textContent='开始采集';stopBtn.hidden=true;
  const ok=platforms.length-failedPlatforms.size;stateEl.textContent=failedPlatforms.size?'部分失败':'采集完成';
  addLog(`本次采集结束：成功 ${ok}/${platforms.length}，用时 ${((Date.now()-started)/1000).toFixed(1)} 秒`);
  if(lastGroupId)await loadResult(lastGroupId);
  if(failedPlatforms.size){actions.hidden=false;$('retry-btn').hidden=false;}else{$('retry-btn').hidden=true;}
  actions.hidden=false;});
stopBtn.addEventListener('click',async()=>{
  if(!lastGroupId||!busy)return;
  if(!window.confirm('停止本次采集？排队中的平台会取消，正在执行的平台会在当前步骤退出后停止；已取得的结果与证据保留。'))return;
  stopBtn.disabled=true;
  addLog('已请求停止本次采集，等待当前步骤退出');
  try{
    const res=await fetch('/api/bd/runs/'+encodeURIComponent(lastGroupId)+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const data=await res.json();
    if(!res.ok)throw new Error(data.message||data.error||'停止失败');
    addLog(`停止请求已受理：取消排队 ${Number(data.queued||0)} 个，正在执行 ${Number(data.running||0)} 个`);
    await refreshResult();
  }catch(e){stopBtn.disabled=false;toast('停止失败：'+e.message);}
});
$('retry-btn').addEventListener('click',async()=>{if(busy||!lastPayload||!lastGroupId||!failedPlatforms.size)return;  const retry=[...failedPlatforms];failedPlatforms=new Set();busy=true;stateEl.textContent='重跑中';stopBtn.hidden=false;stopBtn.disabled=false;
  for(const platform of retry){
    try {
      const res=await fetch('/api/bd/runs/'+encodeURIComponent(lastGroupId)+'/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:API_PLATFORM[platform]||platform})});
      const data=await res.json();
      if(!res.ok)throw new Error(data.message||data.error||'重试失败');
      await runPlatform(platform,lastPayload,lastGroupId,'queued');
    } catch(e){failedPlatforms.add(platform);setRun(platform,'failed',100,'未重试');addLog(`${PLATFORMS[platform].name} · ${e.message}`);}
  }
  busy=false;const ok=retry.length-failedPlatforms.size;stateEl.textContent=failedPlatforms.size?'仍有失败':'重跑完成';stopBtn.hidden=true;
  addLog(`重跑结束：成功 ${ok}/${retry.length}`);$('retry-btn').hidden=!failedPlatforms.size;});
$('new-btn').addEventListener('click',()=>{runPanel.hidden=true;resetRunView();stateEl.textContent='排队中';form.querySelector('input[name="city"]').focus();});
$('reset-btn').addEventListener('click',()=>{form.reset();runPanel.hidden=true;resetRunView();toast('已清空');});
openResult.addEventListener('click',async()=>{await refreshResult();resultPanel.scrollIntoView({behavior:'smooth',block:'start'});});
$('refresh-result').addEventListener('click',()=>refreshResult());
// 刷新页面后按比较组恢复结果，不重新提交采价。
try{const saved=localStorage.getItem('bd-last-group');if(saved){lastGroupId=saved;loadResult(saved);}}catch{}
form.querySelectorAll('input[name="platform"]').forEach(input=>input.addEventListener('change',()=>{const count=form.querySelectorAll('input[name="platform"]:checked').length;$('form-hint').textContent=count?`已选 ${count} 个平台`:'选择 1–3 个平台';}));
