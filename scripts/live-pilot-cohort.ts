import {spawn} from 'node:child_process';
import {writeFile,mkdir,access,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PAGE_RULESET_VERSION} from '../src/domain/page-ontology.js';
const out=resolve('artifacts/specified-pilot'),at=new Date().toISOString(),id=at.replace(/[:.]/g,'-');await mkdir(out,{recursive:true});
const count=Number(process.env.PILOT_COHORT_COUNT??20);if(!Number.isInteger(count)||count<1||count>20)throw new Error('计划次数应为 1–20');
const selectedGroup=process.env.PILOT_COHORT_GROUP;
if(selectedGroup&&!['warm','from_jd_home'].includes(selectedGroup))throw new Error('测试场景应为 warm 或 from_jd_home');
const alternating=process.env.PILOT_COHORT_ORDER==='alternating';
const plan=Array.from({length:count},(_,i)=>({number:i+1,group:selectedGroup??(alternating?(i%2===0?'from_jd_home':'warm'):(i<10?'warm':'from_jd_home')),state:'planned',runId:null as string|null,result:null as Record<string,unknown>|null}));
const file=resolve(out,'cohort-'+id+'.json');
const version=(JSON.parse(await readFile('package.json','utf8')) as {version:string}).version;
const save=()=>writeFile(file,JSON.stringify({mode:'real_android_frontend_initiated',appVersion:version,rulesetVersion:PAGE_RULESET_VERSION,startedAt:at,planned:count,plan},null,2));
await save();console.log(JSON.stringify({cohort:id,planned:count,file}));
for(const item of plan){
  if(await access(resolve(out,'stop-after-current')).then(()=>true,()=>false)){for(const pending of plan.filter(p=>p.state==='planned')){pending.state='not_run';pending.result={reason:'收到停止信号，保留全部计划，未打断手机当前任务'};}await save();break;}
  item.state='running';await save();console.log(JSON.stringify({number:item.number,group:item.group,state:'running'}));
  const child=spawn(process.execPath,['--env-file=.env','--import','tsx','scripts/live-single-pilot.ts','--allow-coupon-checkout',...(item.group==='from_jd_home'?['--from-home']:[])],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=String(c));child.stderr.on('data',c=>stderr+=String(c));
  const code=await new Promise<number|null>((ok,no)=>{child.once('error',no);child.once('exit',ok);});
  await writeFile(resolve(out,`cohort-${id}-${item.number}.log`),stdout+'\n'+stderr);
  const lines=stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line) as Record<string,unknown>];}catch{return [];}});
  const final=lines.findLast(v=>Array.isArray(v.slot));
  const start=lines.find(v=>v.started===true);item.runId=String(final?.runId??start?.runId??'')||null;
  item.result=final??{error:'pilot_script_failed',exitCode:code};item.state=final?'completed':'failed';await save();
  console.log(JSON.stringify({number:item.number,group:item.group,runId:item.runId,result:item.result}));
  const slots=final?.slot as {cleanup?:string;error?:string;amountFen?:number}[]|undefined;
  const previous=plan[item.number-2]?.result?.slot as typeof slots;
  const repeatedFailure=!!slots?.some(s=>s.error)&&!!previous?.some(s=>s.error);
  if(code!==0||!final||repeatedFailure||slots?.some(s=>s.cleanup==='quarantined'||['device_screen_locked','device_unavailable','target_app_not_foreground','captcha_required','access_restricted','rate_limited'].includes(s.error??''))){for(const pending of plan.filter(p=>p.state==='planned')){pending.state='not_run';pending.result={reason:repeatedFailure?'连续两次失败，先诊断修复，保留计划分母':'前次运行需要处理，保留在计划分母中'};}await save();break;}
}
console.log(JSON.stringify({cohort:id,finished:true,completed:plan.filter(p=>p.state==='completed').length,file}));
