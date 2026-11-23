import test from 'node:test';
import assert from 'node:assert/strict';
import { confidenceOf, moneyToFen, reconcileFees, toCsv } from '../src/domain/screenshot.js';

test('金额文本转分', () => {
  assert.equal(moneyToFen('¥28.63'), 2863);
  assert.equal(moneyToFen('28'), 2800);
  assert.equal(moneyToFen(12.5), 1250);
  assert.equal(moneyToFen(null), null);
  assert.equal(moneyToFen('未显示'), null);
});

test('费用加减核对允许一分误差', () => {
  const base = { payableFen: 2863, subtotalFen: 2600, packagingFen: 200, deliveryFen: 100, discountFen: 37 };
  assert.equal(reconcileFees(base), true);
  assert.equal(reconcileFees({ ...base, payableFen: 9999 }), false);
  assert.equal(reconcileFees({ ...base, subtotalFen: null }), false);
});

test('缺失关键字段时置信度下降并列出问题', () => {
  const result = confidenceOf({ pageKind: 'checkout', storeName: null, city: null, brand: null, itemName: '板烧鸡腿堡', spec: null, quantity: 1, payableFen: 2863, subtotalFen: 2600, packagingFen: null, deliveryFen: null, discountFen: null, coupons: [], eta: null }, true);
  assert.equal(result.confidence, 'medium');
  assert.ok(result.issues.some((issue) => issue.includes('门店')));
});

test('CSV 带 BOM 并防公式注入', () => {
  const csv = toCsv([{ key: 'name', label: '名称' }, { key: 'value', label: '数值' }], [{ name: '=1+1', value: '普通' }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"'=1\+1"/);
});
