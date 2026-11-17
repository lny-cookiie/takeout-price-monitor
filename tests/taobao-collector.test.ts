import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {liveTaobaoCollector} from '../src/adapters/taobao-collector.js';
import {EvidenceStore} from '../src/infra/evidence.js';
import {BUSINESS_VERSION,digest,liveSources} from '../src/domain/competition.js';
import {checkResult,TENANT,type Task} from '../src/domain/contracts.js';

test('淘宝只发布有独立店品证据的报价，并保留恢复状态',async()=>{
  const store=new EvidenceStore(await mkdtemp(join(tmpdir(),'taobao-evidence-')));
  const png=await sharp({create:{width:30,height:30,channels:3,background:'#ffffff'}}).png().toBuffer();
  const storeProof=await store.save(randomUUID(),'store',png,'','live');
  const itemProof=await store.save(randomUUID(),'item',png,'','live');
  const checkoutProof=await store.save(randomUUID(),'checkout',png,'','live');
  const now=Date.now(), supply={store:{key:'requested',name:'测试品牌（甲店）',brand:'测试品牌',city:'天津市',address:'天津市测试路1号'},item:{key:'sku',name:'鸡腿堡',kind:'single' as const,spec:'1人份',options:[],parts:null}};
  const task:Task={contract_version:BUSINESS_VERSION,tenant_id:TENANT,source_id:liveSources.taobao_instant,slot_id:'slot',run_id:'run',comparison_group_id:'group',platform:'taobao_instant',store_id:'requested',basket_id:'target',scenario_id:'s',entry_point:'entry',account_ref:'test',device_ref:'device',delivery_point_id:'点位',due_at:new Date(now-1000).toISOString(),deadline_at:new Date(now+120_000).toISOString(),data_mode:'live',fault:'none',max_attempts:1,timeout_seconds:120,requested_fields:['checkout_payable','delivery_fee','packaging_fee'],required_fields:['checkout_payable'],allowed_actions:['browse','select_variant','modify_owned_test_cart','read_checkout'],live:{target:{id:'target',revision:digest(supply),supply,reference:'test'},mapping:null,profile:{id:'p',name:'测试',city:'天津市',point:'点位',eligibility:{}},planName:'测试',meal:'lunch',quantity:1,couponPolicy:'page_applied',sourceRevision:'v1'}};
  const source={device:'device',package:'com.taobao.taobao',appVersion:'10.69.0'};
  let failed=false;
  const collector=liveTaobaoCollector({sources:{get:()=>source,permitted:()=>true} as any,model:{status:{configured:true}} as any,evidence:store,adbPath:'unused',serial:'device',yadbPath:'unused',appVersion:(async()=>source.appVersion) as any,progress:(async()=>{}) as any,
    collect:(async(options:any)=>{options.onCleanup(failed?'quarantined':'restored');return failed?{error:'taobao_checkout_item_unverified',store:null,item:null,totalFen:null,steps:[],rawText:null}: {store:'测试品牌（乙店）',storeAddress:'天津市测试路2号',item:'鸡腿堡',itemSpec:'1人份',totalFen:2150,originalFen:null,discountFen:null,deliveryFen:null,packagingFen:null,redPacketFen:null,steps:[],rawText:null,storeEvidence:storeProof,itemEvidence:itemProof,checkoutEvidence:checkoutProof};}) as any});
  const result=await collector.collect(task,randomUUID(),AbortSignal.timeout(10_000));
  assert.equal(result.status,'partial',result.error_code??'');
  assert.equal(result.cleanup,'restored');
  assert.equal(result.observation?.amount_fen,2150);
  assert.equal(result.resolvedLive?.target.supply.store.name,'测试品牌（乙店）');
  assert.equal(result.observation?.details?.storeEvidence.id,storeProof.id);
  checkResult(task,result);
  failed=true;
  const rejected=await collector.collect(task,randomUUID(),AbortSignal.timeout(10_000));
  assert.equal(rejected.observation,null);
  assert.equal(rejected.cleanup,'quarantined');
  assert.equal(rejected.error_code,'taobao_checkout_item_unverified');
});
