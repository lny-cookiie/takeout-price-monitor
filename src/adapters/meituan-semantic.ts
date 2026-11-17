// 美团采集的语义定位基础模块：
// 1) 直接解析 u2 JSON-RPC 的原始 XML（保留 text/content-desc，绕过 Midscene 树丢失文本的问题）；
// 2) 点击坐标一律由节点 bounds 按屏幕比例换算（跨机型，无绝对坐标常量）；
// 3) 语义匹配失败时，把"视觉兜底"收敛到一个 hook，由调用方注入（项目统一的 model.locate）。
// 4) 点错后的恢复方式是返回上一页重试，禁止重启 App。

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {popupCloseControl} from './popup-safety.js';

const run = promisify(execFile);

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
  tap(node: U2Node, label: string, xRatio?: number): Promise<void>;
  waitStable(rounds?: number): Promise<U2Node[]>;
  back(): Promise<void>;
  tapByVisual(hint: string): Promise<boolean>;
}

export const nodeLabel = (n: U2Node) => `${n.text} ${n.desc}`.trim();

export interface U2SemanticOptions {
  serial: string;
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
    // bounds 缺失不该整条丢弃：保留文本节点（坐标置 0），由上层按文本匹配而不是坐标匹配。
    const bm = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
    const [l, t, r, b] = bm ? [Number(bm[1]), Number(bm[2]), Number(bm[3]), Number(bm[4])] : [0, 0, 0, 0];
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
  let u2Reader: any = null;

  const read = async (): Promise<U2Node[]> => {
    // 主通道：AndroidUiTreeReader 完整解析（实测 245 节点、带 bounds/层级，是视觉兜底的最优替代）。
    try {
      if (!u2Reader) {
        const {AndroidUiTreeReader} = await import('./android-uitree.js');
        u2Reader = await AndroidUiTreeReader.create({
          serial: options.serial,
          adbPath: process.env.MIDSCENE_ADB_PATH ?? 'adb',
        });
      }
      const tree = await u2Reader.read() as any;
      // UiNode.bounds 是 {left,top,width,height} 且已按 devicePixelRatio 归一为逻辑坐标；
      // tap() 的公式按物理坐标换算，所以这里乘回像素比，保持全链路坐标系一致。
      const out: U2Node[] = [];
      const walk = (n: any) => {
        if (!n) return;
        const b = n.bounds;
        if (b && (b.width > 0 || b.height > 0)) {
          out.push({text: String(n.attrs?.text ?? ''), desc: String(n.attrs?.['content-desc'] ?? ''),
            cls: String(n.type ?? n.attrs?.class ?? ''), rid: String(n.attrs?.['resource-id'] ?? ''),
            left: b.left, top: b.top, width: b.width, height: b.height});
        }
        for (const c of (n.children ?? [])) walk(c);
      };
      walk(tree?.root);
      const rich = out.filter(n => nodeLabel(n)).length;
      // 完整性判据：原生页正常应有 40+ 文本节点，<15 说明这次读是残缺的（常见于 u2 刚退化）。
      // 残缺时重启 u2 重读一次，避免语义定位“时好时坏”。
      if (rich >= 15) return out;
      console.log(`[screen] 节点不完整 rich=${rich}，重启 u2 重读`);
      await run(process.env.MIDSCENE_ADB_PATH ?? 'adb', ['-s', options.serial,
        'shell', 'pkill', '-f', 'com.wetest.uia2'], {timeout: 6_000, encoding: 'utf8'}).catch(() => null);
      await new Promise(r => setTimeout(r, 900));
      u2Reader = null; // 关键：必须丢弃旧 reader，否则重读还是空树
      const {AndroidUiTreeReader} = await import('./android-uitree.js');
      u2Reader = await AndroidUiTreeReader.create({
        serial: options.serial,
        adbPath: process.env.MIDSCENE_ADB_PATH ?? 'adb',
      });
      const tree2 = await u2Reader.read() as any;
      const out2: U2Node[] = [];
      const walk2 = (n: any) => {
        if (!n) return;
        const b = n.bounds;
        if (b && (b.width > 0 || b.height > 0)) {
          out2.push({text: String(n.attrs?.text ?? ''), desc: String(n.attrs?.['content-desc'] ?? ''),
            cls: String(n.type ?? n.attrs?.class ?? ''), rid: String(n.attrs?.['resource-id'] ?? ''),
            left: b.left, top: b.top, width: b.width, height: b.height});
        }
        for (const c of (n.children ?? [])) walk2(c);
      };
      walk2(tree2?.root);
      if (out2.filter(n => nodeLabel(n)).length >= 15) return out2;
      return out;
    } catch { /* 落回原通道 */ }
    const resp = await fetch(`http://127.0.0.1:${port}/jsonrpc/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'dumpWindowHierarchy', params: [true, 200, true] }),
      signal: AbortSignal.timeout(options.readTimeoutMs ?? 15_000),
    });
    const data = (await resp.json()) as { result?: string };
    const raw=parseU2Xml(data.result ?? '');
    const logical=await options.logicalSize(), physicalSize=await options.physicalSize();
    if (!(logical.width>0 && logical.height>0 && physicalSize.width>0 && physicalSize.height>0)) throw new Error('screen_geometry_unknown');
    return raw.map(node=>({...node,left:node.left*logical.width/physicalSize.width,top:node.top*logical.height/physicalSize.height,
      width:node.width*logical.width/physicalSize.width,height:node.height*logical.height/physicalSize.height}));
  };

  const waitStable = async (rounds = 4): Promise<U2Node[]> => {
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

  const tap = async (node: U2Node, label: string, xRatio = 0.5): Promise<void> => {
    // read() 主通道 AndroidUiTreeReader 的 bounds 已是逻辑坐标（dp），直接点，不再做物理→逻辑换算。
    // 之前多除了一次像素比，导致点击坐标缩小 3.375 倍、全部点偏。
    const x = node.left + node.width * xRatio;
    const y = node.top + node.height / 2;
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
