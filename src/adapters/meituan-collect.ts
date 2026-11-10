// 美团采集主流程（骨架）：
// - 导航步骤全部走 u2 语义定位（meituan-semantic 模块）；
// - 搜索结果页的门店卡是自绘列表，语义读不到，需要视觉兜底（visualLocate 注入 model.locate）；
// - 结算页字段与京东一一对应，实付按"券前价 − 红包"计算（券后价）。
// 说明：本文件只定义流程与数据形状，尚未接入服务端调度；真机验证通过后再接入。

import type { AndroidSource } from './android-source.js';
import type { U2Semantic, U2Node } from './meituan-semantic.js';
import { nodeLabel } from './meituan-semantic.js';
import { createPageAsserter, type MeituanPage, type PageAsserter } from './page-assert.js';

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
  const hitLeft = new Map<{y:number;label:string}, number>();
  const rows = nodes
    .filter(n => nodeLabel(n))
    .map(n => ({ y: n.top + n.height / 2, label: nodeLabel(n), left: n.left }))
    .sort((a, b) => a.y - b.y);
  for (const r of rows) hitLeft.set(r, r.left ?? 0);
  const valueNear = (label: string, tolerance = 40): string => {
    const hit = rows.find(r => r.label.includes(label));
    if (!hit) return '';
    // 只看纯金额节点（¥33.55 / 26.5 这种），避免把“共减¥0.05”这类说明文字当成金额。
    // 金额至少要两位整数或带小数（避免把“3元红包”里的单个“3”或“共减5”的“5”当成费用金额）。
    const isAmount = (text: string) => {
      const t = text.trim();
      if (!/^[¥￥]?\s*\d[\d.]*\s*元?$/.test(t)) return false;
      const num = t.replace(/[¥￥元\s]/g, '');
      return /\d{2,}/.test(num) || /\.\d+/.test(num);
    };
    // 金额配对要同时考虑纵向和横向：标签在左，金额在其右侧同一行附近。
    // 只按纵距离会在“券前/一单回本/两单回本”这种密集区域选错（曾把会员卡价格 ¥60 当成券前价）。
    const hitX = rows.find(r => r.label.includes(label)) as any;
    const tagLeft = hitLeft.get(hit) ?? 0;
    const candidate = rows
      .filter(r => Math.abs(r.y - hit.y) <= tolerance && r !== hit && isAmount(r.label))
      .sort((a, b) => {
        const la = hitLeft.get(a) ?? 0, lb = hitLeft.get(b) ?? 0;
        // 优先右侧同行的金额，且横向距离越近越好
        const dxA = la >= tagLeft ? la - tagLeft : 9999;
        const dxB = lb >= tagLeft ? lb - tagLeft : 9999;
        const dyA = Math.abs(a.y - hit.y), dyB = Math.abs(b.y - hit.y);
        // 红包行横跨整行（“美团红包 …… 3元红包”），横向窗口要放宽；券前这类要收紧避免抓到会员卡。
        const win = /红包|优惠|立减|合计|实付/.test(label) ? 500 : 200;
        if (dxA < win && dxB >= win) return -1;
        if (dxB < win && dxA >= win) return 1;
        const scoreA = dxA + dyA * 2, scoreB = dxB + dyB * 2;
        return scoreA - scoreB;
      })[0];
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
  // 事前校验：复用 semantic 的 read/back/waitStable，零额外读屏。
  const asserter: PageAsserter = createPageAsserter({
    read: () => semantic.read(),
    back: () => semantic.back(),
    waitStable: (n?: number) => semantic.waitStable(n),
    log: (m: string) => console.log(m),
  });
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
    // 首页判定放宽：新版首页不一定有“小象超市”，但一定有“外卖/团购/我的”这类底部 tab。
    const ok = has('搜索') && (has('小象超市') || has('外卖') || has('团购') || has('我的') || has('推荐'));
    if (!ok) console.log('[meituan] isHome=false', JSON.stringify({搜索:has('搜索'),外卖:has('外卖'),团购:has('团购'),sample:labels.slice(0,8)}));
    return ok;
  };
  // 回首页：优先用 am start 重新拉起主界面（back 会把 App 退出到桌面，反而更糟）。
  const startHome = async () => {
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    const run = promisify(execFile);
    const adb = process.env.MIDSCENE_ADB_PATH ?? 'adb';
    const serial = process.env.MIDSCENE_ADB_SERIAL ?? '2NP0224627007133';
    // -S 先 force-stop 再启动：单纯 am start 不会清栈，会停在上一轮的门店页/结算页。
    // 注意：这里 force-stop 是重启 App 回到首页，不是清数据，符合“点错返回上一页”的约束边界。
    await run(adb, ['-s', serial, 'shell', 'am', 'start', '-S', '-n',
      'com.sankuai.meituan/com.meituan.android.pt.homepage.activity.MainActivity'],
      {timeout: 20_000, encoding: 'utf8'}).catch(() => null);
    await semantic.waitStable(8);
  };
  for (let i = 0; i < 3 && !(await isHome()); i++) {
    console.log('[meituan] 不在首页，重新拉起主界面 attempt', i + 1);
    await startHome();
  }
  if (!(await isHome())) {
    // 再次兜底：先 am start，再最多 back 2 次（只在不退出 App 的范围内）
    await startHome();
    for (let i = 0; i < 2 && !(await isHome()); i++) { await semantic.back(); await semantic.waitStable(3); }
  }
  if (!(await isHome())) throw new Error('meituan_not_home');

  await asserter.ensure('home');
  step('进入外卖频道');
  // 用户明确要求：必须先点【外卖】频道再搜索，否则团购业务会混进来；且点击前必须确认仍在主链路
  // （曾出现误点“会场/便利鲜食”活动页的情况），不在主链路就先 back 回来。
  const inMainPath = async () => {
    const ns = await semantic.read().catch(() => [] as U2Node[]);
    const labels = ns.map(n => nodeLabel(n));
    return labels.some(l => /外卖|团购|我的|推荐|搜索/.test(l));
  };
  for (let i = 0; i < 4 && !(await inMainPath()); i++) {
    await semantic.back();
    await semantic.waitStable(4);
  }
  const takeoutTab = await semantic.find(n => nodeLabel(n).trim() === '外卖' && n.top > 300, 8_000)
    ?? await semantic.find(n => nodeLabel(n).trim() === '外卖', 4_000);
  if (!takeoutTab) throw new Error('meituan_no_takeout_tab');
  await semantic.tap(takeoutTab, '外卖频道');
  await semantic.waitStable(6);
  {
    const probe = await semantic.waitStable(4);
    const labels = probe.map(n => nodeLabel(n));
    const inTakeout = labels.some(l => /附近|到店|外卖|点菜|距离/.test(l));
    if (!inTakeout) console.error('[meituan] 外卖频道校验未通过，继续尝试');
    else console.log('[meituan] 已进入外卖频道');
  }

  step('外卖频道搜索按钮');
  const search = await semantic.find(n => nodeLabel(n).trim() === '搜索' && n.width > 40, 8_000)
    ?? await semantic.find(n => /搜索/.test(nodeLabel(n)) && n.width > 40, 6_000);
  if (!search) throw new Error('meituan_no_search_button');
  await semantic.tap(search, '搜索按钮');

  step('搜索品牌');
  // 层级 1：键盘输入品牌名（device.search，中文已验证可用，不依赖历史记录）；
  // 层级 2：精确匹配历史词；层级 3：包含匹配。
  const inResultPage = async () => {
    const ns = await semantic.waitStable(6);
    const labels = ns.map(n => nodeLabel(n));
    // 关键：首页推荐流也有“月售/评分”，不能靠这些词判定结果页。
    // 结果页的硬特征是 Activity=SearchResultActivity，或顶部搜索框里带着刚搜的品牌名。
    try {
      const {execFile} = await import('node:child_process');
      const {promisify} = await import('node:util');
      const run = promisify(execFile);
      const adb = process.env.MIDSCENE_ADB_PATH ?? 'adb';
      const serial = process.env.MIDSCENE_ADB_SERIAL ?? '2NP0224627007133';
      const {stdout} = await run(adb, ['-s', serial, 'shell', 'dumpsys window | grep mCurrentFocus'], {timeout: 8_000, encoding: 'utf8'});
      if (/SearchResultActivity|search\.result/i.test(String(stdout))) return true;
    } catch { /* 落到文本判据 */ }
    // 文本兜底：搜索框节点里同时含品牌名和“搜索”提示，说明这是结果页顶栏。
    return labels.some(l => l.includes(brand) && /搜索框|点击可搜索/.test(l))
      && labels.some(l => /综合排序|筛选|销量最高|距离最近/.test(l));
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
    if (history) {
      await semantic.tap(history, `历史 ${brand}`);
    } else if (options.visualLocate) {
      // 搜索页是 MRNX 容器读不到历史词：用视觉点搜索框，再键盘输入。
      const inputHit = await options.visualLocate('页面顶部写着“搜索”的输入框');
      if (!inputHit) throw new Error('meituan_no_search_entry');
      await options.tapPoint(inputHit.x, inputHit.y);
      await sleep(1_200);
      await options.searchText?.(brand);
      for (let i = 0; i < 5 && !searched; i++) { await sleep(1_000); searched = await inResultPage(); }
      if (!searched) throw new Error('meituan_search_failed');
    } else {
      throw new Error('meituan_no_search_entry');
    }
  }

  step('搜索结果页门店卡（视觉兜底）');
  // 层级 1：语义精确门店卡（desc 通常带评分/配送费，长度明显更长）；
  // 层级 2：视觉定位。搜索联想词（如“麦当劳＆麦咖啡外卖点击可发起搜索”）不能用语义命中。
  // 搜索结果页是原生页面（实测 read 可读到“麦当劳/评分/月售”），语义优先；视觉仅兜底。
  // 之前只匹配“品牌+麦咖啡”过窄，导致可用语义命中被浪费、被迫依赖不稳定的视觉模型。
  const storeCardExact = await semantic.find(
    n => {
      const l = nodeLabel(n);
      if (!l.includes(brand)) return false;
      // 排除搜索框/历史词/推荐词这类非门店节点
      if (/进入搜索|搜索框|历史|猜你想|为你推荐/.test(l)) return false;
      return /分|评分|配送|起送|\d+\.\d+|月售|km|进店/.test(l);
    },
    8_000,
  ) ?? await semantic.find(
    n => {
      const l = nodeLabel(n);
      if (!l.includes(brand)) return false;
      if (/进入搜索|搜索框|历史|猜你想/.test(l)) return false;
      return n.top > 200; // 门店卡在页面中下部
    },
    6_000,
  );
  if (storeCardExact) {
    // 点卡片右侧（进店按钮区），点标题文字不会跳转
    await semantic.tap(storeCardExact, '门店卡(语义-右侧进店)', 0.85);
  } else if (options.visualLocate) {
    // 提示词要贴实际界面形态：实测结果页卡片描述形如“221m 麦当劳(天大西门湖滨道IS店) 评分4.7”。
    // 用“门店名这一行文字”定位比“门店卡片”这种抽象描述准得多。
    // 门店名文字本身可能只是选中卡片而不跳转，真正进店的是卡片上的“进店”按钮。
    // 策略：优先点“进店”按钮，没有才退回点门店名；点完都要等页面跳转。
    const enterBtn = await options.visualLocate(`搜索结果门店卡片右侧的“进店”按钮`);
    console.log('[meituan] 视觉-进店按钮', enterBtn ? `dp ${enterBtn.x.toFixed(0)},${enterBtn.y.toFixed(0)}` : 'null');
    const cardHit = enterBtn ?? await options.visualLocate(`搜索结果里“${brand}”这三个字所在的门店名称那一行（形如 ${brand}(某某店)）`);
    console.log('[meituan] 视觉-门店名', cardHit ? `dp ${cardHit.x.toFixed(0)},${cardHit.y.toFixed(0)}` : 'null');
    if (!cardHit) throw new Error('meituan_store_card_unlocated');
    await options.tapPoint(cardHit.x, cardHit.y);
    await sleep(2_800);
  } else {
    throw new Error('meituan_store_card_needs_visual');
  }

  // 进店校验：只要求 Activity 离开结果页/搜索页（页面确实跳转了）。
  // 不能用 ensure('store')：美团门店页是 MRNStandardActivity，读屏读不到节点，会被误判成偏离并 back 退出来。
  {
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    const run = promisify(execFile);
    const adb = process.env.MIDSCENE_ADB_PATH ?? 'adb';
    const serial = process.env.MIDSCENE_ADB_SERIAL ?? '2NP0224627007133';
    let entered = false;
    for (let i = 0; i < 8 && !entered; i++) {
      const {stdout} = await run(adb, ['-s', serial, 'shell', 'dumpsys window | grep mCurrentFocus'],
        {timeout: 8_000, encoding: 'utf8'}).catch(() => ({stdout: ''}));
      const act = String(stdout);
      if (!/SearchResultActivity|search\.result|search\.home\.SearchActivity/i.test(act)) {
        // 已经不在结果页/搜索页 → 视为进店成功
        const m = /\s([\w.]+\/[\w.$]+)\}/.exec(act);
        const now = m ? m[1]! : '';
        if (now && !/homepage\.activity\.MainActivity/i.test(now)) { entered = true; console.log('[meituan] 已进店 activity=' + now.slice(0, 70)); }
      }
      await sleep(700);
    }
    if (!entered) throw new Error('meituan_store_not_entered');
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
  // 店内搜索页是 MRNX 自绘容器，读屏不可用：优先视觉点热门词，语义仅作兜底。
  const hotSemantic = await semantic.find(n => nodeLabel(n).trim() === itemName, 4_000).catch(() => null);
  if (hotSemantic) {
    await semantic.tap(hotSemantic, `热门 ${itemName}`);
  } else if (options.visualLocate) {
    const hotHit = await options.visualLocate(`搜索结果里“${itemName}”这个热门搜索词/商品名`);
    if (!hotHit) throw new Error('meituan_no_hot_word');
    await options.tapPoint(hotHit.x, hotHit.y);
    await sleep(1_800);
  } else {
    throw new Error('meituan_no_hot_word');
  }

  step('单品');
  // 单品列表同为 MRNX：视觉定位商品卡（提示词贴商品名+价格），语义兜底。
  let itemTapped = false;
  const itemCandidates = await semantic.findAll(n => nodeLabel(n).trim() === itemName, 5_000).catch(() => []);
  if (itemCandidates.length) {
    await semantic.tap(itemCandidates[itemCandidates.length - 1]!, itemName);
    itemTapped = true;
  } else if (options.visualLocate) {
    const itemHit = await options.visualLocate(`商品列表里“${itemName}”这张商品卡（带价格的那一行）`);
    if (itemHit) { await options.tapPoint(itemHit.x, itemHit.y); itemTapped = true; await sleep(1_800); }
  }
  if (!itemTapped) throw new Error('meituan_no_item');

  // 单品详情是 MPTranslucentActivity（半透明弹层），同样不能用页面身份断言去否决。
  // 加购步骤自身有宽松校验（找到“加入购物车”或无按钮但出现“去结算”），足够判断是否在商品层。
  step('加入购物车');
  // 宽松校验：找到“加入购物车”就点；找不到但页面已有数量+去结算，说明商品已在购物车，直接进结算。
  const add = await semantic.find(n => nodeLabel(n).includes('加入购物车'), 8_000).catch(() => null);
  if (add) {
    await semantic.tap(add, '加入购物车');
    await sleep(1_200);
  } else {
    const probe = await semantic.waitStable(6);
    const labels = probe.map(n => nodeLabel(n));
    const hasCheckout = labels.some(l => l.includes('去结算'));
    const hasQuantity = labels.some(l => /^\d+$/.test(l.trim())) || labels.some(l => /件|份/.test(l));
    if (hasCheckout) {
      console.log('[meituan] 未找到加购按钮，但已出现“去结算”，判定为已加购');
    } else if (!hasQuantity) {
      throw new Error('meituan_no_add');
    } else {
      console.log('[meituan] 未找到加购按钮，但页面已有数量选择，判定为已加购');
    }
  }

  step('去结算');
  const go = await semantic.find(n => nodeLabel(n).includes('去结算') || nodeLabel(n).includes('去支付'), 18_000);
  if (!go) throw new Error('meituan_no_checkout');
  await semantic.tap(go, '去结算');

  return steps;
}
