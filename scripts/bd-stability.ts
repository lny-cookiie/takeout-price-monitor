import {readFile,mkdir,appendFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

type Platform='jd'|'meituan'|'taobao_instant';
type Input={city:string;brand:string;store?:string;item:string;platforms:Platform[]};
type Row={round:number;caseIndex:number;platform:Platform;runId:string|null;status:string;error:string|null;cleanup:string|null;elapsedMs:number|null;quoteValid:boolean;evidenceMatches:boolean|null};
const configPath=process.argv[2], rounds=Number(process.argv[3]??20);
if(!configPath || !Number.isInteger(rounds) || rounds<1 || rounds>100) throw new Error('用法：tsx scripts/bd-stability.ts <输入 JSON 路径> [1-100 轮]');
const parsed=JSON.parse(await readFile(configPath,'utf8')) as Input|Input[];
const cases=Array.isArray(parsed)?parsed:[parsed], input=cases[0];
if(!input || cases.some(c=>!c.city || !c.brand || !c.item || !c.platforms?.length || c.platforms.some(p=>!['jd','meituan','taobao_instant'].includes(p)) || new Set(c.platforms).size!==c.platforms.length || [...c.platforms].sort().join(',')!==[...input.platforms].sort().join(','))) throw new Error('输入需要城市、品牌、商品及一致且不重复的平台');
const base='http://127.0.0.1:4318', dir=join('.runtime','bd-batch-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(dir,{recursive:false});
const rows:Row[]=[], terminal=new Set(['completed','source_blocked','window_missed','interrupted','cancelled']);
let stopped=false;
const write=async(row:Row)=>{rows.push(row);await appendFile(join(dir,'rows.jsonl'),JSON.stringify(row)+'\n');};
for(let round=1;round<=rounds;round++){
  const start=Date.now(),caseIndex=(round-1)%cases.length, selected=cases[caseIndex]!; let runId:string|null=null;
  if(stopped){for(const platform of input.platforms)await write({round,caseIndex,platform,runId:null,status:'not_run',error:'previous_safety_stop',cleanup:null,elapsedMs:null,quoteValid:false,evidenceMatches:null});continue;}
  try{
    const response=await fetch(base+'/api/bd/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(selected),signal:AbortSignal.timeout(15_000)});
    const created=await response.json() as {platforms?:{runId?:string}[];error?:string};
    if(!response.ok || !created.platforms?.[0]?.runId)throw new Error(created.error??'submit_failed');
    runId=created.platforms[0].runId;
    let result:any=null;
    const deadline=Date.now()+1_000_000;
    while(Date.now()<deadline){
      const response=await fetch(base+'/api/market/runs/'+encodeURIComponent(runId),{signal:AbortSignal.timeout(15_000)});
      if(!response.ok)throw new Error('run_read_failed');
      result=await response.json();
      if(input.platforms.every(p=>result.slots?.some((s:any)=>s.platform===p && terminal.has(s.state))))break;
      await delay(2_000);
    }
    for(const platform of input.platforms){
      const slot=result?.slots?.find((s:any)=>s.platform===platform), proof=slot?.proof;
      let evidenceMatches:boolean|null=null;
      if(proof?.screenshot?.startsWith('/api/evidence/')){
        const res=await fetch(base+proof.screenshot,{signal:AbortSignal.timeout(10_000)}).catch(()=>null);
        evidenceMatches=!!res?.ok && createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')===proof.sha256;
      }
      const state=terminal.has(slot?.state)?slot.state:'not_finished';
      const status=state==='completed'?(slot?.status??'unknown'):state;
      const quoteValid=!!slot?.observation?.quote_valid && ['success','partial'].includes(status) && evidenceMatches===true && ['untouched','restored'].includes(slot?.cleanup);
      const attempt=slot?.attempts?.at(-1), started=Date.parse(attempt?.startedAt??'');
      const elapsedMs=Number.isFinite(started) && Number.isFinite(attempt?.executionMs) ? Math.max(0,started+attempt.executionMs-start) : Date.now()-start;
      await write({round,caseIndex,platform,runId,status,error:slot?.error??null,cleanup:slot?.cleanup??null,elapsedMs,quoteValid,evidenceMatches});
      if(slot?.cleanup==='quarantined' || slot?.cleanup==='needs_attention' || ['source_blocked','blocked','not_finished'].includes(status) ||
         /preflight_unverified|semantics_unavailable|identity_unverified|store_unverified|item_unverified|app_version_changed|visual_redaction_unavailable/.test(slot?.error??''))stopped=true;
    }
  }catch(e){
    stopped=true;
    for(const platform of input.platforms)if(!rows.some(r=>r.round===round&&r.platform===platform))await write({round,caseIndex,platform,runId,status:'not_run',error:e instanceof Error?e.message:'batch_error',cleanup:null,elapsedMs:Date.now()-start,quoteValid:false,evidenceMatches:null});
  }
}
const stats=Object.fromEntries(input.platforms.map(platform=>{
  const all=rows.filter(r=>r.platform===platform), valid=all.filter(r=>r.quoteValid), times=valid.flatMap(r=>r.elapsedMs===null?[]:[r.elapsedMs]).sort((a,b)=>a-b);
  const percentile=(p:number)=>times.length?times[Math.ceil(times.length*p)-1]:null;
  return [platform,{planned:rounds,validQuotes:valid.length,coverage:valid.length/rounds,p50Ms:percentile(.5),p90Ms:percentile(.9),accuracy:'需要人工核对',notRun:all.filter(r=>r.status==='not_run').length,
    cleanup:Object.fromEntries(['untouched','restored','quarantined','needs_attention'].map(status=>[status,all.filter(r=>r.cleanup===status).length]))}];
}));
const completeGroups=Array.from({length:rounds},(_,i)=>rows.filter(row=>row.round===i+1))
  .filter(group=>group.length===input.platforms.length && group.every(row=>row.quoteValid)).length;
const summary={rounds,caseCount:cases.length,startMode:'unclassified',stats,group:{planned:rounds,complete:completeGroups,completeRate:completeGroups/rounds},
  accuracy:'未进行人工核对',reviewMinutes:null,stopped};
await writeFile(join(dir,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({directory:dir,...summary},null,2));
