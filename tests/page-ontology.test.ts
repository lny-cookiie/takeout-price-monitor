import test from 'node:test';
import assert from 'node:assert/strict';
import type {UiNode} from '@midscene/core';
import {businessEntities,businessRelations,quoteFieldDefinitions,supplyFieldDefinitions,publicPageMap,mapVersion} from '../src/domain/page-ontology.js';
import {ReviewedScreen} from '../src/adapters/android-collector.js';
import {flatten} from '../src/adapters/android-page.js';
import {semanticFees,moneyFen} from '../src/adapters/checkout-reading.js';
import type {AndroidSource} from '../src/adapters/android-source.js';
import type {AndroidSession} from '../src/adapters/android-transport.js';
import {canReuseJdIdentity} from '../src/adapters/jd-shelf-collector.js';
import {digest} from '../src/domain/competition.js';
import type {JdRunInput} from '../src/domain/jd-shelf.js';
import type {Evidence} from '../src/domain/contracts.js';

test('本体关系和字段引用存在；未接平台不得写成已验证地图',()=>{
  const ids=new Set<string>(businessEntities.map(e=>e.id));
  for(const [from,,to]of businessRelations){assert.ok(ids.has(from));assert.ok(ids.has(to));}
  const fields=[...Object.values(quoteFieldDefinitions),...supplyFieldDefinitions];
  assert.equal(new Set(fields.map(f=>f.id)).size,fields.length);
  fields.forEach(f=>assert.ok(ids.has(f.entity)));
  for(const platform of ['meituan','taobao_instant'] as const){const map=publicPageMap(platform);assert.equal(map.status,'unverified');assert.equal(map.mapVersion,null);assert.ok(map.bindings.every(b=>b.status==='unverified'&&b.selector===null));}
  const configured={platform:'jd',appVersion:'16.1.0',entry:'本机试点',selectors:{},fields:{},point:'不能出现在公开地图里的地址'} as unknown as AndroidSource;
  assert.equal(publicPageMap('jd',configured).status,'calibrating');
  assert.notEqual(mapVersion(configured),mapVersion({...configured,appVersion:'16.2.0'}));
  assert.doesNotMatch(JSON.stringify(publicPageMap('jd',configured)),/不能出现在公开地图/);
});
const n=(text:string,cls:string,children:UiNode[]=[],clickable='false'):UiNode=>({type:'text',attrs:{text,class:'android.view.'+cls,package:'jd.app',clickable},bounds:{left:10,top:30,width:100,height:30},children});
test('购物车只认本次商品容器，不把背景菜单的同名数量当成歧义或操作对象',()=>{
  const line=n('板烧鸡腿堡 1人份，1人份','View'),quantity=n('数量1件','View'),remove=n('减少购买数量，按钮','TextView');
  const row=n('', 'View',[line,quantity,remove]);row.bounds={left:0,top:400,width:360,height:200};
  const footer=n('门店购物车，1件商品 按钮','TextView'),menuQuantity=n('数量1件','View');
  const root=n('', 'View',[menuQuantity,row,footer]);root.bounds={left:0,top:0,width:374,height:840};
  const source={package:'jd.app',selectors:{cartPanel:{text:'复选框，已选中，全选',className:'View',textPrefix:true},cartLine:{text:'{item} {spec}，{spec}',className:'View'},
    quantity:{text:'数量{quantity}件',className:'View'},remove:{text:'减少购买数量，按钮',className:'TextView'},cartCount:{text:'门店购物车，{quantity}件商品 按钮',className:'TextView'}}} as unknown as AndroidSource;
  const screen=new ReviewedScreen({} as AndroidSession,source,{item:'板烧鸡腿堡',spec:'1人份',quantity:'1'},new AbortController().signal);
  assert.deepEqual(screen.cartNodes(flatten(root)),flatten(row));
  footer.attrs.text='门店购物车，2件商品 按钮';
  assert.equal(screen.cartNodes(flatten(root),false),null);
});
test('运费说明图标不会挤掉真正的运费标签，双金额仍保持待核对',()=>{
  const label=n('运费','TextView'),info=n('运费','TextView',[],'true'),amount=n('¥6','TextView');
  label.bounds={left:20,top:200,width:30,height:20};info.bounds={left:55,top:203,width:13,height:13};amount.bounds={left:300,top:200,width:35,height:20};
  assert.equal(moneyFen(semanticFees([label,info,amount]).readings.delivery?.raw),600);
  const reference=n('¥8','TextView');reference.bounds={left:230,top:200,width:35,height:20};
  assert.equal(semanticFees([label,info,reference,amount]).readings.delivery,undefined);
});
test('近期门店身份只在同配置、同完整店名、同地址和有效时间内复用',()=>{
  const source={platform:'jd',entry:'本机试点',appVersion:'16.1.0'} as AndroidSource;
  const at=Date.now(),store={key:'platform-store',brand:'测试品牌',name:'测试品牌（南开店）',city:'天津市',address:'天津市南开区测试路1号'};
  const input:JdRunInput={requestId:'test',profileId:'test',city:store.city,district:'南开区',brand:store.brand,storeName:store.name,businessAddress:store.address,
    verifiedStoreKey:store.key,verifiedContext:{store,evidence:{captured_at:new Date(at-1000).toISOString()} as Evidence,sourceRevision:digest(source)}};
  assert.equal(canReuseJdIdentity(input,source,store.name,at),true);
  assert.equal(canReuseJdIdentity(input,source,'测试品牌（河西店）',at),false);
  assert.equal(canReuseJdIdentity(input,source,null,at),false);
  assert.equal(canReuseJdIdentity(input,{...source,appVersion:'16.2.0'},store.name,at),false);
  assert.equal(canReuseJdIdentity(input,source,store.name,at+31*60_000),false);
  assert.equal(canReuseJdIdentity({...input,businessAddress:'天津市南开区另一条路'},source,store.name,at),false);
});
test('稳定页面可复用读取；任何手机操作和明确的新检查都重新读取',async()=>{
  const root=n('', 'View',[n('菜单','TextView')]);let reads=0;
  const source={package:'jd.app'} as AndroidSource;
  const device={async getUITree(){reads++;return {root};},async tap(){},async back(){}} as unknown as AndroidSession;
  const screen=new ReviewedScreen(device,source,{},new AbortController().signal);
  await screen.nodes();await screen.nodes();assert.equal(reads,1);
  await screen.device.tap(20,20);await screen.nodes();assert.equal(reads,2);
  await screen.nodes(true);assert.equal(reads,3);
  await screen.device.back();await screen.nodes();assert.equal(reads,4);
});
