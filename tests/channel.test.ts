import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HEARTBEAT_STALE_MS, leaseActive, leaseMatches, leaseReclaimable, nextLease, renewLease, selectChannel, validateChannels,
  type ChannelLease, type ChannelRef,
} from '../src/domain/channel.js';

const baseChannel = (id: string, platform: ChannelRef['platform'], device: string, account = 'acc-a'): ChannelRef => ({
  id, platform, device, account, point: '总部东门', entry: 'app-home', appVersion: '16.1.0', selectorsVersion: 'r1',
});

test('合法通道集合通过校验：同平台多通道允许，跨平台共用设备拒绝', () => {
  const ok = validateChannels([baseChannel('jd-a', 'jd', 'phone-a'), baseChannel('jd-b', 'jd', 'phone-b', 'acc-b'), baseChannel('mt-a', 'meituan', 'phone-c')]);
  assert.equal(ok.ok, true);
  const shared = validateChannels([baseChannel('jd-a', 'jd', 'phone-a'), baseChannel('mt-a', 'meituan', 'phone-a')]);
  assert.equal(shared.ok, false);
  assert.ok(shared.violations.some(v => v.rule.startsWith('device_shared_with_')));
});

test('通道 id 重复与缺字段被拒绝', () => {
  const duplicate = validateChannels([baseChannel('jd-a', 'jd', 'phone-a'), baseChannel('jd-a', 'jd', 'phone-b')]);
  assert.ok(duplicate.violations.some(v => v.rule === 'duplicate_channel_id'));
  const missing = validateChannels([{ ...baseChannel('jd-a', 'jd', 'phone-a'), account: '' }]);
  assert.ok(missing.violations.some(v => v.rule === 'missing_account'));
});

test('租约有效性与回收：过期且心跳超时才可回收', () => {
  const now = 1_000_000;
  const live: ChannelLease = { channelId: 'jd-a', attemptId: 'a1', expiresAt: now + 5_000, generation: 1, heartbeatAt: now };
  assert.equal(leaseActive(live, now), true);
  assert.equal(leaseReclaimable(live, now), false);
  const expiredRecentHeartbeat: ChannelLease = { channelId: 'jd-a', attemptId: 'a1', expiresAt: now - 1, generation: 1, heartbeatAt: now - 1_000 };
  assert.equal(leaseReclaimable(expiredRecentHeartbeat, now), false);
  const stale: ChannelLease = { channelId: 'jd-a', attemptId: 'a1', expiresAt: now - 1, generation: 1, heartbeatAt: now - DEFAULT_HEARTBEAT_STALE_MS - 1 };
  assert.equal(leaseReclaimable(stale, now), true);
  const noHeartbeat: ChannelLease = { channelId: 'jd-a', attemptId: 'a1', expiresAt: now - 1, generation: 1, heartbeatAt: null };
  assert.equal(leaseReclaimable(noHeartbeat, now), true);
});

test('选择通道：跳过活跃租约、忙碌账号与设备', () => {
  const channels = [baseChannel('jd-a', 'jd', 'phone-a'), baseChannel('jd-b', 'jd', 'phone-b', 'acc-b'), baseChannel('mt-a', 'meituan', 'phone-c', 'acc-c')];
  const now = 1_000_000;
  const leases: ChannelLease[] = [{ channelId: 'jd-a', attemptId: 'x', expiresAt: now + 10_000, generation: 1, heartbeatAt: now }];
  const picked = selectChannel({
    readyChannelIds: ['jd-a', 'jd-b', 'mt-a'], leases,
    busyAccounts: new Set(['acc-c']), busyDevices: new Set(), channels, now,
  });
  assert.equal(picked, 'jd-b');
  const allBusy = selectChannel({
    readyChannelIds: ['jd-a', 'jd-b', 'mt-a'], leases,
    busyAccounts: new Set(['acc-b', 'acc-c']), busyDevices: new Set(), channels, now,
  });
  assert.equal(allBusy, null);
});

test('选择通道：按优先级降序、同优先级按 id 稳定排序', () => {
  const channels = [baseChannel('jd-b', 'jd', 'phone-b', 'acc-b'), baseChannel('jd-a', 'jd', 'phone-a'), baseChannel('mt-a', 'meituan', 'phone-c', 'acc-c')];
  const now = 1_000_000;
  const picked = selectChannel({
    readyChannelIds: ['jd-a', 'jd-b', 'mt-a'], leases: [], priority: { 'mt-a': 5, 'jd-a': 5, 'jd-b': 1 },
    busyAccounts: new Set(), busyDevices: new Set(), channels, now,
  });
  assert.equal(picked, 'jd-a');
});

test('租约生成、续租与代号核对', () => {
  const now = 1_000_000;
  const first = nextLease('jd-a', 'attempt-1', 0, now);
  assert.equal(first.generation, 1);
  assert.equal(first.expiresAt, now + 30_000);
  assert.equal(leaseMatches(first, 'attempt-1', 1), true);
  assert.equal(leaseMatches(first, 'attempt-1', 0), false);
  const renewed = renewLease(first, now + 10_000);
  assert.equal(renewed.generation, 1);
  assert.equal(renewed.expiresAt, now + 40_000);
  assert.equal(renewed.heartbeatAt, now + 10_000);
  const second = nextLease('jd-a', 'attempt-2', first.generation, now);
  assert.equal(second.generation, 2);
  assert.equal(leaseMatches(second, 'attempt-1', 1), false);
});
