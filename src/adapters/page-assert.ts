// 页面断言层（事前校验）：每个节点执行动作前，先断言当前页面身份。
// 设计约束（产品视角）：
//   1) 零额外读屏：复用调用方已经读到的节点数组，断言只是纯文本匹配（微秒级），不新增 adb 往返；
//   2) 只在 8 个关键节点断言，不撒在每个 find 上；
//   3) 偏离时最多 back 4 次，回不来就终止并报 page_assert_failed，绝不带着错误状态继续；
//   4) forbid 列表专门打掉会场/团购/直播/活动这类高混淆页面。
import type { U2Node } from './meituan-semantic.js';
import { nodeLabel } from './meituan-semantic.js';

export type MeituanPage =
  | 'home'        // 首页（含底部 tab）
  | 'takeout'     // 外卖频道首页
  | 'search'      // 搜索输入页
  | 'results'     // 搜索结果（门店列表）
  | 'store'       // 门店页
  | 'inStoreItem' // 店内搜索/商品列表
  | 'item'        // 商品详情/加购
  | 'checkout';   // 结算页

interface PageSpec {
  /** 命中任一即视为该页面特征 */
  must: RegExp[];
  /** 出现任一即判定偏离主链路（会场/团购/直播/活动） */
  forbid?: RegExp[];
}

// 严格区分“首页正常的促销词”和“真正偏离主链路的会场页”：
// 首页本身就有“限量抢购/天天神券/必点榜”，不能当作偏离信号，否则会把首页误杀。
const OFF_PATH: RegExp[] = [
  /进入会场/, /活动会场/, /主会场/, /分会场/,
  /立即抢购/, /马上抢/, /去抢购/,
  /团购券/, /爆款团购/, /团购详情/,
  /直播间/, /正在直播/, /直播中/,
  /活动规则/, /助力/, /拉新/,
];

// must 语义：数组内每个元素是一个“特征组”，组内用 | 表示任一命中即可；数组默认 ALL 组都要满足。
// 为降低误杀，home/checkout 允许更宽的特征组合。
const SPECS: Record<MeituanPage, PageSpec> = {
  home: { must: [/外卖|团购|我的|推荐/], forbid: OFF_PATH },
  takeout: { must: [/附近|到店|起送|配送费|销量|美食|甜点|超市/], forbid: OFF_PATH },
  search: { must: [/搜索|请输入/], forbid: [/会场/] },
  results: { must: [/麦当劳|门店|商家|评分|月售|起送|距离|km|m/], forbid: OFF_PATH },
  store: { must: [/点菜|评价|商家|购物车/], forbid: [/会场/] },
  inStoreItem: { must: [/商品|销量|月售|加入购物车|去结算|搜索/], forbid: [/会场/] },
  item: { must: [/加入购物车|去结算|选规格|\d+\.?\d*元/], forbid: [/会场/] },
  checkout: { must: [/商品原价|券前|打包费|合计|实付/], forbid: [] },
};

/** 纯函数：从已读节点分类页面身份。零 IO。 */
export function classifyMeituanPage(nodes: U2Node[]): MeituanPage | 'unknown' {
  const labels = nodes.map(n => nodeLabel(n)).filter(Boolean);
  if (!labels.length) return 'unknown';
  // 先判偏离：会场/团购/直播出现即 unknown（交给 ensurePage 回退）
  if (labels.some(l => OFF_PATH.some(r => r.test(l)))) return 'unknown';
  for (const [name, spec] of Object.entries(SPECS) as Array<[MeituanPage, PageSpec]>) {
    const mustOk = spec.must.every(group => group.test(labels.join(' ')));
    if (mustOk) return name;
  }
  return 'unknown';
}

export interface PageAsserter {
  /** 复用 nodes 时零读屏；不传才读一次 */
  assert(expected: MeituanPage, nodes?: U2Node[]): Promise<MeituanPage | 'unknown'>;
  /** 断言失败时自动 back 回退，最多 maxBack 次 */
  ensure(expected: MeituanPage, maxBack?: number): Promise<void>;
}

export function createPageAsserter(opts: {
  read: () => Promise<U2Node[]>;
  back: () => Promise<void>;
  waitStable: (rounds?: number) => Promise<U2Node[]>;
  log?: (msg: string) => void;
}): PageAsserter {
  const { read, back, waitStable, log = () => {} } = opts;

  const assert = async (expected: MeituanPage, nodes?: U2Node[]) => {
    const current = classifyMeituanPage(nodes ?? await read());
    if (current !== expected) {
      log(`[page] 期望 ${expected} 实际 ${current}`);
    }
    return current;
  };

  const ensure = async (expected: MeituanPage, maxBack = 4) => {
    let current = await assert(expected);
    for (let i = 0; i < maxBack && current !== expected; i++) {
      log(`[page] 回退一次（attempt ${i + 1}/${maxBack}），当前 ${current}`);
      await back();
      await waitStable(4);
      current = await assert(expected);
    }
    if (current !== expected) throw new Error(`page_assert_failed:${expected}:got_${current}`);
  };

  return { assert, ensure };
}
