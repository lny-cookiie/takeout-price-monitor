import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * 设备几何档案与支持矩阵校验（跨机型改造 P0-1）。
 *
 * 目的：把「这台机器能不能跑」从口头约定变成可检查的事实。每次采集前读取设备的
 * 型号、Android 版本、分辨率、密度、方向与字体缩放，超出支持矩阵时阻断，避免用
 * 未验证的机型硬跑后把错误算成采集失败。
 *
 * 当前只提供读取与校验能力，尚未接入采集主流程——接入与真机验收放到大促结束后
 * （见 24 号计划 M1）。
 */

const run = promisify(execFile);

export interface DeviceGeometry {
  model: string | null;
  sdk: number | null;
  /** 物理分辨率（像素） */
  physicalWidth: number;
  physicalHeight: number;
  /** 逻辑分辨率（dp） */
  width: number;
  height: number;
  density: number;
  dpr: number;
  /** 0/2 竖屏，1/3 横屏；未知为 null */
  orientation: number | null;
  fontScale: number | null;
}

export interface GeometrySupport {
  minLogicalWidth: number;
  maxLogicalWidth: number;
  minAspectRatio: number;
  maxAspectRatio: number;
  minFontScale: number;
  maxFontScale: number;
  requirePortrait: boolean;
}

/** 支持矩阵：竖屏手机，逻辑宽 340–480dp，宽高比 1.9–2.4，字体缩放 0.85–1.15。 */
export const DEFAULT_GEOMETRY_SUPPORT: GeometrySupport = {
  minLogicalWidth: 340,
  maxLogicalWidth: 480,
  minAspectRatio: 1.9,
  maxAspectRatio: 2.4,
  minFontScale: 0.85,
  maxFontScale: 1.15,
  requirePortrait: true,
};

export interface GeometryCheck { ok: boolean; violations: string[] }

function isPortrait(orientation: number | null): boolean {
  return orientation === 0 || orientation === 2;
}

export function validateGeometry(geometry: DeviceGeometry, support: GeometrySupport = DEFAULT_GEOMETRY_SUPPORT): GeometryCheck {
  const violations: string[] = [];
  const aspectRatio = geometry.width > 0 ? geometry.height / geometry.width : 0;
  if (support.requirePortrait && !isPortrait(geometry.orientation)) violations.push('not_portrait');
  if (!(geometry.width >= support.minLogicalWidth && geometry.width <= support.maxLogicalWidth)) violations.push('logical_width_out_of_range');
  if (!(aspectRatio >= support.minAspectRatio && aspectRatio <= support.maxAspectRatio)) violations.push('aspect_ratio_out_of_range');
  if (geometry.fontScale !== null && !(geometry.fontScale >= support.minFontScale && geometry.fontScale <= support.maxFontScale)) violations.push('font_scale_out_of_range');
  if (!(geometry.density > 0) || !(geometry.dpr > 0)) violations.push('density_unknown');
  return { ok: violations.length === 0, violations };
}

export interface ReadGeometryOptions {
  serial: string;
  adbPath?: string;
  timeoutMs?: number;
}

export async function readDeviceGeometry(options: ReadGeometryOptions): Promise<DeviceGeometry> {
  const adbPath = options.adbPath ?? process.env.MIDSCENE_ADB_PATH ?? 'adb';
  const timeoutMs = options.timeoutMs ?? 8000;
  const shell = async (args: string[]): Promise<string> => {
    const { stdout } = await run(adbPath, ['-s', options.serial, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  };
  const [model, sdkRaw, sizeRaw, densityRaw, orientationRaw, fontRaw] = await Promise.all([
    shell(['shell', 'getprop', 'ro.product.model']).catch(() => ''),
    shell(['shell', 'getprop', 'ro.build.version.sdk']).catch(() => ''),
    shell(['shell', 'wm', 'size']).catch(() => ''),
    shell(['shell', 'wm', 'density']).catch(() => ''),
    shell(['shell', 'dumpsys', 'input']).catch(() => ''),
    shell(['shell', 'settings', 'get', 'system', 'font_scale']).catch(() => ''),
  ]);
  const size = /(?:Override|Physical) size:\s*(\d+)x(\d+)/.exec(sizeRaw);
  const density = /(?:Override|Physical) density:\s*(\d+)/.exec(densityRaw);
  const orientation = /SurfaceOrientation:\s*(\d)/.exec(orientationRaw);
  const physicalWidth = size ? Number(size[1]) : 0;
  const physicalHeight = size ? Number(size[2]) : 0;
  const densityValue = density ? Number(density[1]) : 0;
  const dpr = densityValue > 0 ? densityValue / 160 : 0;
  const fontScale = Number(fontRaw.trim());
  return {
    model: model.trim() || null,
    sdk: /^\d+$/.test(sdkRaw.trim()) ? Number(sdkRaw.trim()) : null,
    physicalWidth,
    physicalHeight,
    width: dpr > 0 ? physicalWidth / dpr : 0,
    height: dpr > 0 ? physicalHeight / dpr : 0,
    density: densityValue,
    dpr,
    orientation: orientation ? Number(orientation[1]) : null,
    fontScale: Number.isFinite(fontScale) && fontScale > 0 ? fontScale : null,
  };
}
