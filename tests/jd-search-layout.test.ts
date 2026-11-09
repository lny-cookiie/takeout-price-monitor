import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEARCH_CROP, searchCropRegion, storeHeaderAnchor, DEFAULT_STORE_HEADER_WINDOW } from '../src/adapters/jd-search-layout.js';

const viewport = { width: 373.33, height: 842.67 };
const image = { width: 1260, height: 2844 };

test('裁剪区域按结果容器计算，并换算到截图物理像素', () => {
  const region = searchCropRegion({ left: 0, top: 180, width: 373.33, height: 500 }, viewport, image);
  assert.ok(region);
  // top ≈ (180 - 10) * 2844/842.67 ≈ 573
  assert.ok(Math.abs(region!.top - 573) <= 2);
  assert.equal(region!.left, 0);
  assert.equal(region!.width, 1260);
  // 高度上限 55% 屏高
  assert.ok(region!.height <= Math.floor(2844 * 0.55));
});

test('容器信息无效时返回 null，调用方回退固定比例', () => {
  assert.equal(searchCropRegion({ left: 0, top: 0, width: 0, height: 0 }, viewport, image), null);
  assert.equal(searchCropRegion({ left: 0, top: 0, width: 10, height: 10 }, viewport, image) !== null, false);
});

test('不同分辨率下按比例换算（同一容器，1080x2400 截图）', () => {
  const region = searchCropRegion({ left: 0, top: 200, width: 360, height: 480 }, { width: 360, height: 800 }, { width: 1080, height: 2400 });
  assert.ok(region);
  assert.ok(Math.abs(region!.top - (200 - 9.6) * 3) <= 2);
  assert.equal(region!.width, 1080);
});

test('门店头部锚点在窗口内返回点击坐标', () => {
  const anchor = { left: viewport.width * 0.5, top: viewport.height * 0.25, width: 120, height: viewport.height * 0.05 };
  const point = storeHeaderAnchor(anchor, viewport);
  assert.ok(point);
  assert.ok(Math.abs(point!.x - (anchor.left + 30)) < 1e-9);
});

test('门店头部锚点超出窗口返回 null（版式变化时停止而不是乱点）', () => {
  const offX = { left: viewport.width * 0.2, top: viewport.height * 0.25, width: 120, height: viewport.height * 0.05 };
  assert.equal(storeHeaderAnchor(offX, viewport), null);
  const offY = { left: viewport.width * 0.5, top: viewport.height * 0.6, width: 120, height: viewport.height * 0.05 };
  assert.equal(storeHeaderAnchor(offY, viewport), null);
  // 高度下限默认不启用（与原 pilotStoreHeader 行为一致），显式开启时才拦
  const tooShort = { left: viewport.width * 0.5, top: viewport.height * 0.25, width: 120, height: 2 };
  assert.ok(storeHeaderAnchor(tooShort, viewport));
  assert.equal(storeHeaderAnchor(tooShort, viewport, { ...DEFAULT_STORE_HEADER_WINDOW, minHeightRatio: 0.035 }), null);
});

test('窗口参数可配置，换机型只改配置', () => {
  const anchor = { left: viewport.width * 0.3, top: viewport.height * 0.25, width: 120, height: viewport.height * 0.05 };
  assert.equal(storeHeaderAnchor(anchor, viewport), null);
  const relaxed = { ...DEFAULT_STORE_HEADER_WINDOW, minX: 0.2, maxX: 0.8 };
  assert.ok(storeHeaderAnchor(anchor, viewport, relaxed));
});

test('裁剪配置可注入', () => {
  const region = searchCropRegion({ left: 0, top: 100, width: 360, height: 600 }, { width: 360, height: 800 }, { width: 1080, height: 2400 }, { ...DEFAULT_SEARCH_CROP, maxHeightRatio: 0.3 });
  assert.ok(region);
  assert.ok(region!.height <= Math.floor(2400 * 0.3));
});
