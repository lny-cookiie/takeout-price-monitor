// 采集实时进度：脚本每完成一个节点就写一次 .runtime/live-progress.json，
// 前端通过 /api/market/live-progress 轮询，实现"用户实时看到工具走到哪一步"。
import {writeFile, readFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

export const PROGRESS_NODES = [
  '进入首页',
  '打开外卖频道',
  '搜索品牌名',
  '进入门店结果页',
  '进入店铺',
  '定位爆品',
  '加购结算',
  '采数完成',
] as const;

export const PROGRESS_FILE = '.runtime/live-progress.json';

/**
 * 三平台并行采集时进度会互相覆盖，所以真正的进度按平台分文件存放。
 * PROGRESS_FILE 只保留「最近一次写入」，用于兼容只认单文件的旧页面。
 */
export const PROGRESS_DIR = '.runtime/live-progress';

export function progressFileFor(platform: string): string {
  const safe = platform.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${PROGRESS_DIR}/${safe}.json`;
}

export interface LiveProgress {
  platform: string;
  node: string;
  index: number;
  total: number;
  percent: number;
  state: 'running' | 'completed' | 'failed';
  message?: string;
  startedAt: string;
  updatedAt: string;
}

export async function reportProgress(params: {
  platform: string;
  node: string;
  state?: 'running' | 'completed' | 'failed';
  message?: string;
  startedAt?: string;
}): Promise<void> {
  const index = PROGRESS_NODES.indexOf(params.node as (typeof PROGRESS_NODES)[number]);
  const total = PROGRESS_NODES.length;
  const now = new Date().toISOString();
  const data: LiveProgress = {
    platform: params.platform,
    node: params.node,
    index: index < 0 ? 0 : index,
    total,
    percent: index < 0 ? 0 : Math.round(((index + 1) / total) * 100),
    state: params.state ?? 'running',
    ...(params.message ? {message: params.message} : {}),
    startedAt: params.startedAt ?? now,
    updatedAt: now,
  };
  const payload = JSON.stringify(data, null, 2);
  // 主路径：按平台隔离，三平台并行时互不覆盖。
  await mkdir(PROGRESS_DIR, {recursive: true}).catch(() => undefined);
  await writeFile(progressFileFor(params.platform), payload, 'utf8').catch(() => undefined);
  // 兼容路径：保留「最近一次写入」，旧页面仍能读到单文件。
  await mkdir(dirname(PROGRESS_FILE), {recursive: true}).catch(() => undefined);
  await writeFile(PROGRESS_FILE, payload, 'utf8').catch(() => undefined);
}

/** 读取某个平台的进度；不传平台时读取兼容单文件。 */
export async function readProgress(platform?: string): Promise<LiveProgress | null> {
  const file = platform ? progressFileFor(platform) : PROGRESS_FILE;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LiveProgress;
  } catch {
    return null;
  }
}

/** 把后端步骤名映射到 8 个关键节点 */
export function mapStepToNode(step: string): string | null {
  if (/进入首页|首页/.test(step)) return '进入首页';
  if (/外卖频道|外卖入口/.test(step)) return '打开外卖频道';
  if (/搜索品牌|搜索页/.test(step)) return '搜索品牌名';
  if (/搜索结果|门店卡/.test(step)) return '进入门店结果页';
  if (/门店页|进店|店铺/.test(step)) return '进入店铺';
  if (/店内搜索|单品|热门词|爆品/.test(step)) return '定位爆品';
  if (/加入购物车|加购|去结算|结算/.test(step)) return '加购结算';
  if (/采数|quote|完成/.test(step)) return '采数完成';
  return null;
}
