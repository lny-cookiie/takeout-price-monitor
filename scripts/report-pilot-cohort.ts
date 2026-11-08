import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import type {CollectionRun} from '../src/ui/jd-runs.js';
import {DatabaseSync} from 'node:sqlite';
import type {ModelAudit} from '../src/infra/model.js';

// Read only saved plans and task records. This report never touches the phone.
type Plan={number:number;group:string;state:string;runId:string|null;result:Record<string,unknown>|null};
type Cohort={startedAt:string;appVersion:string;rulesetVersion:string;planned:number;plan:Plan[]};
const files=process.argv.slice(2);if(!files.length)throw new Error('请传入本轮计划 JSON 路径');
const directory=resolve('artifacts/specified-pilot');
const stats=(values:number[])=>{
  const ordered=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!ordered.length)return {n:0,mean:null,p50:null,p90:null,min:null,max:null};
  const q=(p:number)=>ordered[Math.max(0,Math.ceil(ordered.length*p)-1)]!;
  return {n:ordered.length,mean:ordered.reduce((s,v)=>s+v,0)/ordered.length,p50:q(.5),p90:q(.9),min:ordered[0]!,max:ordered.at(-1)!};
};
const rows=[];
for(const file of files){
  const cohort=JSON.parse(await readFile(file,'utf8')) as Cohort;
  for(const plan of cohort.plan){
    const run=plan.runId?await readFile(resolve(directory,plan.runId+'.json'),'utf8').then(raw=>JSON.parse(raw) as CollectionRun).catch(()=>null):null;
    const slot=run?.slots[0],attempts=slot?.attempts??[],steps=attempts.flatMap(a=>a.steps);
    const observed=slot?.observation,fields=observed?.details?.fieldResults??{};
    const phases:Record<string,number>={};for(const step of steps)if(step.elapsedMs!==null&&step.state!=='started')phases[step.phase]=(phases[step.phase]??0)+step.elapsedMs;
    const quoteValid=!!observed&&fields.payable?.status==='verified'&&typeof observed.amount_fen==='number';
    const menu=slot?.menuPrices.find(p=>p.kind==='display_current');
    const coreComplete=quoteValid&&!!menu&&menu.qualifier==='exact'&&menu.fen!==null&&['subtotal','packaging','delivery','discount'].every(k=>fields[k]?.status==='verified');
    const errorCodes=attempts.flatMap(a=>a.error?[a.error]:[]);
    rows.push({cohort:basename(file),number:plan.number,group:plan.group,planState:plan.state,runId:plan.runId,
      version:cohort.appVersion,ruleset:cohort.rulesetVersion,status:slot?.status??null,error:slot?.error??null,
      attemptIds:attempts.map(a=>a.id),
      quoteValid,coreComplete,cleanup:slot?.cleanup??null,completeSuccess:quoteValid&&coreComplete&&slot?.cleanup==='restored',
      elapsedMs:run?.elapsedMs??null,quoteMs:slot?.quoteMs??null,queueMs:run?.queueMs??null,preparationMs:plan.result?.preparationMs??null,
      phases,timings:slot?.timings??null,menuFen:menu?.fen??null,payableFen:observed?.amount_fen??null,
      amounts:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,{fen:v.fen,status:v.status,reason:v.reason,evidenceId:v.evidenceId}])),
      missing:observed?.details?.missing??null,identityReused:steps.some(s=>s.phase==='store_verify'&&s.state==='succeeded'&&s.data?.method==='current_store_title_with_recent_address_evidence'),
      merchantOpened:steps.some(s=>s.phase==='store_address_open'&&s.state==='succeeded'&&s.data?.target==='商家'),
      itemReopens:steps.filter(s=>s.phase==='item_open_retry'&&s.state==='succeeded').length,
      couponCheckoutClicks:steps.filter(s=>s.phase==='coupon_checkout'&&s.state==='succeeded').length,
      entryActions:steps.find(s=>s.phase==='launch'&&s.state==='succeeded')?.data?.entryActions??[],
      navigationErrors:errorCodes.filter(c=>/page_not_ready|screen_changed|entry_mismatch|store_identity|obstructed|invalid_control_bounds/.test(c)),
      evidenceIds:[...new Set(steps.flatMap(s=>s.evidenceIds))],log:plan.runId?plan.runId+'.json':null});
  }
}
let modelCalls:ModelAudit[]|null=null;
try{
  const db=new DatabaseSync(resolve('.runtime/observatory.sqlite'),{readOnly:true});
  try{const scopes=new Set(rows.flatMap(r=>r.attemptIds));modelCalls=(db.prepare('SELECT payload FROM market_audit ORDER BY id').all() as {payload:string}[]).map(row=>JSON.parse(row.payload) as ModelAudit).filter(call=>scopes.has(call.scope));}finally{db.close();}
}catch{/* A report without the original audit database cannot certify model call counts. */}
const summarize=(selected:typeof rows)=>{
  const executed=selected.filter(r=>r.status!==null),changed=executed.filter(r=>r.cleanup==='restored'||r.cleanup==='quarantined');
  const stages=[...new Set(executed.flatMap(r=>Object.keys(r.phases)))];
  return {planned:selected.length,executed:executed.length,notExecuted:selected.length-executed.length,
    quoteValid:executed.filter(r=>r.quoteValid).length,coreComplete:executed.filter(r=>r.coreComplete).length,
    completeSuccess:executed.filter(r=>r.completeSuccess).length,
    firstPassSuccessRate:executed.length?executed.filter(r=>r.completeSuccess).length/executed.length:null,
    plannedSuccessRate:selected.length?executed.filter(r=>r.completeSuccess).length/selected.length:null,
    changedCart:changed.length,restored:changed.filter(r=>r.cleanup==='restored').length,quarantined:changed.filter(r=>r.cleanup==='quarantined').length,
    untouched:executed.filter(r=>r.cleanup==='untouched').length,identityReused:executed.filter(r=>r.identityReused).length,
    merchantOpened:executed.filter(r=>r.merchantOpened).length,navigationErrorRuns:executed.filter(r=>r.navigationErrors.length).length,
    itemReopens:executed.reduce((s,r)=>s+r.itemReopens,0),couponCheckoutClicks:executed.reduce((s,r)=>s+r.couponCheckoutClicks,0),
    allElapsed:stats(executed.flatMap(r=>r.elapsedMs===null?[]:[r.elapsedMs])),
    validQuote:stats(executed.filter(r=>r.quoteValid).flatMap(r=>r.quoteMs===null?[]:[r.quoteMs])),
    stages:Object.fromEntries(stages.map(p=>[p,stats(executed.flatMap(r=>r.phases[p]===undefined?[]:[r.phases[p]!]))]))};
};
const report={generatedAt:new Date().toISOString(),definition:'完整成功=现价、应付和四项主要明细均已核对，且自动恢复；原失败和未执行计划保留。',
  note:'阶段包含并行操作，不可简单相加。导航错误计数不等同逐帧人工确认的误触次数。单店单机结果不能外推多店多设备。',
  overall:summarize(rows),groups:Object.fromEntries([...new Set(rows.map(r=>r.group))].map(g=>[g,summarize(rows.filter(r=>r.group===g))])),
  modelCalls:modelCalls?{count:modelCalls.length,failed:modelCalls.filter(c=>!c.ok).length,models:[...new Set(modelCalls.map(c=>c.model))],operations:Object.fromEntries([...new Set(modelCalls.map(c=>c.operation))].map(op=>[op,stats(modelCalls.filter(c=>c.operation===op).map(c=>c.ms))])),audits:modelCalls}:null,rows};
const output=resolve(directory,'report-'+basename(files.at(-1)!,'.json'));
await mkdir(dirname(output),{recursive:true});await writeFile(output+'.json',JSON.stringify(report,null,2));
const sec=(ms:number|null)=>ms===null?'未取得':(ms/1000).toFixed(1);
const groups=Object.entries(report.groups).map(([g,s])=>`| ${g==='warm'?'门店内继续':'京东首页出发'} | ${s.executed}/${s.planned} | ${s.completeSuccess} | ${s.restored}/${s.changedCart} | ${sec(s.validQuote.p50)} / ${sec(s.validQuote.p90)} | ${sec(s.allElapsed.p50)} / ${sec(s.allElapsed.p90)} |`);
const phaseNames:Record<string,string>={source_check:'检查采集条件',device_connect:'连接手机',launch:'进入京东外卖',brand_search:'搜索品牌',brand_model_match:'选择候选门店',store_verify:'核对分店',store_address_open:'打开营业地址核对页（包含在分店核对中）',sku_match:'找到商品并核对规格',item_open_retry:'重新打开同一商品',menu_price:'保存商品现价证据',menu_model:'模型核对现价（并行）',cart_add_intent:'核对本次加购（包含在加购中）',cart:'加购并核对购物车',checkout:'进入结算并读取明细',model_verify:'模型核对结算（与恢复并行）',restore:'恢复购物车',worker:'执行全程'};
const stages=Object.entries(report.overall.stages).map(([p,s])=>`| ${phaseNames[p]??p} | ${s.n} | ${sec(s.p50)} | ${sec(s.p90)} | ${sec(s.max)} |`);
const tasks=rows.map(r=>`| ${r.number} | ${r.group} | ${r.status??r.planState} | ${r.error??'无'} | ${sec(r.quoteMs)} | ${sec(r.elapsedMs)} | ${r.cleanup??'未执行'} | ${r.merchantOpened?'地址核对':r.identityReused?'复用同店证据':'未到该阶段'} | ${r.log?'['+r.runId+']('+r.log+')':'未发起'} |`);
await writeFile(output+'.md',`# 京东指定单品连续真机测试\n\n麦当劳天津鞍山西道店，板烧鸡腿堡 1 人份 ×1。本机、同一账号和配送条件，不提交订单。\n\n${report.definition}\n\n${report.note}\n\n| 场景 | 执行/计划 | 完整成功 | 自动恢复/加购任务 | 报价 P50/P90 秒 | 结束 P50/P90 秒 |\n|---|---|---|---|---|---|\n${groups.join('\n')}\n\n## 阶段耗时\n\n| 阶段 | 样本数 | P50 秒 | P90 秒 | 最慢秒 |\n|---|---|---|---|---|\n${stages.join('\n')}\n\n## 全部任务\n\n| 次数 | 场景 | 状态 | 错误 | 报价秒 | 全程秒 | 恢复 | 商家页 | 日志 |\n|---|---|---|---|---|---|---|---|---|\n${tasks.join('\n')}\n`);
console.log(JSON.stringify({report:output+'.md',...report.overall,groups:report.groups}));
