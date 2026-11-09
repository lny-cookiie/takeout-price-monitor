import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GEOMETRY_SUPPORT, validateGeometry, type DeviceGeometry } from '../src/adapters/device-geometry.js';

const base: DeviceGeometry = {
  model: 'HBN-AL00', sdk: 31,
  physicalWidth: 1260, physicalHeight: 2844,
  width: 373.33, height: 842.67,
  density: 540, dpr: 3.375,
  orientation: 0, fontScale: 1,
};

test('支持矩阵内的竖屏手机通过校验', () => {
  assert.deepEqual(validateGeometry(base), { ok: true, violations: [] });
});

test('横屏被拒绝', () => {
  const result = validateGeometry({ ...base, orientation: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes('not_portrait'));
});

test('逻辑宽超出范围被拒绝（平板/折叠屏）', () => {
  const wide = validateGeometry({ ...base, width: 600 });
  assert.ok(wide.violations.includes('logical_width_out_of_range'));
});

test('宽高比超出范围被拒绝', () => {
  const squat = validateGeometry({ ...base, width: 400, height: 600 });
  assert.ok(squat.violations.includes('aspect_ratio_out_of_range'));
});

test('字体缩放超出范围被拒绝', () => {
  assert.ok(validateGeometry({ ...base, fontScale: 1.3 }).violations.includes('font_scale_out_of_range'));
  assert.ok(validateGeometry({ ...base, fontScale: 0.8 }).violations.includes('font_scale_out_of_range'));
});

test('字体缩放未知时不因此判失败，但密度未知判失败', () => {
  assert.equal(validateGeometry({ ...base, fontScale: null }).ok, true);
  assert.ok(validateGeometry({ ...base, density: 0, dpr: 0 }).violations.includes('density_unknown'));
});

test('支持矩阵可配置', () => {
  const relaxed = { ...DEFAULT_GEOMETRY_SUPPORT, requirePortrait: false, maxLogicalWidth: 700 };
  assert.equal(validateGeometry({ ...base, orientation: null, width: 600, height: 1354 }, relaxed).ok, true);
});
