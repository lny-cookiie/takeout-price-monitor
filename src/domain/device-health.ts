/**
 * 设备健康状态与故障分类（M3 第三块）。
 *
 * 目标：把「失败之后怎么办」从散落在采集器里的临时判断，变成一张可检查的策略表。
 * 设备类失败：重试一次 → 暂停通道 → 换备用通道 → 告警；
 * 账号类失败：暂停账号、人工处理（不自动换号）；
 * 页面类失败：重试一次，持续出现则暂停通道等待重新校准；
 * 业务无报价：不重试、不暂停。
 *
 * 纯逻辑，不接入调度器（接线与真机验证等大促结束）。
 */

export type DeviceHealth = 'ready' | 'busy' | 'paused' | 'offline' | 'incompatible';

export type FailureClass = 'device' | 'account' | 'page' | 'business' | 'unknown';

export interface FailureRule {
  failureClass: FailureClass;
  /** none：不重试；once：预算内重试一次；budget：按任务预算重试 */
  retry: 'none' | 'once' | 'budget';
  pauseChannel: boolean;
  pauseAccount: boolean;
  switchChannel: boolean;
  alert: boolean;
}

const DEVICE_CODES = new Set([
  'device_screen_locked', 'device_lock_state_unknown', 'device_wake_failed', 'device_unavailable',
  'device_unauthorized', 'target_app_not_foreground', 'screen_geometry_changed', 'invalid_control_bounds',
  'unsupported_device_geometry',
]);
const ACCOUNT_CODES = new Set(['captcha_required', 'access_restricted', 'rate_limited', 'login_required']);
const BUSINESS_CODES = new Set([
  'unavailable', 'sold_out', 'closed', 'out_of_range', 'minimum_not_met', 'store_identity_mismatch',
  'jd_direct_single_unverified',
]);
const PAGE_CODES = new Set([
  'entry_mismatch', 'page_not_ready', 'screen_unreadable', 'model_location_mismatch', 'checkout_control_missing',
  'jd_search_layout_changed', 'brand_candidates_missing', 'jd_saved_store_ambiguous', 'foreign_window', 'blank_screen',
]);

/** 故障分类表：同一错误码永远得到同一处置策略，便于审计与测试。 */
export function classifyFailure(errorCode: string): FailureRule {
  const code = errorCode.trim();
  if (DEVICE_CODES.has(code)) return { failureClass: 'device', retry: 'once', pauseChannel: true, pauseAccount: false, switchChannel: true, alert: true };
  if (ACCOUNT_CODES.has(code)) return { failureClass: 'account', retry: 'none', pauseChannel: false, pauseAccount: true, switchChannel: false, alert: true };
  if (BUSINESS_CODES.has(code)) return { failureClass: 'business', retry: 'none', pauseChannel: false, pauseAccount: false, switchChannel: false, alert: false };
  if (PAGE_CODES.has(code)) return { failureClass: 'page', retry: 'once', pauseChannel: false, pauseAccount: false, switchChannel: false, alert: false };
  return { failureClass: 'unknown', retry: 'once', pauseChannel: false, pauseAccount: false, switchChannel: false, alert: true };
}

export interface ChannelHealth {
  channelId: string;
  health: DeviceHealth;
  /** 自动恢复时间（epoch ms）；null 表示需要人工恢复 */
  resumeAt: number | null;
  reason: string | null;
  consecutiveDeviceFailures: number;
  updatedAt: number;
}

export function initialHealth(channelId: string, now: number): ChannelHealth {
  return { channelId, health: 'ready', resumeAt: null, reason: null, consecutiveDeviceFailures: 0, updatedAt: now };
}

export function markBusy(state: ChannelHealth, now: number): ChannelHealth {
  return { ...state, health: 'busy', updatedAt: now };
}

export function markReady(state: ChannelHealth, now: number): ChannelHealth {
  return { ...state, health: 'ready', resumeAt: null, reason: null, consecutiveDeviceFailures: 0, updatedAt: now };
}

export interface FailureOutcome { state: ChannelHealth; action: 'retry' | 'switch_channel' | 'pause_channel' | 'pause_account' | 'alert' | 'none'; }

/**
 * 应用一次失败：设备类失败累计到两次后暂停通道（重试一次仍失败），账号类立即转人工，
 * 页面类只计数不暂停，业务类直接视为正常结束。
 */
export function applyFailure(state: ChannelHealth, errorCode: string, now: number, pauseMs = 15 * 60_000): FailureOutcome {
  const rule = classifyFailure(errorCode);
  if (rule.failureClass === 'business') return { state: { ...state, health: 'ready', reason: errorCode, updatedAt: now }, action: 'none' };
  if (rule.failureClass === 'account') {
    return { state: { ...state, health: 'paused', resumeAt: null, reason: errorCode, updatedAt: now }, action: 'pause_account' };
  }
  if (rule.failureClass === 'page') {
    const next: ChannelHealth = { ...state, health: 'ready', reason: errorCode, consecutiveDeviceFailures: 0, updatedAt: now };
    return { state: next, action: rule.retry === 'none' ? 'none' : 'retry' };
  }
  // 设备类与未知：第一次重试，第二次暂停通道并建议换备用通道
  const failures = state.consecutiveDeviceFailures + 1;
  if (failures <= 1) {
    return { state: { ...state, health: 'ready', reason: errorCode, consecutiveDeviceFailures: failures, updatedAt: now }, action: 'retry' };
  }
  const paused: ChannelHealth = { ...state, health: 'paused', resumeAt: rule.pauseChannel ? now + pauseMs : null, reason: errorCode, consecutiveDeviceFailures: failures, updatedAt: now };
  return { state: paused, action: rule.switchChannel ? 'switch_channel' : 'pause_channel' };
}

/** 到点自动恢复：只恢复有 resumeAt 且已到期的通道；人工暂停（resumeAt=null）不自动恢复。 */
export function resumeIfDue(state: ChannelHealth, now: number): ChannelHealth {
  if (state.health !== 'paused' || state.resumeAt === null || now < state.resumeAt) return state;
  return { ...state, health: 'ready', resumeAt: null, reason: null, consecutiveDeviceFailures: 0, updatedAt: now };
}

/** 通道当前是否可领取任务。 */
export function isChannelAvailable(state: ChannelHealth, now: number): boolean {
  const resumed = resumeIfDue(state, now);
  return resumed.health === 'ready';
}
