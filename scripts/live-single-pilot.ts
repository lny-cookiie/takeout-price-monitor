import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {BrowserPool} from '../src/infra/browser.js';
import type {AndroidSource} from '../src/adapters/android-source.js';
import type {Workspace} from '../src/ui/presentation.js';
import type {CatalogEntry} from '../src/domain/monitor-catalog.js';
import type {CollectionRun} from '../src/ui/jd-runs.js';
import {connectAndroid} from '../src/adapters/android-transport.js';
import {ReviewedScreen} from '../src/adapters/android-collector.js';
const base=process.env.PILOT_BASE_URL??'http://127.0.0.1:4318',directory=resolve('artifacts/specified-pilot');
await mkdir(directory,{recursive:true});
const source=(JSON.parse(await readFile('.runtime/android-sources.json','utf8')) as AndroidSource[]).find(s=>s.platform==='jd')!;
const ws=await (await fetch(base+'/api/workspace')).json() as Workspace;
const store=ws.jdStores?.find(s=>s.id===source.jdShelf?.pilot?.storeId);
if(!store)throw new Error('找不到已登记的本机试点门店');
const profile=ws.profiles.find(p=>p.point===source.point&&p.eligibility.jd?.accountRef===source.account);
if(!profile)throw new Error('手机当前账号与配送条件未登记');
let preparationMs=0;
if(process.argv.includes('--from-home')){
  const begun=Date.now(),signal=AbortSignal.timeout(40_000),device=await connectAndroid(source,signal),screen=new ReviewedScreen(device,source,{},signal);
  // 预热从京东首页开始，首页在活动期持续刷新，dump 会等不到空闲；先用 u2 即时快照。
  await device.setTreeMode?.('u2').catch(()=>undefined);
  try{await screen.device.launch(true);await screen.waitFor(['channel'],{onLaunch:true,timeoutMs:20_000});preparationMs=Date.now()-begun;}finally{await device.close();}
}
const response=await fetch(base+'/api/market/catalog/imports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'commit',source:'trial',records:[{city:store.city,district:store.district,brand:store.brand,storeName:store.storeName,itemName:'板烧鸡腿堡',spec:'1人份',options:[],is_baoxiao:null}]})});
if(!response.ok)throw new Error('试采商品保存失败：'+await response.text());
const entry=(await response.json() as {entries:CatalogEntry[]}).entries[0]!;
const pool=new BrowserPool(),browser=await pool.get(),page=await browser.newPage({viewport:{width:1480,height:1060}});
let runId='';
try{
  await page.goto(base+'/ue?collection=1');
  await page.locator('#catalog-run select[name="target"] option').filter({hasText:'板烧鸡腿堡'}).waitFor({state:'attached'});
  await page.selectOption('#catalog-run [name="target"]',entry.id);
  await page.selectOption('#catalog-run [name="profile"]',profile.id);
  if(process.argv.includes('--allow-coupon-checkout'))await page.locator('#catalog-run [name="allowCouponCheckout"]').check();
  await page.screenshot({path:resolve(directory,'before.png'),fullPage:true});
  const posted=page.waitForResponse(r=>r.url().endsWith('/api/market/jd-runs')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'开始采集',exact:true}).click();
  const start=await posted;if(start.status()!==202)throw new Error(await start.text());
  runId=(await start.json()).runId;console.log(JSON.stringify({started:true,runId,item:'板烧鸡腿堡',spec:'1人份'}));
  const end=Date.now()+240_000;let report:CollectionRun|undefined,last='';
  while(Date.now()<end){
    report=await (await fetch(base+'/api/market/runs/'+runId)).json() as CollectionRun;
    const step=report.slots[0]?.attempts[0]?.steps.at(-1),phase=step?step.phase+':'+step.state:report.state;
    if(phase!==last){console.log(JSON.stringify({runId,phase}));last=phase;}
    if(!['queued','running'].includes(report.state))break;
    await new Promise(ok=>setTimeout(ok,1500));
  }
  if(!report)throw new Error('未取得运行记录');
  await writeFile(resolve(directory,runId+'.json'),JSON.stringify(report,null,2));
  await page.screenshot({path:resolve(directory,runId+'-workbench.png'),fullPage:true});
  if(['queued','running'].includes(report.state))throw new Error('任务尚未结束，已保存当前记录，停止后续试采');
  console.log(JSON.stringify({runId,state:report.state,preparationMs,elapsedMs:report.elapsedMs,slot:report.slots.map(s=>({status:s.status,error:s.error,cleanup:s.cleanup,quoteMs:s.quoteMs,amountFen:s.observation?.amount_fen,menuFen:s.menuPrices.find(p=>p.kind==='display_current')?.fen,components:s.observation?.details?.components,missing:s.observation?.details?.missing,timings:s.timings}))}));
}finally{await page.close();await pool.close();}
