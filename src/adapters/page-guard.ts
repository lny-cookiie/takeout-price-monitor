// 页面守卫：识别并处理“点错后打开的意外页面”，避免整条采集链路卡死。
// 已知事故：美团/京东的“分享面板”被误点后，流程在错误页面上等待控件直到超时。

export interface GuardNode {
  text?: string;
  desc?: string;
}

const label = (n: GuardNode) => `${n.text ?? ''} ${n.desc ?? ''}`;

/** 是否是分享面板（京东/美团/淘宝的分享弹层特征）。 */
export function isSharePage(nodes: GuardNode[]): boolean {
  const labels = nodes.map(label);
  const hasShareTitle = labels.some(l => /分享至|分享给|选择分享|分享到/.test(l));
  const hasChannels = ['微信好友', '朋友圈', 'QQ好友', 'QQ空间', '复制链接'].filter(k => labels.some(l => l.includes(k)));
  return hasShareTitle || hasChannels.length >= 2;
}

/** 是否是排序/筛选下拉（点错排序按钮时的特征）。 */
export function isSortDropdown(nodes: GuardNode[]): boolean {
  const labels = nodes.map(n => label(n).trim());
  const options = ['综合排序', '速度优先', '好评优先', '距离最近', '销量最高'];
  return labels.filter(l => options.some(o => l === o || l.startsWith(o))).length >= 3;
}

/** 是否是支付页（安全红线：出现即退回，不做任何支付动作）。 */
export function isPaymentPage(nodes: GuardNode[]): boolean {
  const labels = nodes.map(label);
  return labels.some(l => /确认支付|立即支付|付款金额|支付方式|请输入支付密码/.test(l));
}

/** 是否是满意度调研/问卷页（淘宝搜索后弹出的反馈问卷，非主链路页面）。 */
export function isSurveyPage(nodes: GuardNode[]): boolean {
  const labels = nodes.map(label);
  const markers = ['满意度调研', '感谢您反馈', '填写问卷', '问卷填写', '获取50个淘金币', '非常不满意'];
  return markers.filter(k => labels.some(l => l.includes(k))).length >= 2;
}

/** 是否是调查/评价邀请等中断式弹层（领券、评价、广告弹窗）。 */
export function isInterruptPopup(nodes: GuardNode[]): boolean {
  const labels = nodes.map(label);
  const markers = ['立即领取', '去评价', '评价一下', '广告', '稍后再说', '暂不升级'];
  return markers.filter(k => labels.some(l => l.includes(k))).length >= 2;
}

export interface GuardResult {
  kind: 'share' | 'sort' | 'payment' | 'survey' | 'popup' | null;
  shouldBack: boolean;
}

/** 检查当前页面是否属于需要立即退回的意外页面。 */
export function guardPage(nodes: GuardNode[]): GuardResult {
  if (isPaymentPage(nodes)) return {kind: 'payment', shouldBack: true};
  if (isSharePage(nodes)) return {kind: 'share', shouldBack: true};
  if (isSortDropdown(nodes)) return {kind: 'sort', shouldBack: true};
  if (isSurveyPage(nodes)) return {kind: 'survey', shouldBack: true};
  if (isInterruptPopup(nodes)) return {kind: 'popup', shouldBack: true};
  return {kind: null, shouldBack: false};
}
