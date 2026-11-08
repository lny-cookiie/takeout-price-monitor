import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCny, validateTask, checkObservation, checkResult, type Observation } from '../src/domain/contracts.js';
import { STORES, makeTask } from '../src/domain/catalog.js';
const task = () => makeTask('unit','meituan',STORES[0]!,STORES[0]!.baskets[0]!.id,'baseline',new Date(Date.now()-1000),'unit_g1');
const free={amount_fen:0,raw_value:'¥0.00',basis:'separately_displayed' as const,included_in:'checkout_payable' as const};
test('金额保留分和真实零元，拒绝起价、区间、负数、科学计数与过多小数',()=>{
  for(const [raw,fen] of [['￥23.80',2380],['¥0.00',0],['1.2元',120],['9',900],['0.01',1]] as const) assert.equal(parseCny(raw),fen);
  for(const value of ['9.9元起','9-10','-1','1e3','1.001','NaN','1,000','99999999999','']) assert.throws(()=>parseCny(value));
});
test('任务契约拒绝租户混用、额外权限、时间倒置和非统一时区格式',()=>{
  const t=task();assert.doesNotThrow(()=>validateTask(t));
  assert.throws(()=>validateTask({...t,tenant_id:'other'}),/tenant_mismatch/);
  assert.throws(()=>validateTask({...t,allowed_actions:[...t.allowed_actions,'submit_order']}),/invalid_task/);
  assert.throws(()=>validateTask({...t,deadline_at:t.due_at}),/invalid_window/);
  assert.throws(()=>validateTask({...t,due_at:'2026-11-05T11:30:00+08:00',deadline_at:'2026-11-05T11:35:00+08:00'}),/canonical_utc/);
});
test('发布校验拒绝混合模拟数据、错场景、金额不符、过期和无证据',()=>{
  const t=task(),id=randomUUID(),at=new Date().toISOString();
  const o:Observation={ observation_id:id,source_id:t.source_id,tenant_id:t.tenant_id,slot_id:t.slot_id,attempt_id:id,platform:t.platform,store_id:t.store_id,basket_id:t.basket_id,scenario_id:t.scenario_id,price_kind:'checkout_payable',price_scope:'basket',currency:'CNY',amount_fen:0,raw_value:'¥0.00',components:{delivery_fee:free,packaging_fee:free},missing_reasons:{},observed_at:at,collected_at:at,value_origin:'synthetic',quote_valid:true,detail_complete:true,basket_items:STORES[0]!.baskets[0]!.items,account_ref:t.account_ref,delivery_point_id:t.delivery_point_id,entry_point:t.entry_point,evidence_refs:[{id,sha256:'a'.repeat(64),screenshot:'unit',text_file:'unit',captured_at:at,page_stage:'checkout'}],contract_version:t.contract_version,collector_version:'unit' };
  assert.doesNotThrow(()=>checkObservation(t,o));
  assert.throws(()=>checkObservation(t,{...o,value_origin:'observed'}),/mixed_data/);
  assert.throws(()=>checkObservation(t,{...o,basket_id:'other'}),/scenario/);
  assert.throws(()=>checkObservation(t,{...o,amount_fen:1}),/amount/);
  assert.throws(()=>checkObservation(t,{...o,observed_at:'2020-01-01T00:00:00Z'}),/window/);
  assert.throws(()=>checkObservation(t,{...o,evidence_refs:[]}),/evidence/);
  assert.throws(()=>checkObservation(t,{...o,components:{delivery_fee:{amount_fen:null,raw_value:null,basis:'unknown',included_in:null},packaging_fee:free}}),/missing_reason/);
  assert.throws(()=>checkResult(t,{status:'success',error_code:null,availability:'available',observation:null,trace:[],evidence:null,started_at:at,finished_at:at,cleanup:'untouched',cost:{model_yuan:null,execution_ms:0}}),/missing_valid_quote/);
});
