import test from 'node:test';
import assert from 'node:assert/strict';
import {popupCloseControl} from '../src/adapters/popup-safety.js';
import type {U2Node} from '../src/adapters/meituan-semantic.js';
import {jdPopupClose} from '../src/adapters/jd-shelf-collector.js';
import type {UiNode} from '@midscene/core';

const node=(text:string):U2Node=>({text,desc:'',cls:'',rid:'',left:0,top:0,width:30,height:30});
test('只关闭可识别的弹窗，禁止点击领券或不明确的关闭控件',()=>{
  const close=node('关闭');
  assert.equal(popupCloseControl([node('立即领取'),close]),close);
  assert.equal(popupCloseControl([node('立即领取')]),'unresolved');
  assert.equal(popupCloseControl([node('立即领取'),close,node('关闭')]),'unresolved');
  assert.equal(popupCloseControl([node('优惠券'),close]),null);
  assert.equal(popupCloseControl([node('立即领取'),{...close,width:0}]),'unresolved');
  assert.equal(popupCloseControl([node('立即领取'),{...node('立即领取'),top:1000}]),null);
});
test('京东等待页面时只选择唯一可见的关闭控件',()=>{
  const ui=(text:string):UiNode=>({type:'text',attrs:{text},bounds:{left:1,top:1,width:30,height:30},children:[]});
  const close=ui('关闭');
  assert.equal(jdPopupClose([ui('立即领取'),close]),close);
  assert.equal(jdPopupClose([ui('立即领取')]),'unresolved');
  assert.equal(jdPopupClose([ui('立即领取'),close,ui('关闭')]),'unresolved');
  assert.equal(jdPopupClose([ui('优惠券'),close]),null);
  assert.equal(jdPopupClose([{...ui('立即领取'),bounds:{left:0,top:0,width:0,height:0}},close]),null);
});
