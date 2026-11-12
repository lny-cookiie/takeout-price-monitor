// 页面守卫：白名单模式。
// 设计原则（2026-11-09 albert 定）：不枚举“要拦的页面”（分享/问卷/支付…），而是维护“主链路允许出现的页面”白名单；
// 识别不到任何主链路页面特征，就判定偏离主链路，立即返回。枚举黑名单必然有遗漏，白名单才收敛。

export interface GuardNode {
  text?: string;
  desc?: string;
}

export type Platform = 'jd' | 'meituan' | 'taobao';

/** 主链路页面类型。 */
export type PageKind =
  | 'home'        // 各平台首页
  | 'search'      // 搜索页/搜索框
  | 'results'     // 搜索结果页
  | 'store'       // 门店页
  | 'inStore'     // 店内搜索/点餐
  | 'item'        // 商品详情
  | 'checkout'    // 结算页
  | 'unknown';    // 不在白名单

const labelsOf = (nodes: GuardNode[]) => nodes.map(n => `${n.text ?? ''} ${n.desc ?? ''}`);

/** 主链路页面特征（每个平台各自的关键词组合）。命中任一平台的主链路特征即认为在白名单内。 */
const MAIN_PATH_MARKERS: Record<Platform, Array<{kind: PageKind; any: string[]; all?: string[]}>> = {
  jd: [
    {kind: 'home', any: ['首页', '推荐', '我的', '购物车', '搜索']},
    {kind: 'search', any: ['搜索', '取消', '搜索历史']},
    {kind: 'results', any: ['销量', '筛选', '综合']},
    {kind: 'item', any: ['加入购物车', '立即购买', '立即抢购']},
    {kind: 'checkout', any: ['提交订单', '订单详情', '配送', '发票']},
  ],
  meituan: [
    {kind: 'home', any: ['搜索', '小象超市', '外卖', '团购']},
    {kind: 'search', any: ['搜索', '取消', '热门搜索', '历史搜索']},
    {kind: 'results', any: ['综合排序', '销量', '筛选', '全部']},
    {kind: 'store', any: ['点菜', '评价', '商家', '购物车']},
    {kind: 'inStore', any: ['请输入商品名', '热门搜索', '搜索']},
    {kind: 'item', any: ['加入购物车', '去结算', '选规格']},
    {kind: 'checkout', any: ['提交订单', '支付', '配送', '订单', '发票']},
  ],
  taobao: [
    {kind: 'home', any: ['闪购', '推荐', '搜索', '外卖']},
    {kind: 'search', any: ['搜索', '历史搜索', '搜索发现']},
    {kind: 'results', any: ['综合', '销量', '筛选', '外卖']},
    {kind: 'store', any: ['点餐', '评价', '搜一搜', '购物车']},
    {kind: 'item', any: ['加入购物车', '去结算', '选好了', '套餐']},
    {kind: 'checkout', any: ['立即支付', '合计', '配送费', '打包费']},
  ],
};

/** 非主链路兜底标记：即使特征碰巧命中白名单，出现这些强信号也判定为偏离（支付/分享/问卷/弹层）。 */
const HARD_OFF_PATH = [
  '分享至', '分享给', '选择分享', '微信好友', '朋友圈', 'QQ好友',
  '满意度调研', '填写问卷', '感谢您反馈', '获取50个淘金币',
  '确认支付', '立即支付', '支付方式', '请输入支付密码', '付款金额',
];

/** 把当前页面归类为主链路页面类型；识别不到返回 unknown。 */
export function classifyPage(platform: Platform, nodes: GuardNode[]): PageKind {
  const labels = labelsOf(nodes);
  if (labels.some(l => HARD_OFF_PATH.some(k => l.includes(k)))) {
    // 硬信号优先：先看是否是支付/分享/问卷，统一归为 unknown（调用方一律回退）。
    const payment = ['确认支付', '立即支付', '支付方式', '付款金额'].some(k => labels.some(l => l.includes(k)));
    return payment ? 'unknown' : 'unknown';
  }
  for (const marker of MAIN_PATH_MARKERS[platform]) {
    const ok = marker.all ? marker.all.every(k => labels.some(l => l.includes(k))) : marker.any.some(k => labels.some(l => l.includes(k)));
    if (ok) return marker.kind;
  }
  return 'unknown';
}

export interface GuardDecision {
  ok: boolean;
  kind: PageKind;
  reason: 'off_main_path' | null;
}

/** 白名单判定：当前页面是否仍在主链路内。expected 为空表示任意主链路页面均可。 */
export function guardMainPath(platform: Platform, nodes: GuardNode[], expected: PageKind[] = []): GuardDecision {
  const kind = classifyPage(platform, nodes);
  // 淘宝闪购是 Flutter 自绘，读屏几乎必然为空；此时“unknown”不代表偏离主链路，
  // 只代表读不到。读不到时放行，否则守卫会把每一步都 back 掉（曾导致淘宝链路全线失败）。
  if (kind === 'unknown' && platform === 'taobao' && nodes.length === 0) {
    return {ok: true, kind, reason: null};
  }
  const ok = kind !== 'unknown' && (expected.length === 0 || expected.includes(kind));
  return {ok, kind, reason: ok ? null : 'off_main_path'};
}

// ---- 兼容旧调用方的黑名单 API（新代码请用 guardMainPath） ----
const label = (n: GuardNode) => `${n.text ?? ''} ${n.desc ?? ''}`;

export function isSharePage(nodes: GuardNode[]): boolean {
  const labels = nodes.map(label);
  const hasShareTitle = labels.some(l => /分享至|分享给|选择分享|分享到/.test(l));
  const hasChannels = ['微信好友', '朋友圈', 'QQ好友', 'QQ空间', '复制链接'].filter(k => labels.some(l => l.includes(k)));
  return hasShareTitle || hasChannels.length >= 2;
}

export function isSortDropdown(nodes: GuardNode[]): boolean {
  const labels = nodes.map(n => label(n).trim());
  const options = ['综合排序', '速度优先', '好评优先', '距离最近', '销量最高'];
  return labels.filter(l => options.some(o => l === o || l.startsWith(o))).length >= 3;
}

export function isPaymentPage(nodes: GuardNode[]): boolean {
  const labels = nodes.map(label);
  return labels.some(l => /确认支付|立即支付|付款金额|支付方式|请输入支付密码/.test(l));
}

export function isSurveyPage(nodes: GuardNode[]): boolean {
  const labels = nodes.map(label);
  const markers = ['满意度调研', '感谢您反馈', '填写问卷', '问卷填写', '获取50个淘金币', '非常不满意'];
  return markers.filter(k => labels.some(l => l.includes(k))).length >= 2;
}

export function isInterruptPopup(nodes: GuardNode[]): boolean {
  const labels = nodes.map(label);
  const markers = ['立即领取', '去评价', '评价一下', '广告', '稍后再说', '暂不升级'];
  return markers.filter(k => labels.some(l => l.includes(k))).length >= 2;
}

export interface GuardResult {
  kind: 'share' | 'sort' | 'payment' | 'survey' | 'popup' | null;
  shouldBack: boolean;
}

export function guardPage(nodes: GuardNode[]): GuardResult {
  if (isPaymentPage(nodes)) return {kind: 'payment', shouldBack: true};
  if (isSharePage(nodes)) return {kind: 'share', shouldBack: true};
  if (isSortDropdown(nodes)) return {kind: 'sort', shouldBack: true};
  if (isSurveyPage(nodes)) return {kind: 'survey', shouldBack: true};
  if (isInterruptPopup(nodes)) return {kind: 'popup', shouldBack: true};
  return {kind: null, shouldBack: false};
}
