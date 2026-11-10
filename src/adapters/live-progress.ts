// 采集实时进度：脚本每完成一个节点就写一次 .runtime/live-progress.json，
// 前端通过 /api/market/live-progress 轮询，实现"用户实时看到工具走到哪一步"。
import {writeFile, mkdir} from 'node:fs/promises';
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
  await mkdir(dirname(PROGRESS_FILE), {recursive: true}).catch(() => undefined);
  await writeFile(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf8').catch(() => undefined);
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
