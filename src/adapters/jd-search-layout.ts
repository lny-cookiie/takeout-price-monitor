/**
 * 京东搜索结果页的版式计算（跨机型改造 P0-2 / P0-3）。
 *
 * 现状问题：搜索页证据裁剪写死「屏高 17%–72%」，门店头部定位写死「x 0.43–0.70、
 * y 0.21–0.29」的比例窗口。这些是按单台机型校准的常量，换宽高比、大字体或平板时
 * 会裁错区域或找不到门店入口。
 *
 * 这里把两处计算抽成纯函数：裁剪区域优先用搜索结果容器的实际 bounds，门店头部窗口
 * 参数可配置并标注校准设备。尚未接入采集主流程（接入与真机验收留到大促结束后）。
 */

export interface Rect { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface CropRegion { left: number; top: number; width: number; height: number }

export interface SearchCropConfig {
  /** 裁剪区域相对结果容器上下外扩的比例（容器高度的占比） */
  paddingRatio: number;
  /** 裁剪高度上限（相对截图高度），避免把整屏塞给模型 */
  maxHeightRatio: number;
  /** 裁剪区域最小高度（截图像素），过小视为计算结果无效 */
  minHeightPx: number;
}

export const DEFAULT_SEARCH_CROP: SearchCropConfig = { paddingRatio: 0.02, maxHeightRatio: 0.55, minHeightPx: 120 };

/**
 * 按搜索结果容器的实际 bounds 计算模型输入裁剪区域（逻辑坐标 → 截图物理像素）。
 * 返回 null 表示容器信息不可用或结果无效，调用方应回退到原有固定比例裁剪。
 */
export function searchCropRegion(container: Rect, viewport: Size, image: Size, config: SearchCropConfig = DEFAULT_SEARCH_CROP): CropRegion | null {
  if (!(viewport.width > 0 && viewport.height > 0 && image.width > 0 && image.height > 0)) return null;
  if (!(container.width > 0 && container.height > 0)) return null;
  const sx = image.width / viewport.width;
  const sy = image.height / viewport.height;
  const padding = container.height * config.paddingRatio;
  const rawTop = (container.top - padding) * sy;
  const rawBottom = (container.top + container.height + padding) * sy;
  const top = Math.max(0, Math.floor(rawTop));
  const bottom = Math.min(image.height, Math.ceil(rawBottom));
  const maxHeight = Math.floor(image.height * config.maxHeightRatio);
  const height = Math.min(bottom - top, maxHeight);
  const width = image.width;
  if (width <= 0 || height < config.minHeightPx) return null;
  return { left: 0, top, width, height };
}

export interface StoreHeaderWindow {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** 锚点最小高度（相对屏高） */
  minHeightRatio: number;
}

/** 基线机型（HBN-AL00，1260×2844）校准的窗口；其他机型需要重新校准并登记。 */
export const DEFAULT_STORE_HEADER_WINDOW: StoreHeaderWindow = { minX: 0.43, maxX: 0.70, minY: 0.21, maxY: 0.29, minHeightRatio: 0 };

/**
 * 判断搜索结果卡片是否处于「门店头部」位置，返回可点击坐标（逻辑坐标）。
 * 返回 null 表示位置不符合已校准窗口，调用方应停止并报告版式变化，而不是乱点。
 */
export function storeHeaderAnchor(anchor: Rect, viewport: Size, window: StoreHeaderWindow = DEFAULT_STORE_HEADER_WINDOW): { x: number; y: number } | null {
  if (!(viewport.width > 0 && viewport.height > 0)) return null;
  const { left, top, width, height } = anchor;
  const within = left > viewport.width * window.minX && left < viewport.width * window.maxX &&
    top > viewport.height * window.minY && top < viewport.height * window.maxY &&
    width > 0 && left + width <= viewport.width + 2 && height > 0 &&
    height >= viewport.height * window.minHeightRatio;
  if (!within) return null;
  return { x: left + width * 0.25, y: top - viewport.height * 0.035 };
}
