// BD 报价采集页 —— 原型交互。采集流程目前是本地模拟，
// 接后端时把 startCollection(payload) 换成 POST /api/market/runs 并订阅进度即可。
const PLATFORMS={jd:{name:'京东',stages:['启动京东 App','搜索品牌','匹配门店','店内搜索爆品','打开商品详情','点击立即购买','进入结算页','提取价格字段']},
  meituan:{name:'美团',stages:['等待美团接入']},taobao:{name:'淘宝闪购',stages:['等待淘宝闪购接入']}};
const $=id=>document.getElementById(id),sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
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
async function startCollection(payload){return {ok:true};}
async function runPlatform(platform,payload){const stages=PLATFORMS[platform].stages;
  if(platform!=='jd'){setRun(platform,'failed',100,'未接入');addLog(`${PLATFORMS[platform].name}：接口尚未接入，跳过采集`);failedPlatforms.add(platform);return false;}
  for(let i=0;i<stages.length;i++){
    setRun(platform,'running',Math.round((i+1)/stages.length*100),stages[i]);
    addLog(`${PLATFORMS[platform].name} · ${stages[i]}`);
    await sleep(420+Math.random()*380);
    // 原型演示：约一成概率模拟失败，用来验证失败提示与重跑入口
    if(Math.random()<0.12){setRun(platform,'failed',Math.round((i+1)/stages.length*100),'失败');addLog(`${PLATFORMS[platform].name} · 采集失败：页面状态异常（原型模拟）`);failedPlatforms.add(platform);return false;}
  }
  setRun(platform,'success',100,'完成');addLog(`${PLATFORMS[platform].name} · 采集完成：应付 ¥21.10、商品金额 ¥26.00、优惠 ¥12.00、运费 ¥3.00（原型模拟数据）`);return true;}
form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;
  const data=new FormData(form),payload={city:String(data.get('city')||'').trim(),brand:String(data.get('brand')||'').trim(),store:String(data.get('store')||'').trim(),item:String(data.get('item')||'').trim()};
  const platforms=[...form.querySelectorAll('input[name="platform"]:checked')].map(input=>input.value);
  if(!payload.city||!payload.brand||!payload.item){toast('请先填写城市、品牌和爆品名称');return;}
  if(!platforms.length){toast('至少选择一个采集平台');return;}
  lastPayload=payload;busy=true;startBtn.disabled=true;startBtn.textContent='采集中…';resetRunView();runPanel.hidden=false;stateEl.textContent='采集中';
  renderSummary(payload,platforms);addLog(`开始采集：${payload.city} / ${payload.brand} / ${payload.item}，平台 ${platforms.map(p=>PLATFORMS[p].name).join('、')}`);
  const started=Date.now();await startCollection(payload);
  for(const platform of platforms)await runPlatform(platform,payload);
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
