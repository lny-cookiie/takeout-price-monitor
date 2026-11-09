import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateGroup, hasDeliverableQuote, isTerminal, type SlotOutcome } from '../src/domain/group-delivery.js';

const submittedAt = 1_000_000;
const slot = (platform: SlotOutcome['platform'], status: SlotOutcome['status'], finishedAt: number | null, extra: Partial<SlotOutcome> = {}): SlotOutcome => ({
  platform, status, quoteMs: null, startedAt: submittedAt + 1_000, finishedAt, errorCode: null, ...extra,
});

test('三平台全部成功：delivered，交付时延取最晚完成时刻', () => {
  const delivery = aggregateGroup({
    groupId: 'g1', submittedAt, groupDeadline: submittedAt + 120_000,
    slots: [slot('jd', 'success', submittedAt + 60_000), slot('meituan', 'success', submittedAt + 50_000), slot('taobao_instant', 'success', submittedAt + 70_000)],
  }, submittedAt + 80_000);
  assert.equal(delivery.state, 'delivered');
  assert.equal(delivery.deliveredAt, submittedAt + 70_000);
  assert.equal(delivery.deliveryMs, 70_000);
  assert.equal(delivery.queueMs, 1_000);
  assert.equal(delivery.missedPlatforms.length, 0);
  assert.equal(hasDeliverableQuote(delivery), true);
});

test('部分成功部分失败：partial，逐平台说明原因', () => {
  const delivery = aggregateGroup({
    groupId: 'g2', submittedAt, groupDeadline: submittedAt + 120_000,
    slots: [slot('jd', 'success', submittedAt + 60_000), slot('meituan', 'failed', submittedAt + 40_000, { errorCode: 'screen_unreadable' }), slot('taobao_instant', 'blocked', submittedAt + 30_000)],
  }, submittedAt + 70_000);
  assert.equal(delivery.state, 'partial');
  assert.equal(delivery.platforms.meituan?.reason, 'screen_unreadable');
  assert.equal(delivery.platforms.taobao_instant?.reason, 'blocked');
  assert.equal(hasDeliverableQuote(delivery), true);
});

test('全部业务无报价：blocked', () => {
  const delivery = aggregateGroup({
    groupId: 'g3', submittedAt, groupDeadline: submittedAt + 120_000,
    slots: [slot('jd', 'unavailable', submittedAt + 20_000), slot('meituan', 'unavailable', submittedAt + 25_000), slot('taobao_instant', 'blocked', submittedAt + 30_000)],
  }, submittedAt + 40_000);
  assert.equal(delivery.state, 'blocked');
  assert.equal(hasDeliverableQuote(delivery), false);
});

test('未完成且未超截止：pending，不产生交付时延', () => {
  const delivery = aggregateGroup({
    groupId: 'g4', submittedAt, groupDeadline: submittedAt + 120_000,
    slots: [slot('jd', 'success', submittedAt + 60_000), slot('meituan', 'running', null), slot('taobao_instant', 'queued', null)],
  }, submittedAt + 70_000);
  assert.equal(delivery.state, 'pending');
  assert.equal(delivery.deliveryMs, null);
  assert.deepEqual(delivery.missedPlatforms.sort(), ['meituan', 'taobao_instant']);
});

test('超截止仍有未完成：partial，按截止时刻结算并列出未完成平台', () => {
  const delivery = aggregateGroup({
    groupId: 'g5', submittedAt, groupDeadline: submittedAt + 120_000,
    slots: [slot('jd', 'success', submittedAt + 60_000), slot('meituan', 'running', null), slot('taobao_instant', 'running', null)],
  }, submittedAt + 130_000);
  assert.equal(delivery.state, 'partial');
  assert.equal(delivery.deliveredAt, submittedAt + 120_000);
  assert.equal(delivery.deliveryMs, 120_000);
  assert.deepEqual(delivery.missedPlatforms.sort(), ['meituan', 'taobao_instant']);
});

test('金额与终止判断：isTerminal 覆盖所有终态', () => {
  for (const status of ['success', 'partial', 'unavailable', 'blocked', 'failed', 'not_run'] as const) assert.equal(isTerminal(status), true);
  assert.equal(isTerminal('running'), false);
  assert.equal(isTerminal('queued'), false);
});

test('全部未开始：queueMs 为 null', () => {
  const delivery = aggregateGroup({
    groupId: 'g6', submittedAt, groupDeadline: submittedAt + 120_000,
    slots: [slot('jd', 'queued', null, { startedAt: null }), slot('meituan', 'queued', null, { startedAt: null }), slot('taobao_instant', 'queued', null, { startedAt: null })],
  }, submittedAt + 10_000);
  assert.equal(delivery.queueMs, null);
  assert.equal(delivery.state, 'pending');
});
