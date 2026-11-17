// 运行时基线：三平台共享资源（设备、u2 读屏服务、App 前台）的唯一 owner。
// 所有采集脚本启动前调用它，不各自管理 u2 —— 这是解决"同一 u2 问题在三个平台各暴露一次"的收敛点。
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {AndroidUiTreeReader} from '../src/adapters/android-uitree.js';

const run = promisify(execFile);
const ADB = process.env.MIDSCENE_ADB_PATH ?? 'D:/vibecoding/03-TakeoutUE-外卖竞争监测/app/.runtime/adb-official-probe/platform-tools/adb.exe';
const SERIAL = process.env.MIDSCENE_ADB_SERIAL ?? '2NP0224627007133';
const PORT = 9008;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const adb = async (args: string[]) => (await run(ADB, ['-s', SERIAL, ...args], {encoding: 'utf8', timeout: 20_000}).catch(() => ({stdout: ''}))).stdout;

/** L1: 设备连接 */
async function ensureDevice(): Promise<boolean> {
  const out = await adb(['devices']);
  return out.includes(`${SERIAL}\tdevice`);
}

/** L1: u2 服务 + 端口转发 + 可达性（唯一 owner） */
async function ensureU2(): Promise<boolean> {
  // 1) 先杀掉残留，保证干净起点（避免上一个平台的 u2 影响 dump）
  await adb(['shell', 'pkill', '-f', 'com.wetest.uia2']);
  await new Promise(r => setTimeout(r, 1_200));
  // 2) 启动 u2（AndroidUiTreeReader.create+read 会拉起 app_process）
  const reader = await AndroidUiTreeReader.create({serial: SERIAL, adbPath: ADB}).catch(() => null);
  if (!reader) return false;
  await reader.read().catch(() => null);
  await new Promise(r => setTimeout(r, 800));
  // 3) 端口转发
  await adb(['forward', `tcp:${PORT}`, `tcp:${PORT}`]);
  // 4) 用 node:http 显式 IPv4 验证（fetch 在这个环境会走 IPv6 导致 fetch failed）
  return await new Promise<boolean>(resolve => {
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'dumpWindowHierarchy', params: [true, 200, false]});
    const req = request({host: '127.0.0.1', port: PORT, path: '/jsonrpc/0', method: 'POST',
      headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close'}, timeout: 8_000},
      res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve(res.statusCode === 200 && d.includes('result'))); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body); req.end();
  });
}

/** L1: App 前台（包名 + 页面身份，不只看包名） */
async function ensureForeground(pkg: string, homeHints: string[]): Promise<{ok: boolean; page: string}> {
  await adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 1_000));
    const focus = await adb(['shell', 'dumpsys window | grep mCurrentFocus']);
    if (!focus.includes(pkg)) continue;
    // 页面身份：读一次树，确认含首页特征
    const reader = await AndroidUiTreeReader.create({serial: SERIAL, adbPath: ADB}).catch(() => null);
    const tree = await reader?.read().catch(() => null);
    if (tree) {
      const texts: string[] = [];
      const walk = (n: any) => { const t = String(n.attrs?.text ?? n.attrs?.['content-desc'] ?? '').trim(); if (t) texts.push(t); n.children?.forEach(walk); };
      walk(tree.root);
      const hit = homeHints.find(h => texts.some(t => t.includes(h)));
      if (hit) return {ok: true, page: `home(${hit})`};
    }
  }
  return {ok: false, page: 'unknown'};
}

const PLATFORMS = {
  meituan: {pkg: 'com.sankuai.meituan', hints: ['外卖', '搜索', '首页']},
  jd: {pkg: 'com.jingdong.app.mall', hints: ['首页', '搜索', '外卖']},
  taobao: {pkg: 'com.taobao.taobao', hints: ['搜索', '闪购', '首页']},
} as const;

const target = (process.argv[2] ?? 'all') as keyof typeof PLATFORMS | 'all';
const platforms = target === 'all' ? (Object.keys(PLATFORMS) as Array<keyof typeof PLATFORMS>) : [target];
const state: any = {checkedAt: new Date().toISOString(), device: false, u2: false, platforms: {}};

state.device = await ensureDevice();
log(`L1 设备连接: ${state.device ? 'ok' : 'FAILED'}`);
if (!state.device) { await writeFile('.runtime/runtime-state.json', JSON.stringify(state, null, 2)); process.exit(2); }

state.u2 = await ensureU2();
log(`L1 u2 通道: ${state.u2 ? 'ok' : 'FAILED'}`);
if (!state.u2) { await writeFile('.runtime/runtime-state.json', JSON.stringify(state, null, 2)); process.exit(3); }

for (const p of platforms) {
  const r = await ensureForeground(PLATFORMS[p].pkg, [...PLATFORMS[p].hints]);
  state.platforms[p] = r;
  log(`L2 ${p} 前台: ${r.ok ? r.page : 'FAILED'}`);
}

await writeFile('.runtime/runtime-state.json', JSON.stringify(state, null, 2));
const allOk = state.u2 && platforms.every(p => state.platforms[p]?.ok);
log(allOk ? '运行时基线全部就绪' : '运行时基线未完全就绪，详见 .runtime/runtime-state.json');
process.exit(allOk ? 0 : 4);
