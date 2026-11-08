import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {SqliteStore} from '../src/infra/sqlite-store.js';
import {connectAndroid} from '../src/adapters/android-transport.js';
import {ReviewedScreen} from '../src/adapters/android-collector.js';
import {openJdStore} from '../src/adapters/jd-shelf-collector.js';
import {EvidenceStore} from '../src/infra/evidence.js';
import type {AndroidSource} from '../src/adapters/android-source.js';
import type {Task,StepUpdate} from '../src/domain/contracts.js';
import {ModelGateway,modelConfig} from '../src/infra/model.js';
const runId=process.argv[2];if(!runId)throw new Error('需要原任务编号');
const db=new SqliteStore('.runtime/observatory.sqlite');
if(Number(db.db.prepare('SELECT COUNT(*) AS n FROM locks').get()?.n)!==0)throw new Error('仍有设备任务运行，不能诊断');
const task=JSON.parse(String(db.db.prepare('SELECT task_json FROM slots WHERE run_id=?').get(runId)?.task_json)) as Task;
if(!task.jdOrigin||!task.specified||task.live?.quantity!==1)throw new Error('仅诊断已登记的指定单品试采');
const source=(JSON.parse(await readFile('.runtime/android-sources.json','utf8')) as AndroidSource[]).find(s=>s.platform==='jd')!;
if(source.device!==task.device_ref||source.account!==task.account_ref)throw new Error('设备或账号已改变');
const signal=AbortSignal.timeout(110_000),device=await connectAndroid(source,signal),steps:StepUpdate[]=[];
const screen=new ReviewedScreen(device,source,{},signal),begun=Date.now(),id=randomUUID();
try{
  const audits:unknown[]=[];
  const model=new ModelGateway(modelConfig(),row=>audits.push(row));
  const verified=await openJdStore(screen,task.jdOrigin,id,signal,model,new EvidenceStore('.runtime/evidence'),s=>{steps.push(s);console.log(JSON.stringify({phase:s.phase,state:s.state,error:s.errorCode}));},true);
  screen.selector('cartEmpty',verified.nodes);
  const record={id,at:new Date().toISOString(),originalRun:runId,elapsedMs:Date.now()-begun,storeVerified:true,cartEmpty:true,noCartModification:true,noVerificationInteraction:true,evidence:verified.evidence,steps,audits};
  await writeFile(`artifacts/specified-pilot/${id}-navigation-probe.json`,JSON.stringify(record,null,2));
  if(process.argv.includes('--resume-after-verified-empty')){
    const event={id:randomUUID(),run_id:runId,slot_id:task.slot_id,kind:'collection',code:'scope_revalidated_after_navigation_probe',at:record.at,details:{probeId:id,storeEvidenceId:verified.evidence.id,originalRunUnchanged:true,noVerificationInteraction:true,reason:'用户重新确认手机交给程序独占；当前已通过同店核验且购物车为空，未遇到验证或访问限制。原验证提示的具体来源未取得原屏证据，不改写原错误。'}};
    db.db.exec('BEGIN IMMEDIATE');
    db.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(event.id,runId,task.slot_id,JSON.stringify(event));
    db.db.prepare('DELETE FROM paused_resources WHERE key IN (?,?) AND code=?').run('account:jd:'+task.account_ref,'device:'+task.device_ref,'scope_paused_after_captcha_required');
    db.db.exec('COMMIT');
  }
  console.log(JSON.stringify({probeId:id,storeVerified:true,cartEmpty:true,elapsedMs:record.elapsedMs,noVerificationInteraction:true}));
}finally{await device.close();db.close();}
