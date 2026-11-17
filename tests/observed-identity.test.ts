import test from 'node:test';
import assert from 'node:assert/strict';
import {observedStore,observedItem,observedSingleBasket,payableEvidenceNodes} from '../src/adapters/observed-identity.js';
import type {U2Node} from '../src/adapters/meituan-semantic.js';
const node=(text:string,top=20):U2Node=>({text,desc:'',cls:'',rid:'',left:10,top,width:160,height:20});
test('实际门店必须有唯一店名及同城商家地址',()=>{
  const rows=[node('测试品牌（甲店）'),node('商家地址：天津市测试路1号')];
  assert.equal(observedStore(rows,'测试品牌','天津市')?.address,'天津市测试路1号');
  assert.equal(observedStore([rows[0]!],'测试品牌','天津市'),null);
  assert.equal(observedStore([rows[0]!,node('收货地址：天津市测试路1号')],'测试品牌','天津市'),null);
  assert.equal(observedStore([...rows,node('测试品牌（乙店）')],'测试品牌','天津市'),null);
});
test('应付金额要求唯一标签和同一行右侧金额',()=>{
  const a=node('实付'), b={...node('¥20'),left:200};
  assert.deepEqual(payableEvidenceNodes([a,b],{'实付':'¥20'}),[a,b]);
  assert.equal(payableEvidenceNodes([a,b,{...b,top:120}],{'实付':'¥20'}),null);
  assert.equal(payableEvidenceNodes([a,{...b,top:500}],{'实付':'¥20'}),null);
});
test('实际商品名称与规格必须唯一且相邻',()=>{
  const rows=[node('鸡腿堡',20),node('1人份',50),{...node('',10),height:80}];
  assert.equal(observedItem(rows,'鸡腿堡','1人份')?.name,'鸡腿堡');
  assert.equal(observedItem(rows,'鸡腿堡','双人份'),null);
  assert.equal(observedItem([...rows,node('鸡腿堡',120)],'鸡腿堡','1人份'),null);
  assert.equal(observedItem([rows[0]!,node('1人份',500)],'鸡腿堡','1人份'),null);
  assert.equal(observedItem(rows.slice(0,2),'鸡腿堡','1人份'),null);
  assert.equal(observedSingleBasket([...rows,node('共1件')],'鸡腿堡','1人份'),true);
  assert.equal(observedSingleBasket(rows,'鸡腿堡','1人份'),false);
});
