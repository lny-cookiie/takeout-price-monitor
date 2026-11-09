import type { Platform } from './contracts.js';

/**
 * 采集通道与设备租约的纯逻辑（M3 并行调度骨架）。
 *
 * 现状：每个平台只能登记一条来源，调度 worker 键是「模式:平台」，同平台永远单并发。
 * 要支持多设备并行，需要把「平台」细化成「通道」：平台 + 设备 + 账号 + 点位 + 入口
 * + App 版本 + 控件集版本。本文件只定义类型、校验与选择逻辑，不接入现有调度器，
 * 等真机可用后再接线（见 24 号计划 M3）。
 */

export interface ChannelRef {
  /** 稳定通道 id，例如 jd-phone-a；同一平台允许多个通道 */
  id: string;
  platform: Platform;
  /** adb 序列号 */
  device: string;
  /** 账号代号，不保存手机号 */
  account: string;
  /** 配送点位简称 */
  point: string;
  entry: string;
  appVersion: string;
  /** 控件集/页面地图版本 */
  selectorsVersion: string;
  /** 设备几何档案引用（可选） */
  geometryProfile?: string;
}

export interface ChannelViolation { channelId: string | null; rule: string }

/**
 * 校验通道集合：id 唯一、设备不重复（同一台手机不能同时承担两条通道）、必填字段齐全。
 * 同平台允许多条通道（多设备并行）；跨平台共用一条通道则拒绝。
 */
export function validateChannels(channels: ChannelRef[]): { ok: boolean; violations: ChannelViolation[] } {
  const violations: ChannelViolation[] = [];
  const ids = new Set<string>();
  const devices = new Map<string, string>();
  const required: (keyof ChannelRef)[] = ['id', 'platform', 'device', 'account', 'point', 'entry', 'appVersion', 'selectorsVersion'];
  for (const channel of channels) {
    for (const field of required) {
      const value = channel[field];
      if (typeof value !== 'string' || value.trim().length === 0) violations.push({ channelId: channel.id ?? null, rule: `missing_${field}` });
    }
    if (ids.has(channel.id)) violations.push({ channelId: channel.id, rule: 'duplicate_channel_id' });
    ids.add(channel.id);
    const existing = devices.get(channel.device);
    if (existing) violations.push({ channelId: channel.id, rule: `device_shared_with_${existing}` });
    else devices.set(channel.device, channel.id);
  }
  return { ok: violations.length === 0, violations };
}

/** 租约：一次采集占用一台设备，必须带过期时间、心跳与代号，防止双点同一台手机。 */
export interface ChannelLease {
  channelId: string;
  attemptId: string;
  /** 租约到期时间（epoch ms） */
  expiresAt: number;
  /** 租约代号，每次领取递增；动作前核对，防止旧 worker 继续操作 */
  generation: number;
  /** 最近一次心跳时间（epoch ms），未知为 null */
  heartbeatAt: number | null;
}

export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_HEARTBEAT_STALE_MS = 45_000;

export function leaseActive(lease: ChannelLease, now: number): boolean {
  return lease.expiresAt > now;
}

/**
 * 是否允许回收租约：已过期，且心跳也已超过 stale 阈值（或从未有心跳），
 * 避免把「进程还活着但暂时没发心跳」的设备判死。
 */
export function leaseReclaimable(lease: ChannelLease, now: number, staleMs: number = DEFAULT_HEARTBEAT_STALE_MS): boolean {
  if (lease.expiresAt > now) return false;
  if (lease.heartbeatAt === null) return true;
  return now - lease.heartbeatAt > staleMs;
}

export interface SelectChannelInput {
  /** 当前有任务可执行的通道（由任务队列按通道分组后传入） */
  readyChannelIds: string[];
  /** 同一批任务的优先级（通道 id → 优先级，数字越大越先） */
  priority?: Record<string, number>;
  leases: ChannelLease[];
  /** 正在运行的账号/设备，用于互斥 */
  busyAccounts: Set<string>;
  busyDevices: Set<string>;
  channels: ChannelRef[];
  now: number;
}

/**
 * 选择一个可领取任务的通道：跳过有活跃租约、账号或设备正忙的通道，
 * 其余按优先级降序、再按通道 id 稳定排序，保证调度结果可复现。
 */
export function selectChannel(input: SelectChannelInput): string | null {
  const active = new Set(input.leases.filter(lease => leaseActive(lease, input.now)).map(lease => lease.channelId));
  const byId = new Map(input.channels.map(channel => [channel.id, channel]));
  const candidates = input.readyChannelIds.filter(id => {
    if (active.has(id)) return false;
    const channel = byId.get(id);
    if (!channel) return false;
    if (input.busyAccounts.has(channel.account)) return false;
    if (input.busyDevices.has(channel.device)) return false;
    return true;
  });
  if (!candidates.length) return null;
  const priority = input.priority ?? {};
  return candidates.sort((a, b) => (priority[b] ?? 0) - (priority[a] ?? 0) || a.localeCompare(b))[0]!;
}

/** 生成下一次租约：一次领取一个代号，旧代号随之失效。 */
export function nextLease(channelId: string, attemptId: string, previousGeneration: number, now: number, ttlMs: number = DEFAULT_LEASE_TTL_MS): ChannelLease {
  return { channelId, attemptId, generation: previousGeneration + 1, expiresAt: now + ttlMs, heartbeatAt: now };
}

/** 心跳续租：只延长过期时间并刷新心跳，代号不变。 */
export function renewLease(lease: ChannelLease, now: number, ttlMs: number = DEFAULT_LEASE_TTL_MS): ChannelLease {
  return { ...lease, expiresAt: now + ttlMs, heartbeatAt: now };
}

/** 动作前核对代号：防止旧 worker 在租约被回收后继续操作同一台手机。 */
export function leaseMatches(lease: ChannelLease | undefined, attemptId: string, generation: number): boolean {
  return !!lease && lease.attemptId === attemptId && lease.generation === generation;
}
