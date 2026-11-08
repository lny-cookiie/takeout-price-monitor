import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative} from 'node:path';
import {publicPageMap} from '../src/domain/page-ontology.js';
import type {AndroidSource} from '../src/adapters/android-source.js';
const input=process.argv[2];if(!input)throw new Error('需要本轮汇总报告 JSON');
const report=JSON.parse(await readFile(input,'utf8')) as {overall:{planned:number;executed:number;completeSuccess:number;changedCart:number;restored:number;quarantined:number};modelCalls:{audits:{scope:string;operation:string;ok:boolean}[]}|null;rows:{group:string;completeSuccess:boolean;quoteMs:number|null;elapsedMs:number|null;ruleset:string;attemptIds:string[]}[]};
const r=report.overall;
if(r.planned!==20||r.executed!==20||r.completeSuccess<19||r.quarantined!==0||r.changedCart!==r.restored)throw new Error('尚未满足二十次质量与恢复要求，不生成已验证基线');
if(!report.modelCalls)throw new Error('缺少原模型调用审计，不能确认真实模型参与');
for(const row of report.rows.filter(row=>row.completeSuccess)){
  const calls=report.modelCalls.audits.filter(c=>row.attemptIds.includes(c.scope));
  if(!['jd_menu_read','checkout_details'].every(op=>calls.some(c=>c.operation===op&&c.ok)))throw new Error('成功报价缺少实际模型读价记录');
  if(row.group==='warm'&&calls.some(c=>c.operation==='page_location'))throw new Error('已校准的店内路径仍有多余视觉定位，不能作为当前精简路径基线');
}
const source=(JSON.parse(await readFile('.runtime/android-sources.json','utf8')) as AndroidSource[]).find(s=>s.platform==='jd')!;
const version=(JSON.parse(await readFile('package.json','utf8')) as {version:string}).version;
const files:string[]=[];
async function walk(path:string){for(const entry of await readdir(path,{withFileTypes:true})){const child=path+'/'+entry.name;if(entry.isDirectory())await walk(child);else files.push(child);}}
for(const path of ['src','tests','scripts','public'])await walk(path);
files.push('package.json','package-lock.json','tsconfig.json','agent.md','README.md','CHANGELOG.md','数据治理/数据治理表.md','前期调研/19_指定包销品采集实施与验收.md','前期调研/21_三平台页面本体与取数地图.md','前期调研/22_京东采集技术基线与竞对接入.md');
const hashes=[];for(const file of files.sort())hashes.push({file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
const performance=Object.fromEntries(['warm','from_jd_home'].map(group=>{
  const selected=report.rows.filter(row=>row.group===group),quoteLimit=group==='warm'?60_000:90_000,endLimit=group==='warm'?90_000:120_000;
  const quotedInLimit=selected.filter(row=>row.completeSuccess&&row.quoteMs!==null&&row.quoteMs<=quoteLimit).length;
  const endedInLimit=selected.filter(row=>row.completeSuccess&&row.elapsedMs!==null&&row.elapsedMs<=endLimit).length;
  return [group,{n:selected.length,quoteLimitMs:quoteLimit,endLimitMs:endLimit,quotedInLimit,endedInLimit,passed:selected.length===10&&quotedInLimit>=9&&endedInLimit>=9}];
}));
const baseline={version,createdAt:new Date().toISOString(),status:'single_store_workflow_validated',scope:'本机单设备、京东16.1.0、麦当劳天津鞍山西道店、板烧鸡腿堡1人份×1、已登记账号配送条件及本机领券结算特许；不提交或支付。',
  limitations:['单店单机结果不代表其他门店、机型或生产规模','经营成本、订单和竞对真实样本尚未接入','速度是否达标单独判断，不以质量通过替代性能通过'],
  report:relative(process.cwd(),resolve(input)).replaceAll('\\','/'),quality:r,performance,pageMap:publicPageMap('jd',source),files:hashes};
const out=resolve('artifacts/specified-pilot/jd-baseline-'+version+'.json');await mkdir(resolve('artifacts/specified-pilot'),{recursive:true});await writeFile(out,JSON.stringify(baseline,null,2));
console.log(JSON.stringify({baseline:out,quality:r,performance,files:hashes.length}));
