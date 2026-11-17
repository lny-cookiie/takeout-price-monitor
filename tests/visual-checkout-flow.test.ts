import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {captureVisualCheckout} from '../src/adapters/visual-checkout.js';
import type {AndroidSource} from '../src/adapters/android-source.js';
import type {ReviewedScreen} from '../src/adapters/android-collector.js';
import type {Evidence} from '../src/domain/contracts.js';

const png = () => sharp({create: {width: 320, height: 640, channels: 3, background: {r: 240, g: 240, b: 240}}}).png().toBuffer();
const evidence: Evidence = {id: 'ev-test', sha256: 'a'.repeat(64), screenshot: '/api/evidence/ev-test.png', text_file: '/api/evidence/ev-test.json', captured_at: '2026-11-17T00:00:00.000Z', page_stage: 'checkout'};
const fakeScreen = () => ({
  source: {privacy: {checkoutTopRatio: 0.24}} as unknown as AndroidSource,
  device: {
    size: async () => ({width: 320, height: 640}),
    screenshot: async () => png(),
  },
}) as unknown as ReviewedScreen;
const fakeEvidence = {save: async () => evidence};
type Script = {first: unknown; focus: unknown};
const fakeModel = (script: Script) => ({
  json: async (_scope: string, operation: string, _instruction: string, _data: unknown, check: (v: unknown) => unknown) =>
    check(operation === 'checkout_visual_focus' ? script.focus : script.first),
});
const settle = <T>(promise: Promise<T>) => promise;
const call = (script: Script) => captureVisualCheckout(fakeScreen(), fakeModel(script) as never, fakeEvidence as never, 'attempt-1', new AbortController().signal, [], {itemName: '板烧鸡腿堡', quantity: 1});

test('视觉结算：整页与放大区双读一致才发布应付金额', async () => {
  const read = await call({
    first: {pageKind: 'checkout', payable: '¥21.23', subtotal: '26.5', packaging: '1.1', delivery: null, other: null, discount: '-12.37', itemName: '板烧鸡腿堡', itemQuantity: '1', subtotalBasis: 'unknown', feesSeparate: null, coupons: []},
    focus: {payable: '21.23', discount: '12.37'},
  });
  assert.equal(read.total, 2123);
  assert.equal(read.raw, '21.23');
  assert.equal(read.fieldResults.payable?.status, 'verified');
  // 费用行不完整时不采用任何费用数字，未知不能写成零。
  assert.equal(read.components.subtotal, null);
  assert.equal(read.components.packaging, null);
  assert.equal(read.components.delivery, null);
  assert.ok(read.missing.reconciliation);
});

test('视觉结算：截图不是结算页时拒绝，不能把商品详情页到手价当应付', async () => {
  await assert.rejects(settle(call({
    first: {pageKind: 'item_detail', payable: '14', itemName: '板烧鸡腿堡', itemQuantity: 1},
    focus: {payable: '14', discount: null},
  })), /not_on_checkout_screen/);
});

test('视觉结算：两次读数不一致时失败，不挑一个发布', async () => {
  await assert.rejects(settle(call({
    first: {pageKind: 'checkout', payable: '21.23', itemName: '板烧鸡腿堡', itemQuantity: 1},
    focus: {payable: '20.73', discount: null},
  })), /amount_evidence_mismatch/);
});

test('视觉结算：商品行与目标不一致时停止', async () => {
  await assert.rejects(settle(call({
    first: {pageKind: 'checkout', payable: '21.23', itemName: '双层板烧鸡腿堡', itemQuantity: 1},
    focus: {payable: '21.23', discount: null},
  })), /item_not_verified/);
  await assert.rejects(settle(call({
    first: {pageKind: 'checkout', payable: '21.23', itemName: '板烧鸡腿堡', itemQuantity: 2},
    focus: {payable: '21.23', discount: null},
  })), /quantity_not_verified/);
});

test('视觉结算：费用行完整且加减核对通过时才采用明细', async () => {
  const read = await call({
    first: {pageKind: 'checkout', payable: '21.23', subtotal: '26.5', packaging: '1.1', delivery: '6', other: '0', discount: '-12.37',
      itemName: '板烧鸡腿堡', itemQuantity: 1, subtotalBasis: 'before_discount', feesSeparate: true, coupons: []},
    focus: {payable: '21.23', discount: '12.37'},
  });
  assert.equal(read.total, 2123);
  assert.equal(read.reconciled, true);
  assert.equal(read.components.subtotal?.fen, 2650);
  assert.equal(read.components.packaging?.fen, 110);
  assert.equal(read.components.delivery?.fen, 600);
  assert.equal(read.components.discount?.fen, 1237);
  assert.equal(read.basis, 'before_discount');
  assert.equal(read.feesSeparate, true);
});
