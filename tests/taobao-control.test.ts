import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTaobaoControl} from '../src/adapters/taobao-control.js';
import type {U2Node} from '../src/adapters/meituan-semantic.js';
const node=(text:string,top:number,left=100):U2Node=>({text,desc:'',cls:'',rid:'',left,top,width:100,height:20});
const bounds={xMin:0,xMax:400,yMin:0,yMax:800};
test('识别真实首页的未选中闪购标签，忽略同位置的子文字',()=>{
  const tab=node('闪购,未选中',100), child=node('闪购',100);
  assert.equal(selectTaobaoControl([tab,child],{tag:'flash-tab',brand:'测试',bounds}),tab);
});
test('淘宝只选择目标商品所在行的唯一加号，不选择套餐',()=>{
  const item=node('鸡腿堡',200), add=node('+',220), set=node('选套餐',205), other=node('+',500);
  assert.equal(selectTaobaoControl([item,add,set,other],{tag:'add-item',brand:'测试',itemNode:item,bounds}),add);
  assert.equal(selectTaobaoControl([item,add,{...add,left:250}],{tag:'add-item',brand:'测试',itemNode:item,bounds}),null);
  assert.equal(selectTaobaoControl([{...item,top:300},add],{tag:'add-item',brand:'测试',itemNode:item,bounds}),null);
  assert.equal(selectTaobaoControl([item,set],{tag:'add-item',brand:'测试',itemNode:item,bounds}),null);
});
test('淘宝同屏多个候选时停止，不取第一个',()=>{
  assert.equal(selectTaobaoControl([node('搜索',80),node('搜索',100)],{tag:'brand-search',brand:'测试',bounds}),null);
  assert.equal(selectTaobaoControl([node('测试（甲店）',80),node('测试（乙店）',120)],{tag:'store',brand:'测试',bounds}),null);
});
