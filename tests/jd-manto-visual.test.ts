import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPageKind, looksLikeNodeLessLayout } from '../src/adapters/jd-manto-visual.js';

test('页面类型只认商品详情和结算页', () => {
  assert.equal(classifyPageKind('item_detail'), 'item_detail');
  assert.equal(classifyPageKind('checkout'), 'checkout');
  assert.equal(classifyPageKind('other'), 'other');
  assert.equal(classifyPageKind(undefined), 'other');
  assert.equal(classifyPageKind('CHECKOUT'), 'other');
});

test('节点很少且截图有效时判定为需要视觉兜底', () => {
  assert.equal(looksLikeNodeLessLayout(0, 200_000), true);
  assert.equal(looksLikeNodeLessLayout(4, 20_000), true);
  assert.equal(looksLikeNodeLessLayout(20, 200_000), false);
  assert.equal(looksLikeNodeLessLayout(0, 1_000), false);
});
