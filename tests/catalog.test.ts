import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UiNode } from '@midscene/core';
import { parseCatalog, catalogTemplate, type CatalogImport, type CatalogRow } from '../src/domain/monitor-catalog.js';
import { SqliteStore } from '../src/infra/sqlite-store.js';
import { CompetitionStore } from '../src/infra/competition-store.js';
import { AndroidSources } from '../src/adapters/android-source.js';
import { moneyFen, semanticFees, verifyField } from '../src/adapters/checkout-reading.js';
import type { Evidence } from '../src/domain/contracts.js';

const row:CatalogRow={city:'天津市',district:'南开区',brand:'测试品牌',storeName:'测试品牌（鞍山西道店）',itemName:'鸡腿堡',spec:'1人份',is_baoxiao:true,storeId:'internal-store',skuId:'internal-sku',options:[]};
const input:CatalogImport={mode:'commit',source:'internal',records:[row]};
test('清单明确包销标记，CSV 与 JSON 同口径；重复与缺规格被拒绝',()=>{
  const csv=catalogTemplate+'天津市,南开区,测试品牌,测试品牌（鞍山西道店）,鸡腿堡,1人份,是,internal-store,internal-sku,\r\n';
  assert.deepEqual(parseCatalog({mode:'preview',source:'internal',csv}),parseCatalog(input));
  assert.throws(()=>parseCatalog({...input,records:[row,{...row}]}),/重复/);
  assert.throws(()=>parseCatalog({...input,records:[{...row,spec:' '}]}),/清单/);
  assert.throws(()=>parseCatalog({...input,source:'trial'}),/试采/);
  assert.equal(parseCatalog({...input,records:[{...row,is_baoxiao:null}]} )[0]!.is_baoxiao,null);
});
test('预览不入库；重复导入及请求幂等；修订保留原任务并使旧映射失效',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'specified-catalog-'));
  const legacy=new SqliteStore(join(dir,'test.sqlite'));
  const market=new CompetitionStore(legacy,await AndroidSources.load(join(dir,'absent.json')));
  try{
    market.importCatalog({...input,mode:'preview'});assert.equal(market.catalog().length,0);
    const first=market.importCatalog(input);assert.equal(first.imported,1);
    assert.equal(market.importCatalog(input).duplicate,true);assert.equal(market.catalog().length,1);
    market.saveProfile({id:'test',name:'老客非会员',city:'天津市',point:'测试配送地址',eligibility:{}});
    const targetId=first.entries[0]!.id, requestId=randomUUID();
    const run=market.startSpecifiedRun({requestId,targetId,profileId:'test'});
    assert.equal(market.startSpecifiedRun({requestId,targetId,profileId:'test'}),run);
    assert.throws(()=>market.startSpecifiedRun({requestId,targetId,profileId:'other'}),/conflict/);
    const task=legacy.snapshot(run).slots[0]!.task;
    assert.equal(task.shelf,undefined);assert.equal(task.live?.quantity,1);assert.ok(market.mappingCurrent(task));
    market.importCatalog({...input,records:[{...row,spec:'2人份'}]});
    assert.equal(market.catalog()[0]!.id,targetId);assert.equal(market.mappingCurrent(task),false);
    assert.equal(legacy.snapshot(run).slots[0]!.task.live?.target.supply.item.spec,'1人份');
    market.importCatalog({...input,records:[{...row,is_baoxiao:null}]});
    assert.throws(()=>market.startSpecifiedRun({requestId:randomUUID(),targetId,profileId:'test'}),/标记/);
    assert.equal(legacy.db.prepare('SELECT count(*) n FROM market_orders').get()?.n,0);
  }finally{legacy.close();}
});
const node=(text:string,x:number,y:number):UiNode=>({type:'text',attrs:{text},bounds:{left:x,top:y,width:70,height:20},children:[]});
const evidence:Evidence={id:randomUUID(),screenshot:'/test.png',sha256:'a'.repeat(64),captured_at:new Date().toISOString(),page_stage:'checkout',data_mode:'live'} as Evidence;
test('费用只读取明确行；免费与未知分开；双金额不可直接当作实收',()=>{
  const a=semanticFees([node('配送费',10,20),node('免费',100,20),node('包装费',10,60),node('¥1.00',100,60)]);
  assert.equal(moneyFen(a.readings.delivery?.raw),0);assert.equal(moneyFen(a.readings.packaging?.raw),100);
  assert.equal(moneyFen(null),null);
  assert.equal(moneyFen('-21.60'),null);assert.equal(moneyFen('-4',true),400);
  const b=semanticFees([node('配送费',10,20),node('¥5',100,20),node('¥0',200,20)]);
  assert.equal(b.readings.delivery,undefined);
  assert.equal(verifyField('delivery',a.readings.delivery,'¥0',evidence).status,'verified');
  assert.equal(verifyField('packaging',a.readings.packaging,'¥2',evidence).status,'mismatch');
  assert.equal(verifyField('delivery',undefined,'¥0',evidence).fen,null);
});
