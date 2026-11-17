import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {liveMeituanCollector} from '../src/adapters/meituan-collector.js';
import {EvidenceStore} from '../src/infra/evidence.js';
import {BUSINESS_VERSION,digest,liveSources} from '../src/domain/competition.js';
import {checkResult,TENANT,type Task} from '../src/domain/contracts.js';
import type {U2Node} from '../src/adapters/meituan-semantic.js';

const node=(text:string,top:number,left=10):U2Node=>({text,desc:'',cls:'',rid:'',left,top,width:100,height:20});
test('美团采集按实际节点核验门店、单件、金额并验证恢复',async()=>{
  const image=await sharp({create:{width:400,height:760,channels:3,background:'#ffffff'}}).png().toBuffer();
  const now=Date.now();
  const supply={store:{key:'requested',name:'测试品牌（甲店）',brand:'测试品牌',city:'天津市',address:'天津市测试路1号'},item:{key:'sku',name:'鸡腿堡',kind:'single' as const,spec:'1人份',options:[],parts:null}};
  const source={device:'test-device',package:'com.sankuai.meituan'};
  const profile={id:'profile',name:'测试',city:'天津市',point:'测试点位',eligibility:{}};
  const task:Task={contract_version:BUSINESS_VERSION,tenant_id:TENANT,source_id:liveSources.meituan,slot_id:'slot',run_id:'run',comparison_group_id:'group',platform:'meituan',store_id:'requested',basket_id:'target',scenario_id:'s',entry_point:'entry',account_ref:'test',device_ref:'test-device',delivery_point_id:'测试点位',due_at:new Date(now-1000).toISOString(),deadline_at:new Date(now+120_000).toISOString(),data_mode:'live',fault:'none',max_attempts:1,timeout_seconds:120,requested_fields:['checkout_payable','delivery_fee','packaging_fee'],required_fields:['checkout_payable'],allowed_actions:['browse','select_variant','modify_owned_test_cart','read_checkout'],live:{target:{id:'target',revision:digest(supply),supply,reference:'test'},mapping:null,profile,planName:'测试',meal:'lunch',quantity:1,couponPolicy:'page_applied',sourceRevision:'v1'}};
  let phase='store',verifyValue='21.50',dirty=false,recoveryFails=false;
  const screens:Record<string,U2Node[]>={
    store:[node('测试品牌（乙店）',20),node('商家地址：天津市测试路2号',50)],
    item:[node('购物车为空',10),node('鸡腿堡',80),node('1人份',100),{...node('',70),height:60}],
    checkout:[node('鸡腿堡',40),node('1人份',60),{...node('',30),height:60},node('共1件',100),node('券前',400),node('¥22.50',400,220),node('实付',500),node('¥21.50',500,220)],
    empty:[node('购物车为空',20)], uncertain:[node('购物车',20)]
  };
  const semantic={read:async()=>dirty&&phase==='item'?screens.item!.filter(n=>n.text!=='购物车为空'):screens[phase]!,back:async()=>{phase=recoveryFails?'uncertain':'empty';},tap:async()=>{},find:async()=>null,findAll:async()=>[],waitStable:async()=>screens[phase]!,tapByVisual:async()=>false};
  const device={size:async()=>({width:400,height:760}),launch:async()=>{},screenshot:async()=>image,tap:async()=>{},back:async()=>{},close:async()=>{}};
  const evidence=new EvidenceStore(await mkdtemp(join(tmpdir(),'meituan-evidence-')));
  const collector=liveMeituanCollector({sources:{get:()=>source,permitted:()=>true} as any,model:{status:{configured:true},json:async()=>({value:verifyValue}),locate:async()=>[0,0]} as any,evidence,connect:(async()=>device) as any,
    semantic:(()=>semantic) as any,navigate:(async(options:any)=>{phase='store';await options.onStoreReached();phase='item';await options.onCartMutation();phase='checkout';return ['checkout'];}) as any});
  const result=await collector.collect(task,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(result.status,'partial',result.error_code??'');
  assert.equal(result.cleanup,'restored');
  assert.equal(result.observation?.amount_fen,2150);
  assert.equal(result.observation?.components.delivery_fee.amount_fen,null);
  assert.equal(result.resolvedLive?.target.supply.store.name,'测试品牌（乙店）');
  assert.notEqual(result.observation?.details?.storeEvidence.id,result.observation?.details?.itemEvidence.id);
  checkResult(task,result);
  const wrongCity=structuredClone(result);
  wrongCity.resolvedLive!.target.supply.store.city='其他城市';
  assert.throws(()=>checkResult(task,wrongCity),/resolved_target_mismatch/);
  const missingItemProof=structuredClone(result);
  missingItemProof.observation!.details!.itemEvidence=missingItemProof.observation!.details!.storeEvidence;
  assert.throws(()=>checkResult(task,missingItemProof),/identity_evidence_unavailable/);
  verifyValue='20.00';
  const wrong=await collector.collect(task,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(wrong.error_code,'meituan_payable_mismatch');
  assert.equal(wrong.observation,null);
  assert.equal(wrong.cleanup,'restored');
  dirty=true;
  const dirtyResult=await collector.collect(task,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(dirtyResult.error_code,'cart_preflight_unverified');
  assert.equal(dirtyResult.cleanup,'untouched');
  dirty=false;recoveryFails=true;verifyValue='21.50';
  const uncertain=await collector.collect(task,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(uncertain.cleanup,'quarantined');
});
