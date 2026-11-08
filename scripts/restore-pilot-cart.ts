import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {SqliteStore} from '../src/infra/sqlite-store.js';
import {connectAndroid} from '../src/adapters/android-transport.js';
import {ReviewedScreen} from '../src/adapters/android-collector.js';
import {EvidenceStore} from '../src/infra/evidence.js';
import {returnToJdMenu} from '../src/adapters/jd-shelf-collector.js';
import type {AndroidSource} from '../src/adapters/android-source.js';
import type {Task} from '../src/domain/contracts.js';
const runId=process.argv[2];if(!runId)throw new Error('需要原任务编号');
const db=new SqliteStore('.runtime/observatory.sqlite');
const record=db.db.prepare('SELECT task_json FROM slots WHERE run_id=?').get(runId);
const task=JSON.parse(String(record?.task_json)) as Task;
if(!task.specified||task.live?.quantity!==1)throw new Error('仅处理有加购记录的指定单品任务');
const source=(JSON.parse(await readFile('.runtime/android-sources.json','utf8')) as AndroidSource[]).find(s=>s.platform==='jd')!;
if(source.device!==task.device_ref||source.account!==task.account_ref)throw new Error('设备或账号变化');
const device=await connectAndroid(source,AbortSignal.timeout(70_000)),signal=AbortSignal.timeout(60_000),item=task.live.target.supply.item;
const screen=new ReviewedScreen(device,source,{item:item.name,spec:item.spec,quantity:'1',store:task.live.target.supply.store.name,address:task.live.target.supply.store.address},signal);
const started=Date.now();
try{
  let nodes=await screen.nodes();
  if(screen.selector('checkoutStage',nodes,false)){await screen.device.back();nodes=await screen.nodes();}
  if(!screen.selector('cartEmpty',nodes,false)){
    if(!screen.cartNodes(nodes,false)){await screen.tap('cart',nodes);nodes=await screen.waitFor(['cartLine','quantity'],{inCart:true});}
    screen.selector('cartCount',nodes);
    const inside=screen.cartNodes(nodes);screen.selector('cartLine',inside);screen.selector('quantity',inside);
    await screen.tap('remove',inside);nodes=await screen.waitFor(['cartEmpty']);
  }
  const empty=screen.selector('cartEmpty',nodes)!,frame=await screen.capture([empty]);
  const proof=await new EvidenceStore('.runtime/evidence').save(randomUUID(),'cart_restored',frame.image,'指定单品试采补充恢复：已核对空购物车','live',frame.at);
  const event={id:randomUUID(),run_id:runId,slot_id:task.slot_id,kind:'collection',code:'corrective_cart_restored',at:new Date().toISOString(),details:{originalRunUnchanged:true,evidenceId:proof.id,elapsedMs:Date.now()-started}};
  db.db.exec('BEGIN IMMEDIATE');
  db.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(event.id,runId,task.slot_id,JSON.stringify(event));
  db.db.prepare('DELETE FROM paused_resources WHERE key IN (?,?)').run('account:jd:'+task.account_ref,'device:'+task.device_ref);db.db.exec('COMMIT');
  await writeFile(`artifacts/specified-pilot/${runId}-corrective-restoration.json`,JSON.stringify({event,proof},null,2));
  console.log(JSON.stringify({restored:true,elapsedMs:Date.now()-started,evidenceId:proof.id,originalRunUnchanged:true}));
  await returnToJdMenu(screen,signal).catch(()=>{});
}finally{await device.close();db.close();}
