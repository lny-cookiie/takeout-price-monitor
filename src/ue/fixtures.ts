import { type Order,type Sku,type Unit,type Quote,type Task,type SimulationInput,metrics,simulate } from '../domain/ue.js';
export const units:Unit[]=Array.from({length:12},(_,i)=>({id:`U${i+1}`,city:'天津',area:'滨江道',tier:'新一线',category:'快餐',user:i%4<2?'新客':'老客',period:i%2===0?'午市':'晚市',channel:['超级补贴','首页推荐','搜索进店'][Math.floor(i/4)]!}));
const names=['香煎鸡腿饭','黑椒牛肉饭','照烧鸡肉饭','番茄牛腩饭','招牌卤肉饭','菌菇鸡肉饭','香辣鸡排饭','咖喱牛肉饭','红烧肉饭','鱼香肉丝饭','宫保鸡丁饭','土豆牛腩饭'];
const branches=['滨江道店','和平路店','赤峰道店','南京路店','营口道店','劝业场店','哈密道店','锦州道店','鞍山道店','西宁道店'];
export const skus:Sku[]=Array.from({length:24},(_,i)=>({
  id:`BX${String(i+1).padStart(3,'0')}`,name:names[i%12]!,spec:'标准份 · 米饭 200g · 1 份',brand:i<12?'禾味食堂':'饭小满',store:`${i<12?'禾味食堂':'饭小满'}（${branches[(i<12?0:5)+(i%12)%5]}）`,unitId:units[i%12]!.id,
  city:'天津',area:'滨江道',category:'快餐',is_baoxiao:i<20,
  contract:{id:`HT-DEMO-${i<12?'001':'002'}`,from:i===22?'2026-09-01':'2026-10-01',to:i===22?'2026-09-30':'2026-12-31',region:i===23?'北京':'天津',valid:i!==20,priceFen:2465,sharing:i!==21,
    settlementEvidence:i===21?'':`SET-DEMO-${i+1}`,settlementMatches:true,contractEvidence:i===20?'':`CONTRACT-DEMO-${i<12?'A':'B'}`,allowed:['direct','coupon','mixed'],missing:i>=20?'包销所需证据或适用条件不足':'',version:1},
  foodFen:i===8?null:i===4?2400:1100+(i%4)*50,naturalOrders:0,naturalBeforeFen:230,quality:i===8?'missing':i%5===0?'estimated':'derived'
}));
export const orders:Order[]=[];
for(const [i,sku] of skus.entries()) {
  const count=i===11?18:i===19?24:168+(i*31)%160;sku.naturalOrders=Math.round(count*.8);
  const structure=[2,5,9].includes(i%12), healthy=[3,6,10].includes(i%12);
  const platformSubsidy=structure?100:healthy?90:400, rider=structure?950:550;
  for(let j=0;j<count+2;j++) {
    const form=(['direct','coupon','mixed','unknown'] as const)[j%17===0?3:j%3]!;
    const food=3000+(i%4)*100,packaging=100,merchantSubsidy=400,commission=155,merchantDelivery=350,advertising=30,customerDelivery=300;
    const settlement=food+packaging+platformSubsidy-merchantSubsidy-commission-merchantDelivery-advertising;
    const day=new Date(Date.UTC(2026,9,10+(j%28))).toISOString().slice(0,10);
    orders.push({id:`DEMO-${sku.id}-${String(j+1).padStart(4,'0')}`,skuId:sku.id,date:day,status:j<count?'completed':j===count?'cancelled':'paid',form,origin:'synthetic',food,packaging,merchantDeliveryIncome:0,customerDelivery,
      commission,merchantDelivery,advertising,otherRevenue:0,platformSubsidy,merchantSubsidy,brandSubsidy:0,rider,riderSubsidy:0,variable:10,
      settlement,foodCost:sku.foodFen,packagingCost:70,refund:j%29===0?300:0,labor:80,paid:food+packaging+customerDelivery-platformSubsidy-merchantSubsidy,
      repurchase:j%4===0,badReview:j%71===0,minutes:27+(i%5)*3+j%7,evidence:`EVIDENCE-${sku.id}-${j+1}`});
  }
  sku.contract.priceFen=orders.find(o=>o.skuId===sku.id)!.settlement;
}

// Additional sample scopes exercise city/category filtering; they do not expand the real pilot.
for(const scope of [
  {prefix:'BJ',city:'北京',area:'望京',tier:'一线',category:'快餐'},
  {prefix:'TJ-TEA',city:'天津',area:'南开大悦城',tier:'新一线',category:'饮品'},
  {prefix:'BJ-TEA',city:'北京',area:'国贸',tier:'一线',category:'饮品'}
]) {
  const drinks=scope.category==='饮品';
  for(let i=0;i<4;i++) {
    const original=skus[i]!,baseUnit=units[i]!;
    const unit:Unit={...baseUnit,id:`${scope.prefix}-${baseUnit.id}`,city:scope.city,area:scope.area,tier:scope.tier,category:scope.category};
    units.push(unit);
    const sku:Sku={...structuredClone(original),id:`${scope.prefix}-${original.id}`,unitId:unit.id,city:scope.city,area:scope.area,category:scope.category,
      brand:drinks?'茶小满':'禾味食堂',store:`${drinks?'茶小满':'禾味食堂'}（${scope.city}${scope.area}${i+1}店）`,
      name:drinks?['茉莉鲜奶茶','桂花乌龙奶茶','杨枝甘露','多肉葡萄'][i]!:original.name,spec:drinks?'500ml · 标准糖 · 常温 · 1 杯':original.spec,
      foodFen:drinks?550+i*30:original.foodFen,naturalBeforeFen:drinks?180:original.naturalBeforeFen};
    sku.contract={...sku.contract,id:`${scope.prefix}-${sku.contract.id}`,region:scope.city,contractEvidence:`${scope.prefix}-${sku.contract.contractEvidence}`,settlementEvidence:`${scope.prefix}-${sku.contract.settlementEvidence}`};
    const sampleOrders=orders.filter(o=>o.skuId===original.id).map(o=>{
      const food=drinks?o.food-1200:o.food,commission=drinks?105:o.commission;
      return {...o,id:`${scope.prefix}-${o.id}`,skuId:sku.id,food,commission,foodCost:sku.foodFen,packagingCost:drinks?50:o.packagingCost,labor:drinks?50:o.labor,
        settlement:food+o.packaging+o.platformSubsidy-o.merchantSubsidy-commission-o.merchantDelivery-o.advertising,
        paid:food+o.packaging+o.customerDelivery-o.platformSubsidy-o.merchantSubsidy,evidence:`${scope.prefix}-${o.evidence}`};
    });
    sku.contract.priceFen=sampleOrders[0]!.settlement;skus.push(sku);orders.push(...sampleOrders);
  }
}
export function quotes(sku:Sku):Quote[] {
  const i=skus.findIndex(s=>s.id===sku.id),o=orders.find(o=>o.skuId===sku.id)!,unit=units.find(u=>u.id===sku.unitId)!;
  const base:Quote={platform:'京东外卖',entry:'京东 App 外卖',payable:o.paid,menu:o.food,packaging:100,delivery:300,discount:o.platformSubsidy+o.merchantSubsidy,form:'direct',store:sku.store,address:`${sku.city}市${sku.area}经营街 ${[...new Set(skus.map(s=>s.store))].indexOf(sku.store)+1} 号`,item:sku.name,spec:sku.spec,quantity:1,options:'标准口味，不加配',user:`平台${unit.user} / 本店${unit.user} · 非会员 · 普通券资格已核对`,point:`${sku.city}${sku.area}配送点`,fulfillment:'配送',at:'2026-11-06T11:32:00+08:00',evidence:`QUOTE-DEMO-${sku.id}-JD`,eligible:true,available:true};
  return [base,{...base,platform:'美团',entry:'美团 App 外卖',payable:o.paid-150,form:'coupon',discount:base.discount!+150,at:'2026-11-06T11:34:00+08:00',user:i%5===1?'会员专享 · 券资格未核对':base.user,eligible:i%5!==1,evidence:`QUOTE-DEMO-${sku.id}-MT`},
    {...base,platform:'淘宝闪购',entry:'淘宝闪购',payable:i%3===0?null:o.paid+80,discount:i%3===0?null:base.discount!-80,available:i%3!==0,at:i%3===1?'2026-11-06T11:46:00+08:00':'2026-11-06T11:35:00+08:00',evidence:`QUOTE-DEMO-${sku.id}-TB`}];
}
export function seedTasks():Task[] {
  const sku=skus[0]!,m=metrics(orders.filter(o=>o.skuId===sku.id),skus);
  const input:SimulationInput={kind:'subsidy',targetFen:80,response:-4,competitor:false,oldOnly:false,oldShare:0,budgetFen:50000,floorFen:200,maxLossFen:10000};
  const sim=simulate(m,input);
  return [{id:'ACT-DEMO-001',skuId:sku.id,kind:'subsidy',title:'收窄新客午市补贴',owner:'城市运营',deadline:'2026-11-07',originalFen:400,targetFen:80,
    budgetFen:50000,expectedSpend:Math.max(...sim.rows.map(r=>r.subsidy)),merchant:Math.min(...sim.rows.map(r=>r.merchant)),floorFen:200,
    notice:'2026-10-30T09:00:00+08:00',effective:'2026-11-07T09:00:00+08:00',end:'2026-12-04T23:59:00+08:00',initiator:'平台',funder:'平台',merchantConfirmed:true,exitRecord:'商家确认：可随时申请退出，运营当日处理',contractAllowed:true,platformAllowed:true,
    simulationPassed:sim.reasons.length===0,businessApproved:false,financeApproved:false,status:'approval',originalEvidence:'CONFIG-DEMO-001：每单平台补贴 4.00 元',afterEvidence:'',executor:'',executedAt:'',rollbackEvidence:'',
    audit:[{at:'2026-11-06T16:00:00+08:00',actor:'经营分析',event:'保存动作与情景测算；等待业务和财务审批'}],input,scenarios:sim.rows}];
}

