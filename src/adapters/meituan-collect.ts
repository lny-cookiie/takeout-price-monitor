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
    // 只看纯金额节点（¥33.55 / 26.5 这种），避免把“共减¥0.05”这类说明文字当成金额。
    const isAmount = (text: string) => /^[¥￥]?\s*\d[\d.]*\s*元?$/.test(text.trim());
    const candidate = rows
      .filter(r => Math.abs(r.y - hit.y) <= tolerance && r !== hit && isAmount(r.label))
      .sort((a, b) => Math.abs(a.y - hit.y) - Math.abs(b.y - hit.y))[0];
    return candidate ? candidate.label : '';
  };
  const fields = ['商品原价', '打包费', '用户配送费', '红包', '立减', '券前', '实付', '合计'];
  for (const field of fields) {
    const value = valueNear(field);
    if (value) raw[field] = value;
  }
  // 美团结算页底栏是“券前 ¥33.55 共减¥0.05”，金额和标签可能被拆成独立节点；
  // 券前价优先取“券前”标签附近的纯金额，读不到再退回页面上的“实付/合计”。
  const beforeRaw = raw['券前'] || '';
  const couponBeforeFen = beforeRaw ? cny(beforeRaw) : null;
  return {
    raw,
    subtotal_fen: raw['商品原价'] ? cny(raw['商品原价']) : null,
    packaging_fen: raw['打包费'] ? cny(raw['打包费']) : null,
    delivery_fen: raw['用户配送费'] ? cny(raw['用户配送费']) : null,
    discount_fen: raw['红包'] ? cny(raw['红包']) : raw['立减'] ? cny(raw['立减']) : null,
    coupon_before_fen: couponBeforeFen,
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
  /** 被退到桌面时重新打开美团（对应 device.launch()，不清数据） */
  reopenApp?: () => Promise<void>;
  /** 在搜索页用键盘输入并提交关键词（Midscene device.search，已验证支持中文） */
  searchText?: (text: string) => Promise<void>;
  /** 商品结果区的最小 y（物理像素），用于排除顶部搜索框里的同名文本；默认 200 */
  minItemTop?: number;
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
  // 首页特征：用最稳的两个标志——美团自营“小象超市”入口 + 顶部“搜索”按钮。
  // 不依赖“团购/推荐”这类会随滚动、活动位、文案改版而消失的节点。
  const isHome = async () => {
    const nodes = await semantic.read();
    const labels = nodes.map(n => nodeLabel(n).trim());
    const has = (needle: string) => labels.some(l => l.includes(needle));
    const ok = has('小象超市') && has('搜索');
    if (!ok) console.log('[meituan] isHome=false', JSON.stringify({小象超市:has('小象超市'),搜索:has('搜索'),sample:labels.slice(0,8)}));
    return ok;
  };
  // 回首页：先在 App 内返回重试；若已被退到桌面（读不到美团任何节点），重新打开 App（不 force-stop、不清数据）。
  for (let i = 0; i < 5 && !(await isHome()); i++) {
    await semantic.back();
    await semantic.waitStable(4);
  }
  if (!(await isHome())) {
    const probe = await semantic.read();
    const inApp = probe.some(n => nodeLabel(n).includes('美团') || nodeLabel(n).includes('外卖'));
    if (!inApp && options.reopenApp) await options.reopenApp();
    await semantic.waitStable(6);
  }
  if (!(await isHome())) throw new Error('meituan_not_home');

  step('首页搜索按钮');
  const search = await semantic.find(n => nodeLabel(n).trim() === '搜索' && n.width > 100);
  if (!search) throw new Error('meituan_no_search_button');
  await semantic.tap(search, '搜索按钮');

  step('搜索页历史词');
  // 层级 1：键盘输入品牌名（device.search，中文已验证可用，不依赖历史记录）；
  // 层级 2：精确匹配历史词；层级 3：包含匹配。
  const inResultPage = async () => {
    const ns = await semantic.waitStable(6);
    return ns.some(n => nodeLabel(n).includes('综合排序') || nodeLabel(n).includes('全部'));
  };
  let searched = false;
  if (options.searchText) {
    try {
      await options.searchText(brand);
      searched = await inResultPage();
    } catch {
      searched = false;
    }
  }
  if (!searched) {
    const exactHistory = await semantic.find(n => nodeLabel(n).trim() === brand, 6_000);
    const history = exactHistory ?? (await semantic.find(n => nodeLabel(n).includes(brand), 6_000));
    if (!history) throw new Error('meituan_no_search_entry');
    await semantic.tap(history, `历史 ${brand}`);
  }

  step('搜索结果页门店卡（视觉兜底）');
  // 层级 1：语义精确门店卡（desc 通常带评分/配送费，长度明显更长）；
  // 层级 2：视觉定位。搜索联想词（如“麦当劳＆麦咖啡外卖点击可发起搜索”）不能用语义命中。
  const storeCardExact = await semantic.find(
    n => nodeLabel(n).includes(brand) && nodeLabel(n).includes('麦咖啡') && /分|评分|配送|起送|\d\.\d/.test(nodeLabel(n)),
    6_000,
  );
  if (storeCardExact) {
    await semantic.tap(storeCardExact, '门店卡(语义)');
  } else if (options.visualLocate) {
    // 提示词要贴实际界面形态：实测结果页卡片描述形如“221m 麦当劳(天大西门湖滨道IS店) 评分4.7”。
    // 用“门店名这一行文字”定位比“门店卡片”这种抽象描述准得多。
    const hit = await options.visualLocate(`搜索结果里“${brand}”这三个字所在的门店名称那一行（形如 ${brand}(某某店)）`);
    if (!hit) throw new Error('meituan_store_card_unlocated');
    await options.tapPoint(hit.x, hit.y);
    await sleep(1_800);
  } else {
    throw new Error('meituan_store_card_needs_visual');
  }

  step('门店页搜索图标');
  // 美团门店页有两种容器：WMRestaurantActivity 的“搜索”可语义读取，MRNStandardActivity 读不到，需要视觉兜底。
  // 点击后必须进入店内搜索页（出现“请输入商品名”或“热门搜索”）；否则返回重试，避免点成分享/收藏后一路错下去。
  const inShopSearch = async () => {
    const ns = await semantic.waitStable(6);
    const labels = ns.map(n => nodeLabel(n));
    // 新版店内搜索页不一定有“请输入商品/热门搜索”，放宽到搜索框+商品相关特征；同时用 Activity 兜底。
    if (labels.some(l => /请输入商品|热门搜索|搜索商品|店内搜索|商品名称/.test(l))) return true;
    if (labels.some(l => /商品|销量|月售/.test(l)) && labels.some(l => /搜索/.test(l))) return true;
    try {
      const {execFile} = await import('node:child_process');
      const {promisify} = await import('node:util');
      const run = promisify(execFile);
      const adb = process.env.MIDSCENE_ADB_PATH ?? 'adb';
      const serial = process.env.MIDSCENE_ADB_SERIAL ?? '2NP0224627007133';
      const {stdout} = await run(adb, ['-s', serial, 'shell', 'dumpsys window | grep mCurrentFocus'], {timeout: 8_000, encoding: 'utf8'});
      return /ShopSearch|shopsearch|SearchActivity.*shop/i.test(stdout);
    } catch { return false; }
  };
  let enteredShopSearch = false;
  for (let attempt = 0; attempt < 2 && !enteredShopSearch; attempt++) {
    const shopSearch = await semantic.find(n => nodeLabel(n).trim() === '搜索', 6_000);
    if (shopSearch) {
      await semantic.tap(shopSearch, '门店搜索');
    } else if (options.visualLocate) {
      const hit = await options.visualLocate('门店页顶部工具栏里的放大镜搜索按钮（在返回箭头右侧）');
      if (hit) {
        await options.tapPoint(hit.x, hit.y);
        await sleep(1_800);
      }
    }
    enteredShopSearch = await inShopSearch();
    if (!enteredShopSearch) {
      await semantic.back();
      await semantic.waitStable(4);
    }
  }
  if (!enteredShopSearch) throw new Error('meituan_no_shop_search');

  step('店内搜索热门词');
  const hot = await semantic.find(n => nodeLabel(n).trim() === itemName, 12_000);
  if (!hot) throw new Error('meituan_no_hot_word');
  await semantic.tap(hot, `热门 ${itemName}`);

  step('单品');
  // 搜索结果页顶部搜索框里也会出现商品名文本，取列表里最靠下的同名商品卡（列表在搜索框下方）。
  const itemCandidates = await semantic.findAll(n => nodeLabel(n).trim() === itemName, 14_000);
  const item = itemCandidates.length ? itemCandidates[itemCandidates.length - 1]! : null;
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
