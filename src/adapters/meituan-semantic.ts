// 美团采集的语义定位基础模块：
// 1) 直接解析 u2 JSON-RPC 的原始 XML（保留 text/content-desc，绕过 Midscene 树丢失文本的问题）；
// 2) 点击坐标一律由节点 bounds 按屏幕比例换算（跨机型，无绝对坐标常量）；
// 3) 语义匹配失败时，把"视觉兜底"收敛到一个 hook，由调用方注入（项目统一的 model.locate）。
// 4) 点错后的恢复方式是返回上一页重试，禁止重启 App。

import {guardPage} from './page-guard.js';

export interface U2Node {
  text: string;
  desc: string;
  cls: string;
  rid: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface U2Semantic {
  read(): Promise<U2Node[]>;
  find(pred: (n: U2Node) => boolean, timeoutMs?: number): Promise<U2Node | null>;
  /** 找所有匹配节点（按纵向从上到下排序），用于“排除顶部搜索框、选列表里的商品卡”这类场景 */
  findAll(pred: (n: U2Node) => boolean, timeoutMs?: number): Promise<U2Node[]>;
  tap(node: U2Node, label: string): Promise<void>;
  waitStable(rounds?: number): Promise<U2Node[]>;
  back(): Promise<void>;
  tapByVisual(hint: string): Promise<boolean>;
}

export const nodeLabel = (n: U2Node) => `${n.text} ${n.desc}`.trim();

export interface U2SemanticOptions {
  /** u2 服务端口（默认 9008） */
  port?: number;
  /** 读树的超时 */
  readTimeoutMs?: number;
  /** 读取完整页面节点的函数（调用方提供，通常来自 connectAndroid 的 device） */
  tapPoint: (x: number, y: number) => Promise<void>;
  /** 逻辑屏尺寸（dp），用于把物理 bounds 换算成 device.tap 需要的坐标系 */
  logicalSize: () => Promise<{ width: number; height: number }>;
  /** 物理分辨率（物理像素），可从 `wm size` 读取 */
  physicalSize: () => Promise<{ width: number; height: number }>;
  /** 返回上一页 */
  back: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** 视觉兜底：语义匹配不到时，用截图找目标（由调用方注入 model.locate） */
  visualLocate?: (hint: string) => Promise<{ x: number; y: number } | null>;
}

/** 解析 u2 dumpWindowHierarchy 返回的 XML，提取带语义的节点。 */
export function parseU2Xml(xml: string): U2Node[] {
  const nodes: U2Node[] = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const raw = m[1] ?? '';
    const attr = (name: string) => {
      const hit = new RegExp(name + '="([^"]*)"').exec(raw);
      return hit ? hit[1]! : '';
    };
    const bm = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
    if (!bm) continue;
    const [l, t, r, b] = [Number(bm[1]), Number(bm[2]), Number(bm[3]), Number(bm[4])];
    nodes.push({
      text: attr('text'),
      desc: attr('content-desc'),
      cls: attr('class'),
      rid: attr('resource-id'),
      left: l,
      top: t,
      width: r - l,
      height: b - t,
    });
  }
  return nodes.filter(n => nodeLabel(n));
}

export function createU2Semantic(options: U2SemanticOptions): U2Semantic {
  const port = options.port ?? 9008;
  const sleep = options.sleep;
  let physical: { width: number; height: number } | null = null;

  const read = async (): Promise<U2Node[]> => {
    const resp = await fetch(`http://127.0.0.1:${port}/jsonrpc/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'dumpWindowHierarchy', params: [true, 200, true] }),
      signal: AbortSignal.timeout(options.readTimeoutMs ?? 15_000),
    });
    const data = (await resp.json()) as { result?: string };
    return parseU2Xml(data.result ?? '');
  };

  const waitStable = async (rounds = 8): Promise<U2Node[]> => {
    let last = -1;
    for (let i = 0; i < rounds; i++) {
      const ns = await read().catch(() => [] as U2Node[]);
      if (ns.length > 0 && ns.length === last) return ns;
      last = ns.length;
      await sleep(650);
    }
    return await read().catch(() => [] as U2Node[]);
  };

  const find = async (pred: (n: U2Node) => boolean, timeoutMs = 20_000): Promise<U2Node | null> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const ns = await waitStable();
      // 点错打开分享/排序/支付页时立即退回，避免在错误页面上空等直到超时。
      const guard = guardPage(ns.map(n => ({text: n.text, desc: n.desc})));
      if (guard.shouldBack) {
        console.log(`[meituan] 遇到意外页面(${guard.kind})，返回重试`);
        await options.back();
        await sleep(1200);
        continue;
      }
      const hit = ns.find(pred);
      if (hit) return hit;
      await sleep(450);
    }
    return null;
  };

  const findAll = async (pred: (n: U2Node) => boolean, timeoutMs = 20_000): Promise<U2Node[]> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const ns = await waitStable();
      const hits = ns.filter(pred).sort((a, b) => a.top - b.top);
      if (hits.length) return hits;
      await sleep(450);
    }
    return [];
  };

  const tap = async (node: U2Node, label: string): Promise<void> => {
    physical ??= await options.physicalSize();
    const logical = await options.logicalSize();
    const x = ((node.left + node.width / 2) / physical.width) * logical.width;
    const y = ((node.top + node.height / 2) / physical.height) * logical.height;
    console.log(`[meituan] tap ${label} | ${nodeLabel(node).slice(0, 24)} | dp ${Math.round(x)},${Math.round(y)}`);
    await options.tapPoint(x, y);
    await sleep(1700);
  };

  /** 语义找不到时用视觉兜底；返回是否点击成功。 */
  const tapByVisual = async (hint: string): Promise<boolean> => {
    if (!options.visualLocate) return false;
    physical ??= await options.physicalSize();
    const logical = await options.logicalSize();
    const hit = await options.visualLocate(hint);
    if (!hit) return false;
    // 视觉坐标按逻辑坐标系给出（model.locate 的约定），直接传给 tapPoint。
    console.log(`[meituan] visual ${hint} -> ${Math.round(hit.x)},${Math.round(hit.y)}`);
    await options.tapPoint(hit.x, hit.y);
    await sleep(1700);
    return true;
  };

  return {
    read,
    find,
    findAll,
    tap,
    waitStable,
    back: options.back,
    tapByVisual,
  };
}
