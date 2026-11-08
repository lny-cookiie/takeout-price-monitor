import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import type {CollectionRun} from '../src/ui/jd-runs.js';
const file=process.argv[2];if(!file)throw new Error('需要测试计划 JSON');
const plan=JSON.parse(await readFile(file,'utf8')) as {plan:{number:number;runId:string|null}[]};
const proofs=new Map<string,{id:string;sha256:string;keys:Set<string>;runs:Set<number>}>();
for(const item of plan.plan){
  if(!item.runId)continue;
  const run=JSON.parse(await readFile(resolve('artifacts/specified-pilot',item.runId+'.json'),'utf8')) as CollectionRun;
  const slot=run.slots[0],observation=slot?.observation;if(!observation)continue;
  const objects=new Map<string,{id:string;sha256:string}>();
  function walk(value:unknown){if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(walk);return;}const v=value as Record<string,unknown>;if(typeof v.id==='string'&&typeof v.sha256==='string'&&typeof v.screenshot==='string')objects.set(v.id,{id:v.id,sha256:v.sha256});Object.values(v).forEach(walk);}
  walk(run);
  const requested=Object.entries(observation.details?.fieldResults??{}).filter(([,v])=>v.status==='verified').map(([key,v])=>({key,id:v.evidenceId}));
  if(observation.details?.itemEvidence)requested.push({key:'menu',id:observation.details.itemEvidence.id});
  for(const selected of requested){const proof=objects.get(selected.id);if(!proof)throw new Error('字段证据未关联：'+selected.id);
    if(!/^[0-9a-f-]{36}$/.test(proof.id))throw new Error('证据编号格式不正确');
    const old=proofs.get(proof.id)??{...proof,keys:new Set<string>(),runs:new Set<number>()};old.keys.add(selected.key);old.runs.add(item.number);proofs.set(proof.id,old);
  }
}
const unique=new Map<string,{sha256:string;exampleId:string;width:number;height:number;keys:Set<string>;runs:Set<number>;ids:string[]}>();
for(const proof of proofs.values()){
  const image=await readFile(resolve('.runtime/evidence',proof.id+'.png')),hash=createHash('sha256').update(image).digest('hex');
  if(hash!==proof.sha256)throw new Error('证据文件摘要与任务记录不一致：'+proof.id);
  const dimensions=await sharp(image).metadata(),old=unique.get(hash)??{sha256:hash,exampleId:proof.id,width:dimensions.width!,height:dimensions.height!,keys:new Set<string>(),runs:new Set<number>(),ids:[]};
  for(const key of proof.keys)old.keys.add(key);for(const number of proof.runs)old.runs.add(number);old.ids.push(proof.id);unique.set(hash,old);
}
const images=[...unique.values()].map(v=>({...v,keys:[...v.keys],runs:[...v.runs].sort((a,b)=>a-b),path:resolve('.runtime/evidence',v.exampleId+'.png')}));
const out=file.replace(/\.json$/,'.evidence-index.json');await writeFile(out,JSON.stringify({generatedAt:new Date().toISOString(),fileIntegrityChecked:true,visualReview:'待逐个核对，不因摘要一致就声称金额准确',proofs:proofs.size,uniqueImages:images.length,images},null,2));
console.log(JSON.stringify({out,proofs:proofs.size,uniqueImages:images.length,images:images.map(v=>({id:v.exampleId,keys:v.keys,runs:v.runs}))}));
