import test from 'node:test';
import assert from 'node:assert/strict';
import { validator, type Supply } from '../src/domain/competition.js';
import type { Evidence } from '../src/domain/contracts.js';
import { jdRunInputSchema, jdShelfSalesWindow, matchesJdStore, parseJdSalesLabel, rankJdShelfItems, validateJdShelfResult,
  type JdRunInput, type JdShelfItem, type JdShelfResult } from '../src/domain/jd-shelf.js';

const input: JdRunInput={requestId:'243d7d79-7727-46f8-9faa-137cab9bf712',city:'天津市',district:'南开区',brand:'麦当劳',
  storeName:'麦当劳天津鞍山西道店',businessAddress:'南开区鞍山西道 100 号',profileId:'test-profile'};
const store: Supply['store']={key:'store-1',city:'天津',brand:'麦当劳＆麦咖啡',name:'麦当劳＆麦咖啡（天津鞍山西道店）',address:'天津市南开区鞍山西道100号'};
const id='d67733fd-27ed-4bdf-ae8e-9c5904585501';
const evidence: Evidence={id,sha256:'a'.repeat(64),screenshot:`/api/evidence/${id}.png`,text_file:`/api/evidence/${id}.json`,
  captured_at:'2026-11-06T04:00:00.000Z',page_stage:'shelf'};

function item(position:number, label:string, extra:Partial<JdShelfItem>={}):JdShelfItem {
  const key=`item-${position}`,name=`演练商品 ${position}`;
  return {key,rawName:name,kind:'single',spec:'1人份',sales:parseJdSalesLabel(label),position,evidence,excludedReason:null,
    supply:{store,item:{key,name,kind:'single',spec:'1人份',options:[],parts:null}},...extra};
}

test('只解析可辨认的已售标签，保留单位、时间口径和下限',()=>{
  assert.deepEqual(parseJdSalesLabel('板烧鸡腿堡，已售39，0油添加'),{raw:'板烧鸡腿堡，已售39，0油添加',window:'page_unspecified',value:39,qualifier:'exact'});
  assert.deepEqual(parseJdSalesLabel('月售１.２万＋'),{raw:'月售１.２万＋',window:'month',value:12_000,qualifier:'lower_bound'});
  assert.equal(parseJdSalesLabel('月售0.07万+份')?.value,700);
  assert.equal(parseJdSalesLabel('已售1,234件')?.value,1234);
  assert.equal(parseJdSalesLabel('已售0')?.value,0);
  for (const label of ['热销','销量领先','39','已售','已售1.2万','已售20-50','已售20至50','已售20万-50万','已售3.8份','已售999999999999,000,000','月售99，已售5']) {
    assert.equal(parseJdSalesLabel(label),null,label);
  }
});

test('只比较同口径的已核实单品，限五项，真实销量排序可代替数量',()=>{
  const items=[item(1,'已售39'),item(2,'已售55'),item(3,'已售55+'),item(4,'月售1000'),item(5,'已售88',{kind:'set'}),
    item(6,'已售87',{kind:'unknown'}),item(7,'已售86',{spec:null}),item(8,'已售0'),item(9,'热卖'),item(10,'已售37'),item(11,'已售36'),item(12,'已售35')];
  assert.equal(jdShelfSalesWindow(items),'page_unspecified');
  assert.deepEqual(rankJdShelfItems(items,'partial',7).map(row=>row.position),[2,3,1,10,11]);
  assert.deepEqual(rankJdShelfItems(items,'sales_order').map(row=>row.position),[1,2,3,4,9]);
  assert.deepEqual(rankJdShelfItems([items[3]!,items[8]!],'complete').map(row=>row.position),[4]);
  assert.deepEqual(rankJdShelfItems([items[7]!,items[8]!],'partial'),[]);
});

test('实体门店核验允许已知品牌别名，拦截短名、同名异址、行政区差异',()=>{
  assert.equal(matchesJdStore(input,store),true);
  assert.equal(matchesJdStore(input,{...store,name:'鞍山西道店',address:'鞍山西道100号'},'南开区'),true);
  assert.equal(matchesJdStore(input,{...store,name:'麦当劳（天津鞍…）'}),false);
  assert.equal(matchesJdStore(input,{...store,address:'天津市南开区鞍山西道101号'}),false);
  assert.equal(matchesJdStore(input,{...store,address:'鞍山西道100号'}),false);
  assert.equal(matchesJdStore(input,store,'河西区'),false);
  assert.equal(matchesJdStore(input,{...store,brand:'麦咖啡'}),false);
});

test('单品试采可以用已核对的规格建任务，无需销量',()=>{
  const items=[item(1,'', {sales:null,salesRaw:null})];
  const result:JdShelfResult={store,evidence,coverage:'direct_single',scannedCount:1,stopReason:'pilot_direct_single',items,selected:rankJdShelfItems(items,'direct_single')};
  assert.equal(result.selected.length,1);
  assert.equal(validateJdShelfResult(result),result);
  assert.throws(()=>validateJdShelfResult({...result,items:[item(1,'已售1')]}),/invalid_jd_direct_single/);
});

test('请求使用 UUID，货架结果拒绝篡改数值、排行和外部证据',()=>{
  const parse=validator<JdRunInput>(jdRunInputSchema,'请求');
  assert.deepEqual(parse(input),input);
  assert.throws(()=>parse({...input,requestId:'bad'}));
  assert.throws(()=>parse({...input,businessAddress:'  '}));
  const items=[item(1,'已售39'),item(2,'已售55')];
  const result:JdShelfResult={store,evidence,coverage:'complete',scannedCount:2,stopReason:'到达菜单末尾',items,selected:rankJdShelfItems(items,'complete')};
  assert.equal(validateJdShelfResult(result),result);
  assert.throws(()=>validateJdShelfResult({...result,selected:[...result.selected].reverse()}),/invalid_jd_shelf_ranking/);
  assert.throws(()=>validateJdShelfResult({...result,items:[{...items[0]!,sales:{...items[0]!.sales!,value:40}},items[1]!]}),/invalid_jd_shelf_evidence/);
  assert.throws(()=>validateJdShelfResult({...result,evidence:{...evidence,screenshot:'https://outside.invalid/evidence.png'}}),/invalid_jd_shelf_evidence/);
});
