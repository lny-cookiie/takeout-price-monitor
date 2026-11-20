// 门店页面布局签名：同一平台不同门店可能用不同渲染容器，先按容器和节点可读性分类，再选择采集策略。
export interface LayoutEntry {
  id: string;
  platform: string;
  activity: string | null;
  node_readable: boolean;
  strategy: 'node_shelf' | 'manto_visual' | 'visual_page' | 'unknown';
  stores: string[];
  status: 'verified' | 'pending';
  first_seen: string;
  verified_runs: string[];
  notes: string;
}

export interface LayoutRegistry {
  version: number;
  updated_at: string;
  entries: LayoutEntry[];
}

/** 布局签名：平台加容器加节点是否可读，用于缓存策略选择结果。 */
export function layoutSignature(platform: string, activity: string | null, nodeReadable: boolean): string {
  return `${platform}:${activity ?? 'unknown'}:${nodeReadable ? 'nodes' : 'visual'}`;
}

/**
 * 选择布局：先按平台和 Activity 精确匹配；没有 Activity 时退回按节点可读性匹配。
 * 宁可返回 unknown 也不能猜错策略，猜错会把视觉页当节点页处理。
 */
export function matchLayout(registry: LayoutRegistry, input: { platform: string; activity: string | null; nodeReadable: boolean }): LayoutEntry | null {
  const candidates = registry.entries.filter((e) => e.platform === input.platform);
  const byActivity = input.activity
    ? candidates.find((e) => e.activity !== null && new RegExp(`(^|[./])${escapeRegExp(input.activity!)}([./]|$)`).test(e.activity!))
    : undefined;
  if (byActivity) return byActivity;
  return candidates.find((e) => e.node_readable === input.nodeReadable) ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
