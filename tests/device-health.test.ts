import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFailure, classifyFailure, initialHealth, isChannelAvailable, markBusy, markReady, resumeIfDue,
} from '../src/domain/device-health.js';

test('故障分类：设备/账号/页面/业务/未知分别有明确策略', () => {
  assert.equal(classifyFailure('device_screen_locked').failureClass, 'device');
  assert.equal(classifyFailure('target_app_not_foreground').failureClass, 'device');
  assert.equal(classifyFailure('unsupported_device_geometry').failureClass, 'device');
  assert.equal(classifyFailure('captcha_required').failureClass, 'account');
  assert.equal(classifyFailure('rate_limited').failureClass, 'account');
  assert.equal(classifyFailure('screen_unreadable').failureClass, 'page');
  assert.equal(classifyFailure('model_location_mismatch').failureClass, 'page');
  assert.equal(classifyFailure('minimum_not_met').failureClass, 'business');
  assert.equal(classifyFailure('store_identity_mismatch').failureClass, 'business');
  assert.equal(classifyFailure('some_new_error').failureClass, 'unknown');
  assert.equal(classifyFailure('some_new_error').alert, true);
});

test('设备类失败：第一次重试，第二次暂停并建议换通道', () => {
  const now = 1_000_000;
  let state = initialHealth('jd-a', now);
  const first = applyFailure(state, 'device_screen_locked', now);
  assert.equal(first.action, 'retry');
  assert.equal(first.state.health, 'ready');
  assert.equal(first.state.consecutiveDeviceFailures, 1);
  const second = applyFailure(first.state, 'device_screen_locked', now + 1_000);
  assert.equal(second.action, 'switch_channel');
  assert.equal(second.state.health, 'paused');
  assert.ok(second.state.resumeAt !== null && second.state.resumeAt > now);
});

test('账号类失败：立即暂停并转人工，不自动恢复', () => {
  const outcome = applyFailure(initialHealth('jd-a', 1), 'captcha_required', 2);
  assert.equal(outcome.action, 'pause_account');
  assert.equal(outcome.state.health, 'paused');
  assert.equal(outcome.state.resumeAt, null);
  assert.equal(isChannelAvailable(resumeIfDue(outcome.state, 999_999_999), 999_999_999), false);
});

test('页面类失败：重试且不暂停通道', () => {
  const outcome = applyFailure(initialHealth('jd-a', 1), 'screen_unreadable', 2);
  assert.equal(outcome.action, 'retry');
  assert.equal(outcome.state.health, 'ready');
  assert.equal(outcome.state.consecutiveDeviceFailures, 0);
});

test('业务无报价：不重试不暂停', () => {
  const outcome = applyFailure(initialHealth('jd-a', 1), 'minimum_not_met', 2);
  assert.equal(outcome.action, 'none');
  assert.equal(outcome.state.health, 'ready');
});

test('暂停到期自动恢复；未到期与人工暂停不恢复', () => {
  const now = 1_000_000;
  const paused = { ...initialHealth('jd-a', now), health: 'paused' as const, resumeAt: now + 60_000 };
  assert.equal(resumeIfDue(paused, now + 30_000).health, 'paused');
  assert.equal(resumeIfDue(paused, now + 60_000).health, 'ready');
  const manual = { ...initialHealth('jd-a', now), health: 'paused' as const, resumeAt: null };
  assert.equal(resumeIfDue(manual, now + 10 * 60_000).health, 'paused');
});

test('忙碌与就绪状态切换', () => {
  const now = 1;
  const busy = markBusy(initialHealth('jd-a', now), now);
  assert.equal(busy.health, 'busy');
  assert.equal(isChannelAvailable(busy, now), false);
  const ready = markReady(busy, now + 1);
  assert.equal(ready.health, 'ready');
  assert.equal(isChannelAvailable(ready, now + 1), true);
});
