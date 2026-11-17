import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVisualRead} from '../src/adapters/visual-checkout.js';

test('视觉读取：结算页金额清洗与页面类型', () => {
  const read = normalizeVisualRead({
    pageKind: 'checkout', payable: '¥21.23', subtotal: '26.5元', packaging: '1.1', delivery: null, other: null,
    discount: '-12.37', itemName: '板烧鸡腿堡', itemQuantity: '1', subtotalBasis: 'before_discount', feesSeparate: '0', coupons: [],
  });
  assert.equal(read.pageKind, 'checkout');
  assert.equal(read.payable, '21.23');
  assert.equal(read.subtotal, '26.5');
  assert.equal(read.discount, '-12.37');
  assert.equal(read.itemQuantity, 1);
  assert.equal(read.feesSeparate, false);
  assert.equal(read.subtotalBasis, 'before_discount');
});

test('视觉读取：商品详情页单独标记，非法金额按未知处理', () => {
  const read = normalizeVisualRead({pageKind: 'item_detail', payable: '14.5', delivery: '免费', discount: 'abc', itemQuantity: 2});
  assert.equal(read.pageKind, 'item_detail');
  assert.equal(read.payable, '14.5');
  assert.equal(read.delivery, null);
  assert.equal(read.discount, null);
  assert.equal(read.itemQuantity, 2);
});

test('视觉读取：缺省字段不是零，页面类型默认 other', () => {
  const read = normalizeVisualRead({});
  assert.equal(read.pageKind, 'other');
  assert.equal(read.payable, null);
  assert.equal(read.packaging, null);
  assert.equal(read.delivery, null);
  assert.equal(read.itemQuantity, null);
  assert.equal(read.subtotalBasis, 'unknown');
  assert.deepEqual(read.coupons, []);
});
