export const UE_VERSION = 'UE-V1-demo';
export const AS_OF = '2026-11-06';
export const DEMO_SHARED_BUDGET_FEN = 500000;
export type Form = 'direct' | 'coupon' | 'mixed' | 'unknown';
export type Quality = 'observed' | 'derived' | 'estimated' | 'missing';
export type Money = number | null;
export interface Unit { id:string; city:string; area:string; tier:string; category:string; user:'新客'|'老客'; period:'午市'|'晚市'; channel:string }
export interface Contract {
  id:string; from:string; to:string; region:string; valid:boolean; priceFen:Money; sharing:boolean;
  settlementEvidence:string; settlementMatches:boolean; contractEvidence:string; allowed:Form[];
  missing:string; version:number;
}
export interface Sku { id:string; name:string; spec:string; brand:string; store:string; city:string; area:string; category:string; unitId:string; is_baoxiao:boolean|null; contract:Contract; foodFen:Money; naturalOrders:number; naturalBeforeFen:number; quality:Quality }
export interface Order {
  id:string; skuId:string; date:string; status:'completed'|'cancelled'|'paid'; form:Form; origin:'synthetic';
  food:number; packaging:number; merchantDeliveryIncome:number; customerDelivery:number; commission:number; merchantDelivery:number; advertising:number; otherRevenue:number;
  platformSubsidy:number; merchantSubsidy:number; brandSubsidy:number; rider:number; riderSubsidy:number; variable:Money;
  settlement:number; foodCost:Money; packagingCost:number; refund:number; labor:number; paid:number;
  repurchase:boolean; badReview:boolean; minutes:number; evidence:string;
}
export interface Quote { platform:string; entry:string; payable:Money; menu:Money; packaging:Money; delivery:Money; discount:Money; form:Form; store:string; address:string; item:string; spec:string; quantity:number; options:string; user:string; point:string; fulfillment:string; at:string; evidence:string; eligible:boolean; available:boolean }
export interface Ledger { before:Money; platform:Money; merchant:Money; revenue:number; variable:Money }
export const sumKnown=(values:Money[]):Money=>values.some(v=>v===null)?null:values.reduce<number>((s,v)=>s+v!,0);
export function classify(sku:Sku, day=AS_OF, city=sku.city):{baoxiao:boolean;reasons:string[]} {
  return {baoxiao:sku.is_baoxiao===true,reasons:sku.is_baoxiao===true?[]:[sku.is_baoxiao===false?'内部清单标记为非包销':'包销标记未提供']};
}
export function ledger(o:Order):Ledger {
  const revenue=o.commission+o.merchantDelivery+o.customerDelivery+o.advertising+o.otherRevenue;
  const variable=o.variable===null?null:o.rider+o.riderSubsidy+o.variable;
  const before=variable===null?null:revenue-variable;
  return {revenue,variable,before,platform:before===null?null:before-o.platformSubsidy,
    merchant:o.foodCost===null?null:o.settlement-o.foodCost-o.packagingCost-o.refund-o.labor};
}
export interface Metrics {
  n:number; windowDays:number; before:Money; platform:Money; merchant:Money; platformTotal:Money; merchantTotal:Money;
  subsidy:number; merchantSubsidy:number; brandSubsidy:number; paid:number; gmv:number; roi:number|null; incremental:Money;
  baselineContribution:number; food:number; rider:number; refunds:number; repurchase:number; badReview:number; minutes:number; validPlatform:number; validMerchant:number; lowPrice:number;
}
export function metrics(orders:Order[],skus:Sku[],days=28):Metrics {
  const selected=orders.filter(o=>o.status==='completed'), n=selected.length;
  const books=selected.map(ledger), sum=(fn:(o:Order)=>number)=>selected.reduce((a,o)=>a+fn(o),0);
  const platformTotal=sumKnown(books.map(b=>b.platform)), merchantTotal=sumKnown(books.map(b=>b.merchant));
  const beforeTotal=sumKnown(books.map(b=>b.before));
  const subsidy=sum(o=>o.platformSubsidy);
  const ids=new Set(selected.map(o=>o.skuId));
  const baselineContribution=skus.filter(s=>ids.has(s.id)).reduce((a,s)=>a+Math.round(s.naturalOrders*days/28)*s.naturalBeforeFen,0);
  const incremental=beforeTotal===null?null:beforeTotal-baselineContribution;
  return {n,windowDays:days,before:n&&beforeTotal!==null?beforeTotal/n:null,platform:n&&platformTotal!==null?platformTotal/n:null,
    merchant:n&&merchantTotal!==null?merchantTotal/n:null,platformTotal,merchantTotal,subsidy,merchantSubsidy:sum(o=>o.merchantSubsidy),brandSubsidy:sum(o=>o.brandSubsidy),
    paid:sum(o=>o.paid),gmv:sum(o=>o.food+o.packaging),roi:subsidy>0&&incremental!==null?incremental/subsidy:null,incremental,baselineContribution,
    food:sum(o=>o.food),rider:sum(o=>o.rider),refunds:sum(o=>o.refund>0?1:0),repurchase:sum(o=>o.repurchase?1:0),badReview:sum(o=>o.badReview?1:0),minutes:sum(o=>o.minutes),
    validPlatform:books.filter(b=>b.platform!==null).length,validMerchant:books.filter(b=>b.merchant!==null).length,lowPrice:sum(o=>o.paid<1500?1:0)};
}
export type Diagnosis='healthy'|'subsidy'|'structure'|'unproven'|'insufficient'|'missing';
export function diagnose(m:Metrics,level:'unit'|'sku',days=28):Diagnosis {
  if(days<28||m.n<(level==='unit'?100:30))return 'insufficient';
  if(m.platform===null||m.before===null)return 'missing';
  if(m.before<0)return 'structure';
  if(m.platform>=0)return 'healthy';
  if(m.roi!==null&&m.roi<1)return 'subsidy';
  return 'unproven';
}
export function compare(a:Quote,b:Quote,sample=30):{reasons:string[];delta:Money;index:number|null;percent:number|null;differentForm:boolean} {
  const reasons:string[]=[];
  if(!a.store||!a.address||a.store!==b.store||a.address!==b.address)reasons.push('实体门店名称或营业地址不一致');
  if(!a.item||!a.spec||!a.options||a.item!==b.item||a.spec!==b.spec||a.quantity!==b.quantity||a.options!==b.options)reasons.push('商品、规格、选项或数量不一致');
  if(a.user!==b.user||!a.eligible||!b.eligible)reasons.push('用户、会员或券资格未对齐');
  if(a.fulfillment!==b.fulfillment||a.point!==b.point)reasons.push('履约方式或配送点位不同');
  if(!Number.isFinite(Date.parse(a.at))||!Number.isFinite(Date.parse(b.at))||Math.abs(Date.parse(a.at)-Date.parse(b.at))>300000)reasons.push('观察时间差超过 5 分钟或时间缺失');
  if(!a.available||!b.available||a.payable===null||b.payable===null)reasons.push('没有有效结算应付');
  const delta=reasons.length?null:a.payable!-b.payable!;
  const index=reasons.length||b.payable===0||sample<30?null:a.payable!/b.payable!;
  return {reasons,delta,index,percent:index===null?null:(index-1)*100,differentForm:a.form!==b.form};
}
export function allocate(totalFen:number,weights:number[]):number[] {
  if(!Number.isSafeInteger(totalFen)||totalFen<0||!weights.length||weights.some(w=>!Number.isSafeInteger(w)||w<0)||weights.reduce((a,b)=>a+b,0)<=0)throw new Error('分摊金额和参与基数必须为非负整数，合计大于零');
  const total=weights.reduce((a,b)=>a+b,0), result=weights.map(w=>Math.floor(totalFen*w/total));
  const last=weights.findLastIndex(w=>w>0);result[last]!+=totalFen-result.reduce((a,b)=>a+b,0);return result;
}
export type ActionKind='subsidy'|'price'|'supply';
export interface SimulationInput { kind:ActionKind; targetFen:number; response:number; competitor:boolean; oldOnly:boolean; oldShare:number; budgetFen:number; floorFen:number; maxLossFen:number }
export interface Scenario { label:string; n:number; ue:number; merchant:number; subsidy:number; profit:number; incrementalProfit:number; roi:number|null; payback:string }
export function simulate(m:Metrics,input:SimulationInput):{rows:Scenario[];reasons:string[];noAction:number|null;model:string} {
  const reasons:string[]=[];
  if(m.windowDays<28||m.n<30||m.before===null||m.platform===null||m.merchant===null)return {rows:[],reasons:['需要完整四周、至少 30 单，并补齐平台和商家成本后才能测算'],noAction:m.platformTotal,model:'按假设测算'};
  if(![input.targetFen,input.response,input.budgetFen,input.floorFen,input.maxLossFen].every(Number.isFinite)||input.targetFen<0||input.budgetFen<0||input.floorFen<0||input.maxLossFen<0||Math.abs(input.response)>50)return {rows:[],reasons:['输入金额或订单变化假设无效'],noAction:m.platformTotal,model:'规则情景 v1'};
  if(input.oldOnly&&input.oldShare===0)return {rows:[],reasons:['当前样本全部为新客，缺少仅老客情景的基线'],noAction:m.platformTotal,model:'规则情景 v1 · 低置信度'};
  const share=input.oldOnly?input.oldShare:1, baseN=Math.round(m.n*share), baseline=m.baselineContribution*share;
  const rows=[{label:'乐观',shift:5,cost:0},{label:'基准',shift:0,cost:0},{label:'悲观',shift:-8,cost:25}].map(s=>{
    const n=Math.max(0,Math.round(baseN*(1+(input.response+s.shift-(input.competitor?8:0))/100)));
    const userSub=input.kind==='subsidy'?input.targetFen:m.subsidy/m.n;
    const before=m.before!+(input.kind==='price'?input.targetFen*.05:input.kind==='supply'?input.targetFen:0)-s.cost;
    const ue=before-userSub, merchant=m.merchant!+(input.kind==='price'?input.targetFen*.95:input.kind==='subsidy'?userSub-m.subsidy/m.n:0);
    const subsidy=Math.round(userSub*n), profit=Math.round(ue*n), incrementalProfit=Math.round(profit-m.platform!*baseN);
    return {label:s.label,n,ue,merchant,subsidy,profit,incrementalProfit,roi:subsidy>0?(before*n-baseline)/subsidy:null,payback:incrementalProfit>0?'本观察窗贡献改善；缺前置投入，回本期未计算':'本观察窗未回本'};
  });
  if(rows.some(r=>r.subsidy>input.budgetFen))reasons.push('情景补贴支出超过预算');
  if(input.kind==='supply'&&input.targetFen>m.rider/m.n)reasons.push('履约成本减少额超过当前配送成本');
  if(rows.some(r=>r.merchant<input.floorFen))reasons.push('商家单均贡献低于底线');
  if(rows.some(r=>r.profit < -input.maxLossFen))reasons.push('最坏情景亏损超过容忍金额');
  if(rows[1]!.roi===null||rows[1]!.roi!<1)reasons.push('基准情景补贴 ROI 未达到 1');
  if(rows[1]!.incrementalProfit<=0)reasons.push('基准情景未改善平台贡献');
  return {rows,reasons,noAction:m.platformTotal,model:'规则情景 v1 · 低置信度'};
}
export interface Task {
  id:string; skuId:string; kind:ActionKind; title:string; owner:string; deadline:string; originalFen:number; targetFen:number;
  budgetFen:number; expectedSpend:number; merchant:number; floorFen:number; notice:string; effective:string; end:string;
  initiator:'平台'|'商家'|'品牌'; funder:'平台'|'商家'|'品牌'; merchantConfirmed:boolean; exitRecord:string; contractAllowed:boolean; platformAllowed:boolean;
  simulationPassed:boolean; businessApproved:boolean; financeApproved:boolean; status:'approval'|'ready'|'executed'|'rolledback';
  originalEvidence:string; afterEvidence:string; executor:string; executedAt:string; rollbackEvidence:string;
  audit:{at:string;actor:string;event:string}[]; input:SimulationInput; scenarios:Scenario[];
}
export function executionIssues(task:Task,tasks:Task[],role:string,at:string,sku?:Sku):string[] {
  const errors:string[]=[];
  if(!task.simulationPassed)errors.push('仿真未通过');
  if(!task.businessApproved||!task.financeApproved)errors.push('业务与财务审批尚未齐全');
  if(!['运营执行','产品管理员'].includes(role))errors.push('当前角色没有执行权限');
  if(!task.contractAllowed||!task.platformAllowed||sku&&(!classify(sku).baoxiao||!sku.contract.valid||sku.contract.from>task.effective.slice(0,10)||sku.contract.to<task.end.slice(0,10)))errors.push('合同或平台规则不满足');
  if(task.expectedSpend>task.budgetFen)errors.push('预计补贴支出超过预算');
  const reserved=tasks.filter(t=>t.id!==task.id&&['ready','executed'].includes(t.status)).reduce((a,t)=>a+t.expectedSpend,0);
  if(reserved+task.expectedSpend>DEMO_SHARED_BUDGET_FEN)errors.push('已承诺补贴与本任务合计超过试点共享预算');
  if(task.merchant<task.floorFen)errors.push('商家贡献未守住底线');
  if(task.initiator==='平台'&&task.funder!=='平台')errors.push('平台促销费用不得转由商家或品牌承担');
  if(!task.merchantConfirmed||!task.exitRecord.trim())errors.push('缺商家确认或退出记录');
  const effective=Date.parse(task.effective), notice=Date.parse(task.notice), end=Date.parse(task.end), now=Date.parse(at);
  if(![effective,notice,end,now].every(Number.isFinite)||effective-notice<7*86400000)errors.push('告知到生效时间未满 7 天');
  if(Number.isFinite(effective)&&Number.isFinite(end)&&(end<=effective||now<effective||now>end))errors.push('当前时间不在活动生效窗口内');
  if(tasks.some(t=>t.id!==task.id&&t.skuId===task.skuId&&t.status!=='rolledback'&&Date.parse(t.effective)<end&&Date.parse(t.end)>effective))errors.push('同一 SKU 存在时间重叠的互斥活动');
  if(!task.owner.trim()||!task.deadline||!task.originalEvidence.trim())errors.push('缺负责人、截止时间或原始配置凭据');
  return errors;
}
