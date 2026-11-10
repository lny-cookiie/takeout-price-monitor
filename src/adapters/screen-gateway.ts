// 读屏网关：根治“间歇失效”。
// 设计原则（产品视角）：
//   1) 正常路径零额外成本：u2 一次读 + 纯文本有效性校验（微秒级），不新增 adb 往返；
//   2) 无效才付代价：自动重启 u2（约 2s），只在这一刻花时间；
//   3) 逐级降级：u2 → 重启后 u2 → dump → 视觉页面识别，每级都有明确判据；
//   4) 失败必须显式：全级失败抛 screen_unavailable，不允许静默返回空数组。
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type { U2Node } from './meituan-semantic.js';
import { nodeLabel } from './meituan-semantic.js';

const run = promisify(execFile);
const ADB = () => process.env.MIDSCENE_ADB_PATH ?? 'adb';
const SERIAL = () => process.env.MIDSCENE_ADB_SERIAL ?? '2NP0224627007133';

/** 页面特征词：出现任意一个才认为“读到了页面”，否则视为只有状态栏的无效读。 */
const PAGE_HINTS = /外卖|团购|我的|搜索|评分|月售|起送|配送|门店|商家|购物车|去结算|加入购物车|商品|点菜|评价|附近|推荐|热门|历史/;

export type ReadSource = 'u2' | 'u2_restarted' | 'dump' | 'visual' | 'unavailable';

export interface GatewayReadResult {
  nodes: U2Node[];
  source: ReadSource;
  valid: boolean;
  costMs: number;
}

export interface ScreenGatewayOptions {
  /** 读取 u2 原始节点 */
  readU2: () => Promise<U2Node[]>;
  /** 读取 dump 节点 */
  readDump: () => Promise<U2Node[]>;
  /** 视觉页面识别（只判页面类型，不找元素）：返回节点数组由调用方提供 */
  readVisual?: () => Promise<U2Node[]>;
  /** 重启 u2 服务 */
  restartU2?: () => Promise<void>;
  log?: (msg: string) => void;
}

export interface ScreenGateway {
  read(): Promise<GatewayReadResult>;
}

/** 纯函数：判断一次读屏结果是否有效（有页面特征，不是纯状态栏）。 */
export function isPageRich(nodes: U2Node[]): boolean {
  if (!nodes.length) return false;
  return nodes.some(n => PAGE_HINTS.test(nodeLabel(n)));
}

export function createScreenGateway(opts: ScreenGatewayOptions): ScreenGateway {
  const { readU2, readDump, readVisual, restartU2, log = () => {} } = opts;

  const read = async (): Promise<GatewayReadResult> => {
    const t0 = Date.now();

    // L1: u2 直读（最快路径）
    try {
      const nodes = await readU2();
      if (isPageRich(nodes)) return {nodes, source: 'u2', valid: true, costMs: Date.now() - t0};
      log(`[screen] u2 无效（${nodes.length} 节点，无页面特征），尝试重启`);
    } catch (e) {
      log(`[screen] u2 异常：${String(e).slice(0, 60)}`);
    }

    // L2: 重启 u2 再读一次（吸收崩溃/退化）
    if (restartU2) {
      try {
        await restartU2();
        const nodes = await readU2();
        if (isPageRich(nodes)) return {nodes, source: 'u2_restarted', valid: true, costMs: Date.now() - t0};
        log(`[screen] 重启后 u2 仍无效（${nodes.length} 节点）`);
      } catch (e) {
        log(`[screen] 重启后 u2 异常：${String(e).slice(0, 60)}`);
      }
    }

    // L3: dump（原生页可读；MRNX 页会 0 字节）
    try {
      const nodes = await readDump();
      if (isPageRich(nodes)) return {nodes, source: 'dump', valid: true, costMs: Date.now() - t0};
      log(`[screen] dump 无效（${nodes.length} 节点）`);
    } catch (e) {
      log(`[screen] dump 异常：${String(e).slice(0, 60)}`);
    }

    // L4: 视觉页面识别（只判页面，不找元素）
    if (readVisual) {
      try {
        const nodes = await readVisual();
        if (nodes.length && isPageRich(nodes)) return {nodes, source: 'visual', valid: true, costMs: Date.now() - t0};
      } catch (e) {
        log(`[screen] 视觉识别异常：${String(e).slice(0, 60)}`);
      }
    }

    return {nodes: [], source: 'unavailable', valid: false, costMs: Date.now() - t0};
  };

  return {read};
}

/** 重启 u2：pkill + 通过 AndroidUiTreeReader 拉起 + 端口转发。 */
export async function restartU2Service(): Promise<void> {
  await run(ADB(), ['-s', SERIAL(), 'shell', 'pkill', '-f', 'com.wetest.uia2'], {timeout: 6_000, encoding: 'utf8'}).catch(() => null);
  await new Promise(r => setTimeout(r, 900));
  await run(ADB(), ['-s', SERIAL(), 'forward', 'tcp:9008', 'tcp:9008'], {timeout: 6_000, encoding: 'utf8'}).catch(() => null);
  const {AndroidUiTreeReader} = await import('./android-uitree.js');
  const reader = await AndroidUiTreeReader.create({serial: SERIAL(), adbPath: ADB()}).catch(() => null);
  await reader?.read().catch(() => null);
  await new Promise(r => setTimeout(r, 600));
}
