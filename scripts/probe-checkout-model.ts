import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {ModelGateway,modelConfig} from '../src/infra/model.js';
import {checkoutInstruction,checkCheckout,checkoutSchema} from '../src/adapters/checkout-reading.js';
const files=process.argv.slice(2);if(!files.length)throw new Error('需要脱敏结算证据路径');
const parts=await Promise.all(files.map(async file=>sharp(await readFile(file)).trim().png().toBuffer()));
const sizes=await Promise.all(parts.map(p=>sharp(p).metadata()));let top=0;
const composite=parts.map((input,i)=>{const p={input,left:0,top};top+=sizes[i]!.height!+8;return p;});
const image=await sharp({create:{width:Math.max(...sizes.map(s=>s.width!)),height:top,channels:3,background:'#121719'}}).composite(composite).png().toBuffer();
const audit:unknown[]=[],model=new ModelGateway(modelConfig(),row=>audit.push(row));
const result=await model.json('offline_checkout_probe','checkout_details',checkoutInstruction,{pages:files.length},v=>v,{image,schema:checkoutSchema});
let valid=true,reason='';try{checkCheckout(result);}catch(e){valid=false;reason=(e as Error).message;}
const safe=Object.fromEntries(Object.entries(result as Record<string,unknown>).filter(([key])=>['payable','subtotal','packaging','delivery','other','discount','eta','subtotalBasis','feesSeparate','deliveryReference','packagingReference','coupons'].includes(key)));
await writeFile('artifacts/specified-pilot/model-probe.json',JSON.stringify({mode:'offline_existing_redacted_evidence',result:safe,valid,reason,audit},null,2));console.log(JSON.stringify({result:safe,valid,reason,audit}));
