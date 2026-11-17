import test from 'node:test';
import assert from 'node:assert/strict';
import {cartIsExplicitlyEmpty,ownedCartRemoveControl} from '../src/adapters/cart-safety.js';
import type {U2Node} from '../src/adapters/meituan-semantic.js';

const node=(text:string,top=100):U2Node=>({text,desc:'',cls:'',rid:'',left:0,top,width:100,height:20});
test('购物车操作只接受明确空车证据',()=>{
  assert.equal(cartIsExplicitlyEmpty([node('购物车为空')]),true);
  assert.equal(cartIsExplicitlyEmpty([node('购物车'),node('¥0')]),false);
  assert.equal(cartIsExplicitlyEmpty([node('购物车为空'),node('共1件')]),false);
  assert.equal(cartIsExplicitlyEmpty([{...node('购物车为空'),width:0}]),false);
});
test('只在单件、同品、同规格和唯一减购按钮都可核验时恢复',()=>{
  const nodes=[node('购物车'),node('共1件'),node('鸡腿堡'),node('1人份'),node('减少'),{...node(''),top:90,height:40}];
  assert.equal(ownedCartRemoveControl(nodes,'鸡腿堡','1人份'),nodes[4]);
  assert.equal(ownedCartRemoveControl(nodes,'鸡腿堡','双人份'),null);
  assert.equal(ownedCartRemoveControl([...nodes,node('减少')],'鸡腿堡','1人份'),null);
  assert.equal(ownedCartRemoveControl(nodes.filter(n=>n.text!=='共1件'),'鸡腿堡','1人份'),null);
  assert.equal(ownedCartRemoveControl(nodes.map(n=>n.text==='共1件'?{...n,width:0}:n),'鸡腿堡','1人份'),null);
  assert.equal(ownedCartRemoveControl(nodes.map(n=>n.text==='鸡腿堡'?{...n,width:0}:n),'鸡腿堡','1人份'),null);
  assert.equal(ownedCartRemoveControl([...nodes,node('共2件')],'鸡腿堡','1人份'),null);
});
