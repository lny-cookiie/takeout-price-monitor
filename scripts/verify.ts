import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../src/http/app.js';
import { BrowserPool } from '../src/infra/browser.js';
import { EvidenceStore } from '../src/infra/evidence.js';
import { meituanCollector } from '../src/adapters/fixture-collector.js';
import { jdColumns } from '../src/ui/jd-import.js';
import { sourceFingerprint } from '../src/infra/fingerprint.js';
import { STORES, makeTask } from '../src/domain/catalog.js';
import type { Snapshot } from '../src/application/ports.js';
import type { Scenario, Slot } from '../src/domain/contracts.js';

const root=process.cwd(), artifacts=resolve(root,'artifacts');
await mkdir(artifacts,{recursive:true});
const cases:{name:string;passed:boolean;detail:string}[]=[];
async function check(name:string,detail:string,fn:()=>Promise<void>|void){
  try { await fn();cases.push({name,detail,passed:true});console.log('PASS',name); }
  catch(e){cases.push({name,detail:String(e),passed:false});throw e;}
}
const tests=readdirSync(join(root,'tests')).filter(f=>f.endsWith('.test.ts')).map(f=>join('tests',f));
const unit=spawnSync(process.execPath,[join(root,'node_modules','tsx','dist','cli.mjs'),'--test','--test-concurrency=1',...tests],{cwd:root,encoding:'utf8',timeout:90_000});
await writeFile(join(artifacts,'unit-tests.txt'),unit.stdout+'\n'+unit.stderr);
await check('契约、互斥、持久化与重启恢复','独立单元测试：金额、未知值、同账号锁、重试分母、时区、重启与漏采',()=>assert.equal(unit.status,0,unit.stdout+'\n'+unit.stderr));
const dataDir=await mkdtemp(join(tmpdir(),'observatory-e2e-'));
const app=await createApplication({root,dataDir,port:0,model:null});
const uiBrowser=new BrowserPool();
const request=async(path:string,method='GET',value?:unknown)=>{
  const r=await fetch(app.baseUrl+path,{method,headers:{'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
  const body=await r.json();assert.ok(r.ok,JSON.stringify(body));return body;
};
const get=async(id:string):Promise<Snapshot>=>request('/api/state?run='+encodeURIComponent(id));
async function run(scenario:Scenario,delay=0):Promise<Snapshot>{
  const b=await request('/api/runs','POST',{scenario,delay_seconds:delay});
  const until=Date.now()+100_000;
  while(Date.now()<until){const s=await get(b.run_id);if(s.slots.length===12 && s.slots.every((s:Slot)=>!['queued','running'].includes(s.state)))return s;await new Promise(r=>setTimeout(r,400));}
  throw new Error('run_timeout:'+scenario);
}
let baseline:Snapshot;
try {
  await check('定时选店、选规格、组篮、结算和取价','真实 Chromium 操作两套自有页面；3 店×2 篮×2 平台，12 个报价逐分核对固定真值',async()=>{
    const started=Date.now();baseline=await run('baseline',2);assert.ok(Date.now()-started>=2000);
    assert.equal(baseline.observations.length,12);assert.ok(baseline.slots.every(s=>s.result?.status==='success'));
    // Independent golden values. Do not derive these with the storefront's price calculator.
    const golden:Record<string,number>={'rice-single':2200,'rice-set':3300,'coffee-single':2400,'coffee-pair':4300,'noodle-single':2800,'noodle-set':3600};
    for(const o of baseline.observations){assert.equal(o.amount_fen,golden[o.basket_id]!-(o.platform==='taobao_instant'?200:0));assert.equal(o.value_origin,'synthetic');assert.ok(o.basket_items.every(i=>i.variant && i.quantity>0));}
    for(const s of baseline.slots){const phases=s.result!.trace.map(t=>t.phase);for(const p of ['store','menu','variants','cart','checkout','quote','publish','cleanup'])assert.ok(phases.includes(p));assert.equal(s.result!.cleanup,'restored');}
    for(const group of new Set(baseline.slots.map(s=>s.task.comparison_group_id))){const times=baseline.slots.filter(s=>s.task.comparison_group_id===group).map(s=>Date.parse(s.result!.observation!.observed_at));assert.ok(Math.max(...times)-Math.min(...times)<=300_000);}
    assert.equal(baseline.events.filter(e=>e.code==='price_changed').length,0);
  });
  await check('证据与操作轨迹','保存实际结算截图、同屏文本及 SHA-256，证据引用可通过工作台读取',async()=>{
    for(const o of baseline!.observations){const e=o.evidence_refs[0]!;const r=await fetch(app.baseUrl+e.screenshot);assert.equal(r.status,200);const png=Buffer.from(await r.arrayBuffer());assert.equal(createHash('sha256').update(png).digest('hex'),e.sha256);const text=await (await fetch(app.baseUrl+e.text_file)).json();assert.ok(text.text.includes(o.raw_value));assert.ok(text.text.includes('模拟'));}
  });
  await check('工作台交互与桌面/手机布局','打开批次、执行记录、截图详情、计划和验证页，检查浏览器错误及横向溢出',async()=>{
    const browser=await uiBrowser.get();const page=await browser.newPage({viewport:{width:1440,height:1080}});const errors:string[]=[];
    page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(app.baseUrl);await page.getByRole('heading',{name:'还没有监测记录',exact:true}).waitFor();
    await page.getByRole('button',{name:'先试用（无需京东订单）',exact:true}).click();
    const start=page.waitForResponse(r=>r.url().endsWith('/api/runs') && r.request().method()==='POST');
    await page.getByRole('button',{name:'运行模拟采集',exact:true}).click();
    const {run_id:demoRun}=await (await start).json();
    await page.locator(`select[name="run"] option[value="${demoRun}"]:checked`).waitFor({state:'attached'});
    const demo=await request('/api/comparisons?mode=synthetic&run='+demoRun);
    assert.equal(demo.stats.planned,12);
    assert.equal((await request('/api/comparisons')).rows.length,0);
    await page.getByText('已取得结算金额 12 条',{exact:true}).waitFor({timeout:40_000});
    await page.getByRole('columnheader',{name:'美团',exact:true}).waitFor();
    assert.equal(await page.getByRole('columnheader',{name:'京东外卖',exact:true}).count(),0);
    await page.screenshot({path:join(artifacts,'dashboard-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'¥22.00',exact:true}).first().click();
    await page.getByRole('dialog').locator('img').waitFor();
    assert.ok((await page.getByRole('dialog').innerText()).includes('结算应付'));
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:'监测设置',exact:true}).click();
    await page.getByRole('button',{name:'采集计划',exact:true}).click();
    await page.getByRole('heading',{name:'先设置监测商品、配送与账号',exact:true}).waitFor();
    await page.getByRole('button',{name:'数据记录',exact:true}).click();
    await page.getByRole('button',{name:'连接设置',exact:true}).click();
    await page.getByRole('heading',{name:'Android 设备与采集入口',exact:true}).waitFor();
    await page.getByRole('button',{name:'三平台对比',exact:true}).click();
    await page.getByRole('columnheader',{name:'淘宝闪购',exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:join(artifacts,'dashboard-mobile.png'),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'mobile_horizontal_overflow');assert.deepEqual(errors,[]);await page.close();
  });
  await check('报价变化监控','同场景第二轮应付增加 200 分，每个购物篮产生一条带前后记录的事件',async()=>{
    const changed=await run('price_change');assert.equal(changed.observations.length,12);const events=changed.events.filter(e=>e.code==='price_changed');assert.equal(events.length,12);assert.ok(events.every(e=>e.details.delta_fen===200));
  });
  await check('业务无报价与字段缺失','菜单售罄、结算未达起送、部分费用不可见分别处理；未知费用为 null，总额仍可用',async()=>{
    const mixed=await run('mixed');const mt=mixed.slots.filter(s=>s.task.platform==='meituan'),tb=mixed.slots.filter(s=>s.task.platform==='taobao_instant');
    assert.equal(mt.filter(s=>s.result?.observation?.quote_valid).length,4);assert.equal(mt.filter(s=>s.result?.status==='unavailable').length,2);
    for(const s of mt.filter(s=>s.task.store_id==='coffee')){assert.equal(s.result!.status,'partial');assert.equal(s.result!.observation!.components.delivery_fee.amount_fen,null);assert.equal(s.result!.observation!.missing_reasons.delivery_fee,'not_visible');}
    assert.equal(tb.filter(s=>s.result?.availability==='minimum_not_met').length,2);assert.equal(tb.filter(s=>s.result?.error_code==='schema_changed').length,2);
    const browser=await uiBrowser.get();const page=await browser.newPage({viewport:{width:1440,height:1080}});await page.goto(app.baseUrl);await page.getByRole('button',{name:'模拟演练',exact:true}).click();await page.getByRole('columnheader',{name:'美团',exact:true}).waitFor();await page.screenshot({path:join(artifacts,'dashboard-exceptions.png'),fullPage:true});await page.close();
    const captcha=tb.filter(s=>s.result?.error_code==='captcha_required');assert.equal(captcha.length,1);assert.equal(tb.filter(s=>s.state==='source_blocked').length,1);
    assert.ok(mixed.observations.every(o=>o.amount_fen!==0));
  });
  await check('验证码暂停与页面改版识别','验证码出现后停止当前模拟会话，不解锁、不换身份；改版返回 schema_changed，不猜价',async()=>{
    const s=app.store.snapshot();assert.equal(s.slots.filter(s=>s.result?.error_code==='captcha_required').length,1);assert.equal(s.slots.filter(s=>s.result?.error_code==='schema_changed').length,2);assert.equal(s.slots.filter(s=>s.state==='source_blocked').length,1);
  });
  await check('有限重试与统计分母','实际模拟 HTTP 503 后各重试一次；12 个槽位、24 次尝试，保留第一次失败',async()=>{
    const s=await run('network_retry');assert.equal(s.observations.length,12);assert.equal(s.slots.length,12);assert.equal(s.attempts.length,24);assert.ok(s.slots.every(s=>s.attempts===2));assert.equal(s.attempts.filter(a=>a.result?.error_code==='network_error').length,12);
  });
  await check('购物车归属与副作用边界','遇到已有其他使用者购物车时停止，两个平台均不进入加购；不操作提交订单',async()=>{
    const s=await run('cart_conflict');assert.equal(s.observations.length,0);assert.equal(s.attempts.length,2);assert.ok(s.attempts.every(a=>a.result?.error_code==='cart_not_owned' && a.result.cleanup==='untouched' && !a.result.trace.some(t=>t.phase==='cart')));
  });
  await check('零元与未知值分开','本地零元结算页取得 12 条真实零值；没有用 0 替代缺失或失败',async()=>{
    const s=await run('zero_quote');assert.equal(s.observations.length,12);assert.ok(s.observations.every(o=>o.amount_fen===0 && o.raw_value==='¥0.00'));
  });
  await check('真实来源与接口边界','拒绝 live 开关、外部来源、跨站写入及任意额外动作；真实平台请求为零',async()=>{
    const r=await fetch(app.baseUrl+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario:'baseline',data_mode:'live'})});assert.equal(r.status,400);
    const cross=await fetch(app.baseUrl+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://outside.invalid'},body:JSON.stringify({scenario:'baseline'})});assert.equal(cross.status,403);
    const t=makeTask('live-test','meituan',STORES[0]!,STORES[0]!.baskets[0]!.id,'baseline',new Date(),'live-test-g');
    const collector=meituanCollector(app.baseUrl,new BrowserPool(),new EvidenceStore(join(dataDir,'unused')));
    const blocked=await collector.collect({...t,source_id:'MT_FRONTEND',data_mode:'live',entry_point:'unverified_actual_app'},'test',new AbortController().signal);
    assert.equal(blocked.error_code,'live_source_not_ready');assert.equal(blocked.evidence,null);assert.equal(blocked.status,'blocked');
  });
  await check('业务流程：导入预览、匹配拦截、三平台计划和导出','隔离的业务测试数据。历史实付不进入报价，未登记的来源显示受限，CSV 保留三个计划结果',async()=>{
    const browser=await uiBrowser.get(), page=await browser.newPage({viewport:{width:1440,height:1000}});
    const supply={store:{key:'test-01',brand:'回放咖啡',name:'回放咖啡测试店',city:'回放市',address:'测试路1号'},
      item:{key:'sku-01',name:'回放拿铁',kind:'single',spec:'500ml',options:[],parts:null}};
    const records=jdColumns.join(',')+'\r\norder-01,test-01,回放咖啡,回放咖啡测试店,回放市,测试路1号,sku-01,回放拿铁,单品,500ml,无,,2230,2026-11-02 12:00:00,本地测试资料\r\n';
    await page.goto(app.baseUrl);
    await page.getByRole('button',{name:'导入京东资料',exact:true}).click();
    await page.locator('#order-file').setInputFiles({name:'本地验证订单.csv',mimeType:'text/csv',buffer:Buffer.from(records)});
    await page.getByText('本地验证订单.csv · 1 条记录',{exact:true}).waitFor();
    await page.getByRole('button',{name:'确认导入',exact:true}).click();
    await page.getByRole('cell',{name:'¥22.30',exact:true}).waitFor();
    assert.equal((await request('/api/comparisons')).rows.length,0);
    const {targets}=await request('/api/workspace'), target=targets[0];
    const mismatched=structuredClone(supply);mismatched.store.address='测试路2号';
    const {proposed}=await request('/api/matches/propose','POST',{targetId:target.id,candidates:[{platform:'meituan',entry:'测试入口',reference:'本地证据',supply:mismatched}]});
    assert.equal(proposed[0].store.relation,'similar');
    const refusal=await fetch(app.baseUrl+'/api/mappings/'+proposed[0].id+'/decision',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({verified:true})});
    assert.equal(refusal.status,400);
    await page.getByRole('button',{name:'监测设置',exact:true}).click();
    await page.getByRole('button',{name:'配送与账号',exact:true}).click();
    await page.getByLabel('这组设置叫什么').fill('回放账号');
    await page.getByLabel('配送城市',{exact:true}).fill('回放市');
    await page.getByLabel('配送地址简称',{exact:true}).fill('测试园区东门');
    const account=page.getByRole('group',{name:'美团',exact:true}).first();
    await account.getByLabel('对这个平台是新客还是老客').selectOption('existing');
    await account.getByLabel('会员状态',{exact:true}).fill('非会员');
    await page.getByRole('button',{name:'保存配送与账号',exact:true}).click();
    await page.getByText('已填写美团的账号信息，请补上接入时登记的测试账号名称。',{exact:true}).waitFor();
    await account.getByLabel('测试账号名称',{exact:true}).fill('美团测试手机');
    await account.getByLabel('账号核对记录编号',{exact:true}).fill('账号核对-01');
    await page.getByText('回放咖啡测试店 · 测试路1号',{exact:true}).click();
    const shop=page.locator('details').filter({has:page.getByLabel('门店核对记录编号')}).getByRole('group',{name:'美团',exact:true});
    await shop.getByLabel('对这家店是新客还是老客').selectOption('existing');
    await shop.getByLabel('门店核对记录编号',{exact:true}).fill('门店核对-01');
    await page.getByLabel('实际核对时间（北京时间）').fill('2026-11-06T10:00');
    await page.getByLabel('核对记录有效到（北京时间）').fill('2026-11-09T22:00');
    await page.getByRole('button',{name:'保存配送与账号',exact:true}).click();
    await page.getByRole('heading',{name:'已保存的配送与账号',exact:true}).waitFor();
    const {profiles}=await request('/api/workspace');
    assert.equal(profiles[0].point,'测试园区东门');
    assert.equal(profiles[0].eligibility.meituan.memberSegment,'非会员');
    assert.equal(profiles[0].storeQualifications[0].evidence,'门店核对-01');
    await page.getByRole('button',{name:'采集计划',exact:true}).click();
    await page.getByLabel('计划名称',{exact:true}).fill('本地试点验证');
    await page.getByRole('checkbox',{name:/回放拿铁/}).check();
    assert.equal(await page.getByLabel('午餐',{exact:true}).inputValue(),'11:30');
    await page.getByText(/真实采集开始前.*通过 USB 连接/).waitFor();
    await page.getByRole('button',{name:'保存计划',exact:true}).click();
    const start=page.waitForResponse(r=>r.url().endsWith('/api/market/runs') && r.request().method()==='POST');
    await page.getByRole('button',{name:'立即采集',exact:true}).click();
    const {run:marketRun}=await (await start).json();
    await page.getByRole('columnheader',{name:'京东外卖',exact:true}).waitFor();
    await page.getByRole('button',{name:'受限',exact:true}).first().waitFor();
    const data=await request('/api/comparisons?run='+marketRun);
    assert.equal(data.stats.blocked,3);
    assert.equal(data.stats.quoted,0);
    assert.equal(data.rows[0].lowestFen,null);
    const csv=await (await fetch(app.baseUrl+'/api/comparisons.csv?run='+marketRun)).text();
    assert.ok(csv.includes('JD_FRONTEND') && csv.includes('TB_FRONTEND'));
    assert.ok(!csv.includes('2230'));
    await page.screenshot({path:join(artifacts,'dashboard-live-preflight.png'),fullPage:true});
    await page.close();
  });
  await check('京东一键采集表单与执行日志','浏览器填写门店和配送账号并提交，后台记录来源受限，历史任务可重新打开，无京东历史订单依赖',async()=>{
    const browser=await uiBrowser.get(), page=await browser.newPage({viewport:{width:390,height:844}});
    try {
      await request('/api/market/profiles','PUT',{id:'jd-browser-fixture',name:'京东测试条件',city:'回放市',point:'测试园区东门',
        eligibility:{jd:{accountRef:'jd-browser-only',platformCustomer:'unknown',storeCustomer:'unknown',memberSegment:'',memberProduct:'',memberTier:'',benefits:[],evidence:'仅浏览器回放'}}});
      await page.goto(app.baseUrl);
      await page.getByRole('button',{name:'监测设置',exact:true}).click();
      await page.getByRole('button',{name:'京东采集',exact:true}).click();
      await page.getByLabel('城市',{exact:true}).fill('回放市');
      await page.getByLabel('区或县',{exact:true}).fill('回放区');
      await page.getByLabel('品牌',{exact:true}).fill('回放品牌');
      await page.getByLabel('完整分店名',{exact:true}).fill('回放品牌（东门店）');
      assert.equal(await page.getByLabel('门店营业地址',{exact:true}).count(),0);
      await page.getByRole('button',{name:'保存负责门店',exact:true}).click();
      await page.getByLabel('负责门店',{exact:true}).waitFor();
      await page.reload();
      await page.getByRole('button',{name:'监测设置',exact:true}).click();
      await page.getByRole('button',{name:'京东采集',exact:true}).click();
      assert.match(await page.getByLabel('负责门店',{exact:true}).locator('option:checked').innerText(),/回放品牌/);
      await page.getByLabel('配送地址与测试账号',{exact:true}).selectOption('jd-browser-fixture');
      const posted=page.waitForResponse(r=>r.url().endsWith('/api/market/jd-runs') && r.request().method()==='POST');
      await page.getByRole('button',{name:'开始采集',exact:true}).click();
      const response=await posted;assert.equal(response.status(),202);
      const {runId}=await response.json();
      await page.getByRole('heading',{name:'执行日志',exact:true}).waitFor();
      await page.getByText('分店核对与菜单扫描 · 受限',{exact:true}).click();
      await page.getByText('采集入口未获准或使用范围已到期',{exact:true}).first().waitFor();
      await page.reload();
      await page.getByRole('button',{name:'数据记录',exact:true}).click();
      await page.getByRole('heading',{name:'京东爆品 · 回放品牌（东门店）',exact:true}).waitFor();
      const detail=await request('/api/market/runs/'+runId);
      assert.deepEqual(detail.slots[0].attempts[0].steps.map((step:{phase:string;state:string})=>[step.phase,step.state]),
        [['worker','started'],['source_check','started'],['source_check','blocked'],['worker','blocked']]);
      assert.equal(detail.slots[0].observation,null);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'jd_mobile_horizontal_overflow');
    } finally { await page.close(); }
  });
} catch(e){console.error(e);process.exitCode=1;}
finally {
  await uiBrowser.close();await app.close();
  const report={version:'0.2.6',executed_at:new Date().toISOString(),source_hash:sourceFingerprint(root),passed:cases.every(c=>c.passed),data_mode:'synthetic',real_platform_requests:0,external_model_calls:0,test_data_directory:dataDir,cases};
  await writeFile(join(artifacts,'verification.json'),JSON.stringify(report,null,2));
  await writeFile(join(artifacts,'验证结果.md'),'# 工作台本地回归结果\n\n'+`执行时间 ${report.executed_at}。\n\n`+cases.map(c=>`- ${c.passed?'通过':'失败'} · ${c.name}。 ${c.detail}`).join('\n')+'\n\n本报告记录自有模拟页面、京东 Android 页面回放及 HTTP 模型测试替身。真机和真实模型单独验收。\n');
  console.log('Verification report:',join(artifacts,'verification.json'));console.log('Isolated test database:',dataDir);
}
