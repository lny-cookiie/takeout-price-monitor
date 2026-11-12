// BD 报价采集页 —— 原型交互。采集流程目前是本地模拟，
// 接后端时把 startCollection(payload) 换成 POST /api/market/runs 并订阅进度即可。
const PLATFORMS={jd:{name:'京东',stages:['启动京东 App','搜索品牌','匹配门店','店内搜索爆品','打开商品详情','点击立即购买','进入结算页','提取价格字段']},
  meituan:{name:'美团',stages:['等待美团接入']},taobao:{name:'淘宝闪购',stages:['等待淘宝闪购接入']}};
const $=id=>document.getElementById(id),sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
// 平台标识映射：前端用简短标识，后端来源配置用完整契约标识 taobao_instant
const API_PLATFORM={jd:'jd',meituan:'meituan',taobao:'taobao_instant'};
const UI_PLATFORM={jd:'jd',meituan:'meituan',taobao_instant:'taobao'};
const form=$('bd-form'),runPanel=$('run-panel'),summary=$('run-summary'),runsBox=$('platform-runs'),logBox=$('run-log'),logCount=$('log-count'),stateEl=$('run-state'),actions=$('run-actions'),openResult=$('open-result'),startBtn=$('start-btn');
let busy=false,failedPlatforms=new Set(),lastPayload=null,logLines=0;
function toast(message){const t=$('bd-toast');t.textContent=message;clearTimeout(t._timer);t._timer=setTimeout(()=>{t.textContent='';},3200);}
function addLog(line){logLines++;logBox.textContent+=`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] ${line}\n`;logBox.scrollTop=logBox.scrollHeight;logCount.textContent=logLines+' 条';}
function resetRunView(){logBox.textContent='';logLines=0;logCount.textContent='0 条';failedPlatforms=new Set();actions.hidden=true;openResult.hidden=true;runsBox.innerHTML='';summary.innerHTML='';}
function renderSummary(payload,platforms){summary.innerHTML=`<div><span>城市 / 品牌</span><strong>${esc(payload.city)} · ${esc(payload.brand)}</strong></div>
<div><span>门店</span><strong>${payload.store?esc(payload.store):'同城自动匹配'}</strong></div>
<div><span>爆品</span><strong>${esc(payload.item)}</strong></div>`;
  runsBox.innerHTML=platforms.map(p=>`<div class="platform-run" id="run-${p}" data-platform="${p}"><span class="pr-name">${PLATFORMS[p].name}</span><span class="pr-bar"><i></i></span><span class="pr-state">排队中</span></div>`).join('');}
function setRun(platform,state,percent,label){const row=document.getElementById('run-'+platform);if(!row)return;row.className='platform-run '+state;row.querySelector('.pr-bar i').style.width=percent+'%';row.querySelector('.pr-state').textContent=label;}
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
// 接后端时替换这里：POST /api/market/runs 返回 runId，再用 /api/market/runs/{id} 轮询。
async function startCollection(payload,platforms){
  const res = await fetch('/api/bd/runs',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({city:payload.city,brand:payload.brand,store:payload.store||'',item:payload.item,platforms:platforms.map(p=>API_PLATFORM[p]||p)})});
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
const STAGE_LABELS={home:'进入首页',takeout:'打开外卖频道',search:'搜索品牌名',results:'进入门店结果页',store:'进入店铺',item:'定位爆品',cart:'加购结算',done:'采数完成'};
async function runPlatform(platform,payload,runId,state){
  if(!runId||state==='not_integrated'||state==='not_licensed'){
    const label = state==='not_licensed' ? '待授权' : state==='not_integrated' ? '未接入' : '未启动';
    setRun(platform,'failed',100,label);
    addLog(`${PLATFORMS[platform].name}：${state==='not_licensed'?'采集许可未满足，需补书面授权后才能发起':state==='not_integrated'?'采集链路尚未接入调度':'任务未创建'}`);
    failedPlatforms.add(platform);return false;}
  setRun(platform,'running',5,'已提交');
  let last='';
  for(let i=0;i<120;i++){
    const data=await pollRun(runId).catch(()=>null);
    if(!data){await sleep(1000);continue;}
    const steps=(data.slots||[]).flatMap(s=>(s.attempts||[]).map(a=>({state:a.state,phases:(a.steps||[]).map(x=>x.phase||x.name)})));
    const phases=steps.flatMap(s=>s.phases||[]).map(String);
    const percent=Math.min(95,Math.round(phases.length/8*95));
    const label=(phases.length?STAGE_LABELS[phases[phases.length-1]]:null)||'采集中';
    if(label!==last){last=label;setRun(platform,'running',percent,label);addLog(`${PLATFORMS[platform].name} · ${label}`);}
    const done=steps.find(s=>s.state==='succeeded'), bad=steps.find(s=>s.state==='failed');
    if(bad){setRun(platform,'failed',percent,'失败');addLog(`${PLATFORMS[platform].name} · 采集失败`);failedPlatforms.add(platform);return false;}
    if(done){setRun(platform,'success',100,'完成');addLog(`${PLATFORMS[platform].name} · 采集完成`);return true;}
    await sleep(1500);
  }
  setRun(platform,'failed',100,'超时');addLog(`${PLATFORMS[platform].name} · 等待超时`);failedPlatforms.add(platform);return false;}
form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;
  const data=new FormData(form),payload={city:String(data.get('city')||'').trim(),brand:String(data.get('brand')||'').trim(),store:String(data.get('store')||'').trim(),item:String(data.get('item')||'').trim()};
  const platforms=[...form.querySelectorAll('input[name="platform"]:checked')].map(input=>input.value);
  if(!payload.city||!payload.brand||!payload.item){toast('请先填写城市、品牌和爆品名称');return;}
  if(!platforms.length){toast('至少选择一个采集平台');return;}
  lastPayload=payload;busy=true;startBtn.disabled=true;startBtn.textContent='采集中…';resetRunView();runPanel.hidden=false;stateEl.textContent='采集中';
  renderSummary(payload,platforms);addLog(`开始采集：${payload.city} / ${payload.brand} / ${payload.item}，平台 ${platforms.map(p=>PLATFORMS[p].name).join('、')}`);
  const started=Date.now();
  let created={platforms:[]};
  try{created=await startCollection(payload,platforms);}
  catch(e){toast('提交失败：'+e.message);busy=false;startBtn.disabled=false;startBtn.textContent='开始采集';addLog('提交失败：'+e.message);return;}
  if(created.matched)addLog(`匹配到：${created.matched.storeName} · ${created.matched.itemName}`);
  for(const platform of platforms){const r=(created.platforms||[]).find(x=>UI_PLATFORM[x.platform]===platform)||{};await runPlatform(platform,payload,r.runId,r.state);}
  busy=false;startBtn.disabled=false;startBtn.textContent='开始采集';
  const ok=platforms.length-failedPlatforms.size;stateEl.textContent=failedPlatforms.size?'部分失败':'采集完成';
  addLog(`本次采集结束：成功 ${ok}/${platforms.length}，用时 ${((Date.now()-started)/1000).toFixed(1)} 秒（原型模拟）`);
  if(ok>0){openResult.hidden=false;}
  if(failedPlatforms.size){actions.hidden=false;$('retry-btn').hidden=false;}else{$('retry-btn').hidden=true;}
  actions.hidden=false;});
$('retry-btn').addEventListener('click',async()=>{if(busy||!lastPayload||!failedPlatforms.size)return;
  const retry=[...failedPlatforms];failedPlatforms=new Set();busy=true;stateEl.textContent='重跑中';
  for(const platform of retry)await runPlatform(platform,lastPayload);
  busy=false;const ok=retry.length-failedPlatforms.size;stateEl.textContent=failedPlatforms.size?'仍有失败':'重跑完成';
  addLog(`重跑结束：成功 ${ok}/${retry.length}`);$('retry-btn').hidden=!failedPlatforms.size;});
$('new-btn').addEventListener('click',()=>{runPanel.hidden=true;resetRunView();stateEl.textContent='排队中';form.querySelector('input[name="city"]').focus();});
$('reset-btn').addEventListener('click',()=>{form.reset();runPanel.hidden=true;resetRunView();toast('已清空');});
openResult.addEventListener('click',()=>{location.href='/ue';});
form.querySelectorAll('input[name="platform"]').forEach(input=>input.addEventListener('change',()=>{const count=form.querySelectorAll('input[name="platform"]:checked').length;$('form-hint').textContent=count?`已选 ${count} 个平台`:'选择 1–3 个平台';}));
