import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UiNode, UITreeSnapshot } from '@midscene/core';
import { uiautomatorXmlToUiNode } from './android-uitree.js';

/**
 * 轻量 dump 读屏：把 uiautomator dump 原本的 3 次 adb 调用（rm / dump / cat）合并成 1 次
 * shell 会话，并跳过 Midscene 的显示校验，减少每次读取固定开销。
 *
 * 为什么不用常驻服务：京东门店页是小程序 WebView，u2 与 Appium 都读不到 WebView
 * 虚拟节点，只有 AndroidX UiAutomator 的 dump 能读（见 25 号调研 12 节）。
 */

const run = promisify(execFile);
const REMOTE_PATH = '/sdcard/midscene_window_dump.xml';

export interface AndroidDumpTreeOptions {
  serial: string;
  adbPath?: string;
  devicePixelRatio?: number;
  timeoutMs?: number;
  onDiagnostic?: (event: { event: string; ms?: number; detail?: string }) => void;
}

export class AndroidDumpTreeReader {
  private readonly serial: string;
  private readonly adbPath: string;
  private readonly timeoutMs: number;
  private devicePixelRatio: number;
  private readonly onDiagnostic?: AndroidDumpTreeOptions['onDiagnostic'];

  constructor(options: AndroidDumpTreeOptions) {
    this.serial = options.serial;
    this.adbPath = options.adbPath ?? process.env.MIDSCENE_ADB_PATH ?? 'adb';
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.devicePixelRatio = options.devicePixelRatio ?? 1;
    this.onDiagnostic = options.onDiagnostic;
  }

  static async create(options: AndroidDumpTreeOptions): Promise<AndroidDumpTreeReader> {
    const reader = new AndroidDumpTreeReader(options);
    if (!options.devicePixelRatio) reader.devicePixelRatio = await reader.readDevicePixelRatio();
    return reader;
  }

  private async adb(args: string[], timeoutMs: number): Promise<string> {
    const { stdout } = await run(this.adbPath, ['-s', this.serial, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  }

  private async readDevicePixelRatio(): Promise<number> {
    const density = await this.adb(['shell', 'wm', 'density'], 5000);
    const match = /(\d+)/.exec(density);
    const value = match ? Number(match[1]) : 0;
    if (!(value > 0)) throw new Error('device_density_unknown');
    return value / 160;
  }

  /** 读取当前界面控件树；失败抛错，由调用方回退到 Midscene 原始 dump。 */
  async read(): Promise<UITreeSnapshot> {
    const startedAt = Date.now();
    // 单次 shell：清理旧文件 → dump → 直接输出 XML。避免 3 次 adb 往返。
    const xml = await this.adb(['shell', `rm -f ${REMOTE_PATH}; uiautomator dump --compressed ${REMOTE_PATH} >/dev/null 2>&1; cat ${REMOTE_PATH}`], this.timeoutMs);
    if (!xml || !xml.includes('<hierarchy')) throw new Error('dump_empty');
    const root = uiautomatorXmlToUiNode(xml, this.devicePixelRatio);
    this.onDiagnostic?.({ event: 'fast_dump', ms: Date.now() - startedAt, detail: `${Math.round(xml.length / 1024)}kb` });
    return { platform: 'android', capturedAt: Date.now(), root };
  }
}
