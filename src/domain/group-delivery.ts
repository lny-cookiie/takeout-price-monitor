import type { Platform } from './contracts.js';

/**
 * 组级交付聚合（M3 第二块）。
 *
 * 一次提交生成一个比较组 + 三条平台任务。组级状态要能回答三件事：
 * 三平台是否都已终止、交付时延是多少、未成功的原因分别是什么。
 *
 * 口径按 24 号计划：交付时延 = 提交时刻到全部终止（或组截止）时刻；
 * 单平台 partial/blocked 不阻塞组交付，但必须逐平台说明原因。
 * 本文件只做纯逻辑，不接入调度器。
 */

export type SlotStatus = 'queued' | 'running' | 'success' | 'partial' | 'unavailable' | 'blocked' | 'failed' | 'not_run';
export type GroupState = 'pending' | 'delivered' | 'partial' | 'blocked';

export interface SlotOutcome {
  platform: Platform;
  status: SlotStatus;
  /** 首次已核对报价时刻（相对提交的毫秒数），未取得为 null */
  quoteMs: number | null;
  /** 本次尝试开始时刻（epoch ms），未开始为 null */
  startedAt: number | null;
  /** 终止时刻（epoch ms），未终止为 null */
  finishedAt: number | null;
  errorCode?: string | null;
}

export interface DeliveryGroupInput {
  groupId: string;
  submittedAt: number;
  /** 组截止时刻（epoch ms），超过即按截止时间结算，不再等未完成的平台 */
  groupDeadline: number;
  slots: SlotOutcome[];
}

export interface PlatformDelivery {
  status: SlotStatus;
  quoteMs: number | null;
  reason: string | null;
}

export interface GroupDelivery {
  groupId: string;
  state: GroupState;
  /** 交付时刻：全部终止时取最晚 finishedAt；超截止取截止时刻；未完成且未超截止为 null */
  deliveredAt: number | null;
  /** 交付时延（毫秒）：提交到交付；未交付为 null */
  deliveryMs: number | null;
  /** 提交到第一个平台开始的等待（毫秒），全部未开始为 null */
  queueMs: number | null;
  /** 超截止仍未有结果的平台 */
  missedPlatforms: Platform[];
  platforms: Record<string, PlatformDelivery>;
}

const TERMINAL = new Set<SlotStatus>(['success', 'partial', 'unavailable', 'blocked', 'failed', 'not_run']);
const SUCCESS = new Set<SlotStatus>(['success', 'partial']);
const BUSINESS_END = new Set<SlotStatus>(['unavailable', 'blocked']);

export function isTerminal(status: SlotStatus): boolean {
  return TERMINAL.has(status);
}

export function aggregateGroup(input: DeliveryGroupInput, now: number): GroupDelivery {
  const terminated = input.slots.filter(slot => isTerminal(slot.status));
  const allTerminated = terminated.length === input.slots.length;
  const overdue = now >= input.groupDeadline;
  const missed = input.slots.filter(slot => !isTerminal(slot.status)).map(slot => slot.platform);

  let state: GroupState;
  let deliveredAt: number | null = null;
  if (!allTerminated && !overdue) {
    state = 'pending';
  } else if (!allTerminated && overdue) {
    // 超截止：按截止时刻交付，未完成的平台单独列出
    state = 'partial';
    deliveredAt = input.groupDeadline;
  } else {
    const finished = terminated.flatMap(slot => (slot.finishedAt === null ? [] : [slot.finishedAt]));
    deliveredAt = finished.length ? Math.max(...finished) : now;
    const successes = terminated.filter(slot => SUCCESS.has(slot.status));
    if (successes.length === terminated.length) state = 'delivered';
    else if (successes.length > 0) state = 'partial';
    else state = terminated.every(slot => BUSINESS_END.has(slot.status)) ? 'blocked' : 'partial';
  }

  const deliveryMs = deliveredAt === null ? null : Math.max(0, deliveredAt - input.submittedAt);
  const started = input.slots.flatMap(slot => (slot.startedAt === null ? [] : [slot.startedAt]));
  const queueMs = started.length ? Math.max(0, Math.min(...started) - input.submittedAt) : null;

  const platforms: Record<string, PlatformDelivery> = {};
  for (const slot of input.slots) {
    platforms[slot.platform] = {
      status: slot.status,
      quoteMs: slot.quoteMs,
      reason: isTerminal(slot.status) ? (slot.errorCode ?? (SUCCESS.has(slot.status) ? null : slot.status)) : 'not_finished',
    };
  }
  return { groupId: input.groupId, state, deliveredAt, deliveryMs, queueMs, missedPlatforms: missed, platforms };
}

/** 组内是否至少有一条可交付报价（成功或部分成功）。 */
export function hasDeliverableQuote(delivery: GroupDelivery): boolean {
  return Object.values(delivery.platforms).some(platform => platform.status === 'success' || platform.status === 'partial');
}
