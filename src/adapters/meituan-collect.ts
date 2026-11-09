// 美团采集主流程（骨架）：
// - 导航步骤全部走 u2 语义定位（meituan-semantic 模块）；
// - 搜索结果页的门店卡是自绘列表，语义读不到，需要视觉兜底（visualLocate 注入 model.locate）；
// - 结算页字段与京东一一对应，实付按"券前价 − 红包"计算（券后价）。
// 说明：本文件只定义流程与数据形状，尚未接入服务端调度；真机验证通过后再接入。

import type { AndroidSource } from './android-source.js';
import type { U2Semantic, U2Node } from './meituan-semantic.js';
import { nodeLabel } from './meituan-semantic.js';

export interface MeituanQuote {
  store: string | null;
  item: string | null;
  subtotal_fen: number | null;
  packaging_fen: number | null;
  delivery_fen: number | null;
  discount_fen: number | null;
  coupon_before_fen: number | null;
  payable_fen: number | null;
  raw: Record<string, string>;
  steps: string[];
}

const cny = (text: string): number | null => {
  const hit = /(\d+(?:\.\d+)?)/.exec(text);
  return hit ? Math.round(Number(hit[1]) * 100) : null;
};

const pick = (nodes: U2Node[], needle: string): U2Node | null =>
  nodes.find(n => nodeLabel(n).includes(needle)) ?? null;

/** 读取结算页各费用行：美团把标签和金额放在不同节点，按纵向位置配对。 */
export function readMeituanSettlement(nodes: U2Node[]): Partial<MeituanQuote> & { raw: Record<string, string> } {
  const raw: Record<string, string> = {};
  const rows = nodes
    .filter(n => nodeLabel(n))
    .map(n => ({ y: n.top + n.height / 2, label: nodeLabel(n) }))
    .sort((a, b) => a.y - b.y);
  const valueNear = (label: string, tolerance = 40): string => {
    const hit = rows.find(r => r.label.includes(label));
    if (!hit) return '';
    const candidate = rows
      .filter(r => Math.abs(r.y - hit.y) <= tolerance && r !== hit && /\d/.test(r.label))
      .sort((a, b) => Math.abs(a.y - hit.y) - Math.abs(b.y - hit.y))[0];
    return candidate ? candidate.label : '';
  };
  const fields = ['商品原价', '打包费', '用户配送费', '红包', '立减', '券前', '实付', '合计'];
  for (const field of fields) {
    const value = valueNear(field);
    if (value) raw[field] = value;
  }
  return {
    raw,
    subtotal_fen: raw['商品原价'] ? cny(raw['商品原价']) : null,
    packaging_fen: raw['打包费'] ? cny(raw['打包费']) : null,
    delivery_fen: raw['用户配送费'] ? cny(raw['用户配送费']) : null,
    discount_fen: raw['红包'] ? cny(raw['红包']) : raw['立减'] ? cny(raw['立减']) : null,
    coupon_before_fen: raw['券前'] ? cny(raw['券前']) : null,
    payable_fen: raw['实付'] ? cny(raw['实付']) : raw['合计'] ? cny(raw['合计']) : null,
  };
}

/** 美团实付 = 券前价 − 可用红包（券后价）。缺失券前价时退回页面显示的实付。 */
export function meituanActualPayable(quote: Pick<MeituanQuote, 'coupon_before_fen' | 'discount_fen' | 'payable_fen'>): number | null {
  if (quote.coupon_before_fen !== null && quote.discount_fen !== null) {
    return Math.max(0, quote.coupon_before_fen - quote.discount_fen);
  }
  return quote.payable_fen;
}

export interface MeituanFlowOptions {
  semantic: U2Semantic;
  /** 搜索结果页的门店卡需要视觉兜底：返回目标点的逻辑坐标 */
  visualLocate?: (hint: string) => Promise<{ x: number; y: number } | null>;
  /** 点视觉兜底给出的坐标（逻辑坐标） */
  tapPoint: (x: number, y: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  brand: string;
  itemName: string;
}

/**
 * 美团导航主流程（语义 + 视觉兜底）。成功返回 true，失败抛出带步骤名的错误。
 * 注意：本流程只负责导航与页面校验，不负责证据截图与字段落库。
 */
export async function navigateMeituan(options: MeituanFlowOptions): Promise<string[]> {
  const { semantic, sleep, brand, itemName } = options;
  const steps: string[] = [];
  const step = (name: string) => {
    steps.push(name);
    console.log(`[meituan] step ${steps.length}: ${name}`);
  };
  const isHome = async () => {
    const nodes = await semantic.read();
    return nodes.some(n => nodeLabel(n).trim() === '外卖') && nodes.some(n => nodeLabel(n).trim() === '团购');
  };
  // 回首页（点错/不在首页时用返回重试，不重启 App）
  for (let i = 0; i < 4 && !(await isHome()); i++) {
    await options.semantic.back?.();
  }
  if (!(await isHome())) throw new Error('meituan_not_home');

  step('首页搜索按钮');
  const search = await semantic.find(n => nodeLabel(n).trim() === '搜索' && n.width > 100);
  if (!search) throw new Error('meituan_no_search_button');
  await semantic.tap(search, '搜索按钮');

  step('搜索页历史词');
  const history = await semantic.find(n => nodeLabel(n).trim() === brand || nodeLabel(n).includes(brand));
  if (history) await semantic.tap(history, `历史 ${brand}`);

  step('搜索结果页门店卡（视觉兜底）');
  const storeCard = await semantic.find(n => nodeLabel(n).includes('麦咖啡') && nodeLabel(n).includes(brand), 8_000);
  if (storeCard) {
    await semantic.tap(storeCard, '门店卡');
  } else if (options.visualLocate) {
    const hit = await options.visualLocate(`${brand} 的门店卡片`);
    if (!hit) throw new Error('meituan_store_card_unlocated');
    await options.tapPoint(hit.x, hit.y);
    await sleep(1_800);
  } else {
    throw new Error('meituan_store_card_needs_visual');
  }

  step('门店页搜索图标');
  const shopSearch = await semantic.find(n => nodeLabel(n).trim() === '搜索', 12_000);
  if (!shopSearch) throw new Error('meituan_no_shop_search');
  await semantic.tap(shopSearch, '门店搜索');

  step('店内搜索热门词');
  const hot = await semantic.find(n => nodeLabel(n).trim() === itemName, 12_000);
  if (!hot) throw new Error('meituan_no_hot_word');
  await semantic.tap(hot, `热门 ${itemName}`);

  step('单品');
  const item = await semantic.find(n => nodeLabel(n).trim() === itemName, 14_000);
  if (!item) throw new Error('meituan_no_item');
  await semantic.tap(item, itemName);

  step('加入购物车');
  const add = await semantic.find(n => nodeLabel(n).includes('加入购物车'), 12_000);
  if (!add) throw new Error('meituan_no_add');
  await semantic.tap(add, '加入购物车');

  step('去结算');
  const go = await semantic.find(n => nodeLabel(n).includes('去结算') || nodeLabel(n).includes('去支付'), 18_000);
  if (!go) throw new Error('meituan_no_checkout');
  await semantic.tap(go, '去结算');

  return steps;
}
