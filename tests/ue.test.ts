import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allocate,classify,compare,diagnose,executionIssues,ledger,metrics,simulate,type Order,type SimulationInput} from '../src/domain/ue.js';
import {orders,quotes,skus,seedTasks,units} from '../src/ue/fixtures.js';
import {changeScope,defaultScope,matchesScope} from '../src/ue/scope.js';

test('包销身份只读取内部标记，合同和用券不推断包销身份',()=>{
  const original=skus.slice(0,24);
  assert.equal(new Set(original.map(s=>s.store)).size,10);
  for(const store of new Set(original.map(s=>s.store)))assert.equal(new Set(original.filter(s=>s.store===store).map(s=>quotes(s)[0]!.address)).size,1);
  assert.equal(original.filter(s=>classify(s).baoxiao).length,20);
  for(const i of [20,21,22,23])assert.equal(classify(original[i]!).baoxiao,false);
  assert.equal(classify(original[0]!,'2026-12-31').baoxiao,true);
  assert.equal(classify(original[0]!,'2027-01-01').baoxiao,true);
  const coupon=orders.find(o=>o.skuId===original[0]!.id&&o.form==='coupon')!;
  assert.equal(classify(original[0]!,coupon.date).baoxiao,true);
  const noSettlement=structuredClone(original[0]!);noSettlement.contract.settlementEvidence='';
  assert.equal(classify(noSettlement).baoxiao,true);
  assert.equal(classify({...noSettlement,is_baoxiao:null}).baoxiao,false);
  assert.equal(classify({...original[0]!,is_baoxiao:false}).baoxiao,false);
});
test('城市和品类筛选覆盖多城市样本，切换城市会清理商圈与门店',()=>{
  const base=defaultScope();
  const bj=skus.find(s=>s.city==='北京'&&s.category==='快餐')!;
  assert.ok(bj);assert.equal(classify(bj).baoxiao,true);
  assert.equal(matchesScope(bj,units,base),false);
  assert.equal(matchesScope(bj,units,{...base,city:'北京'}),true);
  assert.equal(matchesScope(bj,units,{...base,city:'北京',category:'饮品'}),false);
  const changed=changeScope({...base,area:'滨江道',store:'禾味食堂（滨江道店）'},'city','北京',skus,units);
  assert.equal(changed.city,'北京');assert.equal(changed.area,'全部');assert.equal(changed.store,'全部');
  const tea=skus.find(s=>s.city==='天津'&&s.category==='饮品')!;
  assert.ok(tea);
  assert.equal(matchesScope(tea,units,{...base,category:'饮品'}),true);
  assert.equal(matchesScope(tea,units,{...base,category:'快餐'}),false);
  const category=changeScope({...base,brand:'禾味食堂',area:'滨江道'},'category','饮品',skus,units);
  assert.equal(category.city,'天津');assert.equal(category.area,'全部');assert.equal(category.brand,'全部');
});
test('材料独立算例：平台 -0.25 元，商家 11.65 元；结算后不重复扣费',()=>{
  const o:Order={...orders[0]!,food:3000,packaging:100,customerDelivery:300,commission:155,merchantDelivery:350,advertising:30,otherRevenue:0,platformSubsidy:200,merchantSubsidy:400,rider:650,riderSubsidy:0,variable:10,settlement:2365,foodCost:1000,packagingCost:100,refund:20,labor:80};
  assert.deepEqual(ledger(o),{revenue:835,variable:660,before:175,platform:-25,merchant:1165});
});
test('订单加权汇总，取消及未完成不计入，退款原单保留分母',()=>{
  const a={...orders[0]!,status:'completed' as const,platformSubsidy:100,rider:550,variable:10,refund:300};
  const b={...a,platformSubsidy:500,refund:0};
  const m=metrics([a,b,b,b,{...b,status:'cancelled'},{...b,status:'paid'}],skus);
  assert.equal(m.n,4);assert.equal(m.platform,-125);assert.equal(m.refunds,1);
  assert.notEqual(m.platform,(ledger(a).platform!+ledger(b).platform!)/2);
});
test('未知成本不补零，真实零成本可以计算',()=>{
  const a={...orders[0]!,foodCost:null,variable:null};
  assert.equal(ledger(a).merchant,null);assert.equal(ledger(a).platform,null);
  const b={...a,foodCost:0,variable:0};
  assert.notEqual(ledger(b).merchant,null);assert.notEqual(ledger(b).platform,null);
  const m=metrics([a,b],skus);assert.equal(m.platform,null);assert.equal(m.validPlatform,1);assert.equal(m.n,2);
});
test('四周与样本门槛：不足时不产生诊断结论',()=>{
  const m=metrics(orders.filter(o=>o.skuId==='BX001'),skus);
  assert.equal(diagnose({...m,n:29},'sku'),'insufficient');
  assert.equal(diagnose({...m,n:99},'unit'),'insufficient');
  assert.equal(diagnose(m,'sku',27),'insufficient');
  assert.equal(diagnose({...m,n:100},'unit'),'subsidy');
});
test('补贴前已亏不能归为补贴过度；ROI 未知不下定论',()=>{
  const m=metrics(orders.filter(o=>o.skuId==='BX001'),skus);
  assert.equal(diagnose({...m,before:-1,platform:-100,roi:.4},'sku'),'structure');
  assert.equal(diagnose({...m,before:100,platform:-100,roi:null},'sku'),'unproven');
  assert.equal(diagnose({...m,before:100,platform:-100,roi:1},'sku'),'unproven');
  assert.equal(diagnose({...m,before:100,platform:-100,roi:.99},'sku'),'subsidy');
  assert.equal(diagnose({...m,platform:0},'sku'),'healthy');
});
test('ROI 扣除自然订单贡献，零补贴不可除零',()=>{
  const o={...orders[0]!,rider:550,variable:10,platformSubsidy:100};
  const s={...skus[0]!,naturalOrders:1,naturalBeforeFen:200};
  const m=metrics([o,o],[s]);
  assert.equal(m.incremental,350);assert.equal(m.roi,1.75);
  assert.equal(metrics([{...o,platformSubsidy:0}],[s]).roi,null);
});
test('多品优惠按分守恒，未参与商品不承接尾差',()=>{
  assert.deepEqual(allocate(1000,[3100,1700,0]),[645,355,0]);
  assert.deepEqual(allocate(1,[1,1,1]),[0,0,1]);
  assert.deepEqual(allocate(0,[1,2]),[0,0]);
  assert.throws(()=>allocate(-1,[1]));assert.throws(()=>allocate(10,[0,0]));
});
test('同场景比价的每一个条件均参与阻断；形态不同另外说明',()=>{
  const [a,b]=quotes(skus[0]!) as [ReturnType<typeof quotes>[number],ReturnType<typeof quotes>[number]];
  const c=compare(a,b);assert.equal(c.delta,150);assert.ok(c.differentForm);assert.equal(c.reasons.length,0);
  for(const changed of [{store:'另一家店'},{address:'另一营业地址'},{item:'不同商品'},{spec:'两份'},{quantity:2},{options:'加配鸡蛋'},{user:'会员'},{eligible:false},{point:'另一个点位'},{fulfillment:'自提'},{at:'2026-11-06T11:37:01+08:00'},{payable:null},{available:false}]){
    const invalid=compare(a,{...b,...changed});assert.equal(invalid.delta,null);assert.equal(invalid.index,null);assert.ok(invalid.reasons.length);
  }
  assert.equal(compare(a,b,29).index,null);
  assert.equal(compare(a,{...b,at:'2026-11-06T11:37:00+08:00'}).reasons.length,0);
});
test('竞对零元保留绝对价差，指数不除零',()=>{
  const [a,b]=quotes(skus[0]!) as [ReturnType<typeof quotes>[number],ReturnType<typeof quotes>[number]];
  const c=compare(a,{...b,payable:0});assert.equal(c.delta,a.payable);assert.equal(c.index,null);assert.equal(c.percent,null);
});
const input:SimulationInput={kind:'subsidy',targetFen:80,response:-4,competitor:false,oldOnly:false,oldShare:0,budgetFen:50000,floorFen:200,maxLossFen:10000};
test('三种情景受预算、商家底线、亏损容忍及 ROI 约束',()=>{
  const m=metrics(orders.filter(o=>o.skuId==='BX001'),skus),s=simulate(m,input);
  assert.equal(s.rows.length,3);assert.deepEqual(s.reasons,[]);
  assert.ok(s.rows[0]!.n>s.rows[1]!.n&&s.rows[1]!.n>s.rows[2]!.n);
  assert.equal(s.rows[1]!.ue,195);
  assert.equal(s.rows[1]!.merchant,m.merchant!-320);
  assert.ok(simulate(m,{...input,budgetFen:1}).reasons.some(r=>r.includes('预算')));
  assert.ok(simulate(m,{...input,floorFen:99999}).reasons.some(r=>r.includes('底线')));
  assert.ok(simulate(m,{...input,targetFen:500,maxLossFen:0}).reasons.some(r=>r.includes('亏损')));
  assert.ok(simulate(m,{...input,kind:'supply',targetFen:600}).reasons.some(r=>r.includes('配送成本')));
});
test('仅老客情景需要老客基线；样本或商家成本缺失不能预测',()=>{
  const m=metrics(orders.filter(o=>o.skuId==='BX001'),skus);
  assert.equal(simulate(m,{...input,oldOnly:true}).rows.length,0);
  assert.equal(simulate({...m,n:29},input).rows.length,0);
  assert.equal(simulate({...m,merchant:null},input).rows.length,0);
  assert.ok(simulate(m,{...input,competitor:true}).rows[1]!.n<simulate(m,input).rows[1]!.n);
});
test('人工执行须两项审批、角色、生效窗口、七天告知和商家确认',()=>{
  const t=seedTasks()[0]!;
  assert.ok(executionIssues(t,[t],'运营执行','2026-11-07T12:00:00+08:00',skus[0]).some(x=>x.includes('审批')));
  t.businessApproved=true;t.financeApproved=true;t.status='ready';
  const check=(patch:Partial<typeof t>={},role='运营执行',at='2026-11-07T12:00:00+08:00')=>executionIssues({...t,...patch},[t],role,at,skus[0]);
  assert.deepEqual(check(),[]);
  assert.ok(check({},'业务分析').some(x=>x.includes('权限')));
  assert.ok(check({notice:'2026-11-01T10:00:00+08:00'}).some(x=>x.includes('7 天')));
  assert.ok(check({funder:'商家'}).some(x=>x.includes('承担')));
  assert.ok(check({merchantConfirmed:false}).some(x=>x.includes('商家确认')));
  assert.ok(check({budgetFen:1}).some(x=>x.includes('预算')));
  assert.ok(check({end:'2027-01-02T12:00:00+08:00'}).some(x=>x.includes('合同')));
  assert.ok(check({},'运营执行','2026-11-06T12:00:00+08:00').some(x=>x.includes('窗口')));
});
test('同 SKU 互斥活动与共享预算均受控，回滚释放活动冲突',()=>{
  const t=seedTasks()[0]!;t.businessApproved=true;t.financeApproved=true;t.status='ready';
  const other={...structuredClone(t),id:'OTHER'};
  assert.ok(executionIssues(t,[t,other],'运营执行','2026-11-07T12:00:00+08:00',skus[0]).some(x=>x.includes('互斥')));
  other.status='rolledback';assert.deepEqual(executionIssues(t,[t,other],'运营执行','2026-11-07T12:00:00+08:00',skus[0]),[]);
  other.status='ready';other.skuId='BX002';other.expectedSpend=500000;
  assert.ok(executionIssues(t,[t,other],'运营执行','2026-11-07T12:00:00+08:00',skus[0]).some(x=>x.includes('共享预算')));
});
