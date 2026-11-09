/**
 * 结算证据的隐私遮罩（跨机型 P0-4）。
 *
 * 现状：截图顶部按固定屏高比例遮挡（配置 0.24）。换宽高比、大字体或平板时可能
 * 遮不住配送地址，或把费用行误遮。
 *
 * 改造：优先用配送点位/地址节点的实际位置计算遮罩带（从截图顶部到锚点下方一个
 * 相对边距），找不到锚点时回退到固定比例。这样遮罩跟着内容走，不再跟着屏幕比例走。
 */

export interface BandMask { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Rect { left: number; top: number; width: number; height: number }

export interface PrivacyBandOptions {
  /** 锚点下方额外覆盖的比例（相对屏高），用于盖住地址行 */
  bottomPaddingRatio: number;
  /** 遮罩最小高度（截图像素），过小视为无效 */
  minHeightPx: number;
}

export const DEFAULT_PRIVACY_BAND: PrivacyBandOptions = { bottomPaddingRatio: 0.06, minHeightPx: 40 };

/**
 * 按配送点位/地址锚点计算顶部隐私遮罩带（逻辑坐标锚点 → 截图物理像素）。
 * 返回 null 表示锚点无效，调用方回退固定比例遮罩。
 */
export function privacyBandMask(anchor: Rect, viewport: Size, image: Size, options: PrivacyBandOptions = DEFAULT_PRIVACY_BAND): BandMask | null {
  if (!(viewport.width > 0 && viewport.height > 0 && image.width > 0 && image.height > 0)) return null;
  if (!(anchor.height > 0) || !(anchor.top >= 0)) return null;
  const sy = image.height / viewport.height;
  const bottom = Math.min(image.height, Math.ceil((anchor.top + anchor.height + viewport.height * options.bottomPaddingRatio) * sy));
  if (bottom < options.minHeightPx) return null;
  return { left: 0, top: 0, width: image.width, height: bottom };
}
