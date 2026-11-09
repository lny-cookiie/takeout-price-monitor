import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRIVACY_BAND, privacyBandMask } from '../src/adapters/checkout-privacy.js';

const viewport = { width: 373.33, height: 842.67 };
const image = { width: 1260, height: 2844 };

test('按点位锚点计算顶部遮罩带，覆盖到锚点下方边距', () => {
  const mask = privacyBandMask({ left: 40, top: 90, width: 280, height: 30 }, viewport, image);
  assert.ok(mask);
  assert.equal(mask!.left, 0);
  assert.equal(mask!.top, 0);
  assert.equal(mask!.width, 1260);
  // bottom ≈ (90+30+50.6) * 3.375 ≈ 576
  assert.ok(Math.abs(mask!.height - 576) <= 4);
});

test('不同分辨率下仍按比例换算（1080x2400 截图）', () => {
  const mask = privacyBandMask({ left: 30, top: 80, width: 240, height: 24 }, { width: 360, height: 800 }, { width: 1080, height: 2400 });
  assert.ok(mask);
  assert.equal(mask!.width, 1080);
  assert.ok(mask!.height <= 2400);
});

test('锚点无效时返回 null，调用方回退固定比例', () => {
  assert.equal(privacyBandMask({ left: 0, top: 0, width: 100, height: 0 }, viewport, image), null);
  assert.equal(privacyBandMask({ left: 0, top: -5, width: 100, height: 20 }, viewport, image), null);
});

test('遮罩高度下限可配置', () => {
  const tiny = privacyBandMask({ left: 0, top: 1, width: 100, height: 2 }, viewport, { width: 1260, height: 2844 }, { ...DEFAULT_PRIVACY_BAND, bottomPaddingRatio: 0, minHeightPx: 40 });
  assert.equal(tiny, null);
});
