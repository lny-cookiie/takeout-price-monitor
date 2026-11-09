import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { UiNode, UITreeSnapshot } from '@midscene/core';

/**
 * 常驻读屏客户端。
 *
 * 背景：`uiautomator dump` 每次调用都会重新启动一次 instrumentation，实测单次约 2.7 秒；
 * 一次采价要读十几到二十几次，读屏占总耗时约 80%。改用常驻的 uiautomator2 server
 * （u2.jar 通过 app_process 启动，JSON-RPC 返回当前层级 XML），实测单次 0.1–0.3 秒。
 *
 * 服务不在时按需拉起；任何一步失败都抛出错误，由调用方回退到原有的 dump 链路。
 */

const run = promisify(execFile);
const DEFAULT_PORT = 9008;
const DEFAULT_REMOTE_JAR = '/data/local/tmp/u2.jar';

export interface AndroidUiTreeReaderOptions {
  serial: string;
  adbPath?: string;
  port?: number;
  jarPath?: string;
  remoteJarPath?: string;
  devicePixelRatio?: number;
  pingTimeoutMs?: number;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  onDiagnostic?: (event: { event: string; ms?: number; detail?: string }) => void;
}

interface HttpResponse { status: number; text: string }

function httpRequest(port: number, method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({
      host: '127.0.0.1', port, method, path, timeout: timeoutMs,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {},
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('http_timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const ENTITY_TABLE: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return ENTITY_TABLE[body] ?? full;
  });
}

const TAG_RE = /<(\/?)([A-Za-z0-9_.:-]+)((?:\s+[A-Za-z0-9_.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const ATTR_RE = /([A-Za-z0-9_.:-]+)\s*=\s*"([^"]*)"/g;
const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;

interface XmlElement { name: string; attrs: Record<string, string>; children: XmlElement[] }

function parseXml(input: string): XmlElement {
  if (input.trim().length === 0) throw new Error('empty_ui_xml');
  const cleaned = input.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  TAG_RE.lastIndex = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(cleaned))) {
    const isClose = '/' === match[1];
    const name = match[2]!;
    if (isClose) {
      const current = stack.pop();
      if (!current || current.name !== name) throw new Error(`unbalanced_close_tag_${name}`);
      continue;
    }
    const attrs: Record<string, string> = {};
    const rawAttrs = match[3] ?? '';
    ATTR_RE.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = ATTR_RE.exec(rawAttrs))) attrs[attr[1]!] = decodeEntities(attr[2]!);
    const element: XmlElement = { name, attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root) throw new Error('multiple_top_level_elements');
    else root = element;
    if ('/' !== match[4]) stack.push(element);
  }
  if (stack.length > 0) throw new Error('unclosed_element');
  if (!root) throw new Error('no_root_element');
  return root;
}

function parseBounds(raw: string | undefined, devicePixelRatio: number): UiNode['bounds'] {
  const match = raw ? BOUNDS_RE.exec(raw) : undefined;
  if (!match) return { left: 0, top: 0, width: 0, height: 0 };
  const left = Number.parseInt(match[1]!, 10);
  const top = Number.parseInt(match[2]!, 10);
  const right = Number.parseInt(match[3]!, 10);
  const bottom = Number.parseInt(match[4]!, 10);
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    left: left / ratio,
    top: top / ratio,
    width: Math.max(0, right - left) / ratio,
    height: Math.max(0, bottom - top) / ratio,
  };
}

function toUiNode(element: XmlElement, devicePixelRatio: number): UiNode {
  const attrs: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(element.attrs)) if ('bounds' !== name) attrs[name] = value;
  return {
    type: element.attrs.class || element.name,
    attrs,
    bounds: parseBounds(element.attrs.bounds, devicePixelRatio),
    children: element.children.map(child => toUiNode(child, devicePixelRatio)),
  };
}

/** 把 uiautomator 层级 XML 转成与现有采集器一致的 UiNode 树（bounds 由物理像素换算为逻辑坐标）。 */
export function uiautomatorXmlToUiNode(xml: string, devicePixelRatio: number): UiNode {
  const root = parseXml(xml);
  if ('hierarchy' === root.name && root.children.length === 1) return toUiNode(root.children[0]!, devicePixelRatio);
  return toUiNode(root, devicePixelRatio);
}

export class AndroidUiTreeReader {
  private ready = false;
  private starting: Promise<void> | null = null;
  private readonly port: number;
  private readonly remoteJarPath: string;
  private devicePixelRatio: number;
  private readonly adbPath: string;
  private readonly pingTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly jarPath: string;
  private readonly options: AndroidUiTreeReaderOptions;
  private readonly onDiagnostic?: AndroidUiTreeReaderOptions['onDiagnostic'];

  constructor(options: AndroidUiTreeReaderOptions) {
    this.options = options;
    this.adbPath = options.adbPath ?? process.env.MIDSCENE_ADB_PATH ?? 'adb';
    this.port = options.port ?? DEFAULT_PORT;
    this.jarPath = options.jarPath ?? resolve('.runtime/uiautomator2-server/u2.jar');
    this.remoteJarPath = options.remoteJarPath ?? DEFAULT_REMOTE_JAR;
    this.devicePixelRatio = options.devicePixelRatio ?? 1;
    this.pingTimeoutMs = options.pingTimeoutMs ?? 800;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 4000;
    this.startTimeoutMs = options.startTimeoutMs ?? 10_000;
    this.onDiagnostic = options.onDiagnostic;
  }

  get serial(): string { return this.options.serial; }

  static async create(options: AndroidUiTreeReaderOptions): Promise<AndroidUiTreeReader> {
    const reader = new AndroidUiTreeReader(options);
    if (!reader.jarPath || !existsSync(reader.jarPath)) throw new Error('u2_jar_missing');
    if (!options.devicePixelRatio) reader.devicePixelRatio = await reader.readDevicePixelRatio();
    return reader;
  }

  private async readDevicePixelRatio(): Promise<number> {
    const density = await this.adb(['shell', 'wm', 'density'], 5000);
    const match = /(\d+)/.exec(density);
    const value = match ? Number(match[1]) : 0;
    if (!(value > 0)) throw new Error('device_density_unknown');
    return value / 160;
  }

  private async adb(args: string[], timeoutMs = 8000): Promise<string> {
    const { stdout } = await run(this.adbPath, ['-s', this.options.serial, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  private async ping(): Promise<boolean> {
    try {
      const response = await httpRequest(this.port, 'GET', '/ping', undefined, this.pingTimeoutMs);
      return response.status === 200 && response.text.trim() === 'pong';
    } catch { return false; }
  }

  private async ensureForward(): Promise<void> {
    try { await this.adb(['forward', `tcp:${this.port}`, `tcp:${this.port}`], 5000); }
    catch { /* 已存在的转发会报错，不影响后续连接 */ }
  }

  private async ensureJar(): Promise<void> {
    const localSize = statSync(this.jarPath).size;
    let remoteSize = -1;
    try {
      const listing = await this.adb(['shell', 'ls', '-l', this.remoteJarPath], 5000);
      const match = /(\d+)\s+\S*\s*$/.exec(listing.trim());
      remoteSize = match ? Number(match[1]) : -1;
    } catch { remoteSize = -1; }
    if (remoteSize !== localSize) {
      this.onDiagnostic?.({ event: 'push_jar' });
      await this.adb(['push', this.jarPath, this.remoteJarPath], 20_000);
    }
  }

  private async ensure(): Promise<void> {
    if (this.ready && await this.ping()) return;
    if (this.starting) { await this.starting; return; }
    this.starting = (async () => {
      const startedAt = Date.now();
      await this.ensureForward();
      if (!(await this.ping())) {
        await this.ensureJar();
        const command = `nohup sh -c 'CLASSPATH=${this.remoteJarPath} app_process / com.wetest.uia2.Main -p ${this.port}' >/dev/null 2>&1 &`;
        await this.adb(['shell', command], 8000).catch(() => '');
        const deadline = Date.now() + this.startTimeoutMs;
        while (Date.now() < deadline) {
          if (await this.ping()) break;
          await new Promise(resolveWait => setTimeout(resolveWait, 250));
        }
        if (!(await this.ping())) throw new Error('u2_server_not_ready');
      }
      this.ready = true;
      this.onDiagnostic?.({ event: 'ready', ms: Date.now() - startedAt });
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  /** 读取当前界面控件树；服务不可用或返回异常时抛错，由调用方回退。 */
  async read(): Promise<UITreeSnapshot> {
    await this.ensure();
    const startedAt = Date.now();
    const response = await httpRequest(this.port, 'POST', '/jsonrpc/0', {
      jsonrpc: '2.0', id: 1, method: 'dumpWindowHierarchy', params: [true, 50],
    }, this.requestTimeoutMs);
    if (response.status !== 200) throw new Error(`u2_http_${response.status}`);
    const payload = JSON.parse(response.text) as { result?: unknown; error?: { message?: string } };
    if (payload.error) throw new Error(`u2_rpc_${payload.error.message ?? 'unknown'}`);
    if (typeof payload.result !== 'string' || !payload.result.includes('<hierarchy')) throw new Error('u2_invalid_hierarchy');
    const root = uiautomatorXmlToUiNode(payload.result, this.devicePixelRatio);
    this.onDiagnostic?.({ event: 'read', ms: Date.now() - startedAt, detail: String(Math.round(response.text.length / 1024)) + 'kb' });
    return { platform: 'android', capturedAt: Date.now(), root };
  }
}
