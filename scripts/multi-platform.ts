// 三平台串行采集调度（node 版，替代不稳定的 bash 脚本）：
// 美团 → 淘宝闪购 → 京东（京东需要先起服务）。每平台独立超时，结果写 JSONL 汇总。
import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {openSync, closeSync, statSync} from 'node:fs';

const TS = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 6);
const OUT = `.runtime/mp-${TS}`;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ADB = 'D:/vibecoding/takeout_price_competition/.runtime/adb-official-probe/platform-tools/adb.exe';

/** 依次执行一个命令，超时强杀，返回 exit code 与耗时；stdout/stderr 落盘便于事后核对业务结果。 */
function runStep(name: string, cmd: string, args: string[], timeoutMs: number, logPath: string): Promise<{name: string; code: number; seconds: number; stalled: boolean}> {
  return new Promise(resolve => {
    const start = Date.now();
    const fd = openSync(logPath, 'w');
    const child = spawn(cmd, args, {cwd: process.cwd(), env: {...process.env, MIDSCENE_ADB_PATH: ADB}, stdio: ['ignore', fd, fd]});
    let killed = false;
    // 看门狗：日志超过 12 秒没有新内容 = 页面卡住了，立即打印诊断并强杀，不无限空等。
    let stalled = false;
    let lastSize = 0;
    const watchdog = setInterval(() => {
      try {
        const stat = statSync(logPath);
        if (stat.size === lastSize) {
          stalled = true;
          killed = true;
          log(`⚠ ${name} 已 ${Math.round((Date.now() - start) / 1000)} 秒无进展（日志 ${stat.size} 字节未变化），判定卡死并终止`);
          child.kill('SIGKILL');
        } else {
          lastSize = stat.size;
        }
      } catch {}
    }, 12_000);
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      clearInterval(watchdog);
      closeSync(fd);
      const seconds = Math.round((Date.now() - start) / 1000);
      log(`${name} exit=${code}${killed ? '(超时/卡死强杀)' : ''} ${seconds}s -> ${logPath}`);
      resolve({name, code: killed ? 124 : (code ?? -1), seconds, stalled});
    });
  });
}

/** 用 adb 把 App 拉到指定入口（e.g. 美团首页 / 淘宝 Launcher）。 */
function adbShell(args: string[]): Promise<void> {
  return new Promise(resolve => {
    const child = spawn(ADB, ['-s', '2NP0224627007133', ...args], {stdio: 'ignore'});
    child.on('close', () => resolve());
  });
}

/** 读取 adb 输出文本。 */
function adbText(args: string[]): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(ADB, ['-s', '2NP0224627007133', ...args]);
    let out = '';
    child.stdout.on('data', d => (out += d.toString()));
    child.on('close', () => resolve(out));
  });
}

/** 轮询确认目标 App 已在前台（比固定 sleep 稳，切换慢时自动等待）。 */
async function waitAppForeground(pkg: string, timeoutMs = 20_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const focus = await adbText(['shell', 'dumpsys window | grep mCurrentFocus']);
    if (focus.includes(pkg)) return true;
    await new Promise(r => setTimeout(r, 800));
  }
  return false;
}

async function waitService(url: string, timeoutMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(url).catch(() => null);
      if (res && res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

await mkdir(OUT, {recursive: true});
const results: Array<{name: string; code: number; seconds: number; business?: string}> = [];

// 1 美团
await adbShell(['shell', 'am', 'start', '-n', 'com.sankuai.meituan/com.meituan.android.pt.homepage.activity.MainActivity']);
const meituanReady = await waitAppForeground('com.sankuai.meituan');
log('美团前台就绪', meituanReady);
const meituanResult = await runStep('meituan', process.execPath, ['--env-file-if-exists=.env', 'node_modules/tsx/dist/cli.mjs', '.runtime/meituan-v10.ts'], 180_000, `${OUT}/meituan.log`);
results.push(meituanResult);
if (meituanResult.code !== 0) { log('美团失败，停止串行（不继续下一个平台）'); await writeFile(`${OUT}/summary.jsonl`, results.map(r=>JSON.stringify(r)).join('\n')+'\n'); process.exit(1); }

// 2 淘宝闪购
await adbShell(['shell', 'monkey', '-p', 'com.taobao.taobao', '-c', 'android.intent.category.LAUNCHER', '1']);
const taobaoReady = await waitAppForeground('com.taobao.taobao');
log('淘宝前台就绪', taobaoReady);
results.push(await runStep('taobao', process.execPath, ['--env-file-if-exists=.env', 'node_modules/tsx/dist/cli.mjs', '.runtime/taobao-flow.ts'], 180_000, `${OUT}/taobao.log`));

// 3 京东：起服务 → 采集 → 停服务
const service = spawn(process.execPath, ['--env-file-if-exists=.env', 'node_modules/tsx/dist/cli.mjs', 'src/main.ts'],
  {cwd: process.cwd(), env: {...process.env, MIDSCENE_ADB_PATH: ADB}, stdio: 'ignore'});
const ready = await waitService('http://127.0.0.1:4318/api/workspace');
if (ready) {
  results.push(await runStep('jd', process.execPath, ['--env-file-if-exists=.env', 'node_modules/tsx/dist/cli.mjs', 'scripts/live-single-pilot.ts', '--from-home', '--allow-coupon-checkout'], 240_000, `${OUT}/jd.log`));
} else {
  log('京东服务未就绪');
  results.push({name: 'jd', code: -1, seconds: 0});
}
service.kill('SIGKILL');

// 汇总
const lines = results.map(r => JSON.stringify(r)).join('\n') + '\n';
await writeFile(`${OUT}/summary.jsonl`, lines);
log('汇总', lines.trim().replace(/\n/g, ' | '));
console.log(JSON.stringify({out: OUT, results}, null, 2));
