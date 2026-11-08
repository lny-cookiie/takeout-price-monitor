import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseCny } from '../src/domain/contracts.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ModelGateway, modelConfig, type ModelAudit } from '../src/infra/model.js';
import { proposeMapping } from '../src/application/matching.js';
import { digest, type Candidate, type Supply, type Target } from '../src/domain/competition.js';

const config=modelConfig();
if (!config) throw new Error('请在运行环境配置模型地址、名称和密钥');
const audit:ModelAudit[]=[];
const model=new ModelGateway(config,row=>audit.push(row));
const supply:Supply={store:{key:'smoke-store',brand:'澄山咖啡',name:'澄山咖啡（学园店）',city:'验证市',address:'验证市学园路18号'},
  item:{key:'smoke-item',name:'燕麦拿铁',kind:'single',spec:'500ml',options:['热','无糖'],parts:null}};
const target:Target={id:'smoke-only',revision:digest(supply),supply,reference:'虚构验证样例'};
const candidate:Candidate={platform:'meituan',entry:'本地模型验证',reference:'虚构验证样例',
  supply:{store:{...supply.store,key:'other-store',name:'澄山咖啡 · 学园店',address:'学园路18号'},
    item:{...supply.item,key:'other-item',name:'热燕麦拿铁（无糖）',spec:'0.5升'}}};
const checks:Record<string,boolean>={};
let error:string|null=null;
const judgments:Record<string,unknown>={};
try {
  const result=await model.test();
  checks.text=result.text;checks.vision=result.vision;checks.location=result.location;
  const image=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="620" height="440"><rect width="620" height="440" fill="#fff"/><g font-size="33" font-family="Microsoft YaHei, Arial" fill="#191919"><text x="48" y="95">商品小计   ¥23.50</text><text x="48" y="170">配送费      ¥2.00</text><text x="48" y="245">已减        ¥4.00</text><text x="48" y="342">结算应付   ¥21.50</text></g></svg>')).png().toBuffer();
  const payable=await model.json('model_smoke','checkout_read','读取图中“结算应付”对应金额。输出 {"payable":"金额原文"}，未显示返回 null。',{},x=>{
    const raw=(x as {payable?:string})?.payable;
    if(typeof raw!=='string')throw new Error();
    return parseCny(raw);
  },{image});
  checks.checkoutAmount=payable===2150;
  const match=await proposeMapping(target,candidate,model);
  judgments.positive={store:match.store,item:match.item};
  checks.sameStore=match.store.relation==='exact' && !match.store.missing.length;
  checks.sameItem=match.item.relation==='exact' && !match.item.missing.length;
  const different:Candidate={...candidate,supply:{...candidate.supply,item:{...candidate.supply.item,name:'热无糖茉莉奶茶'}}};
  const mismatch=await proposeMapping(target,different,model);
  judgments.negative={store:mismatch.store,item:mismatch.item};
  checks.differentItem=mismatch.item.relation!=='exact';
  assert.ok(Object.values(checks).every(Boolean),'模型在独立的店品样例上有误判');
} catch(e) {
  error=(e as Error).message;
  process.exitCode=1;
} finally {
  const dir=resolve('artifacts');
  await mkdir(dir,{recursive:true});
  const report={checkedAt:new Date().toISOString(),model:config.model,endpoint:new URL(config.baseUrl).hostname,
    inputData:'synthetic_probe_only',realModelRequests:audit.length,checks,judgments,error,
    calls:audit.map(a=>({operation:a.operation,ok:a.ok,ms:a.ms,inputTokens:a.inputTokens,outputTokens:a.outputTokens}))};
  await writeFile(join(dir,'model-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}