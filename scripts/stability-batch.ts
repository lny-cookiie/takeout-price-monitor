// 稳定性批次：连续 N 轮跑三平台串行，统计每平台成功率与耗时，输出 JSON 汇总。
// 用法：node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs scripts/stability-batch.ts [轮数]
import {spawn} from 'node:child_process';
import {mkdir, writeFile, appendFile} from 'node:fs/promises';

const rounds = Number(process.argv[2] ?? 10);
const TS = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 6);
const OUT = `.runtime/batch-${TS}`;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ADB = 'D:/vibecoding/03-TakeoutUE-外卖竞争监测/app/.runtime/adb-official-probe/platform-tools/adb.exe';

function runOnce(): Promise<{code: number; seconds: number; out: string}> {
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'node_modules/tsx/dist/cli.mjs', 'scripts/multi-platform.ts'], {
      cwd: process.cwd(), env: {...process.env, MIDSCENE_ADB_PATH: ADB}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', d => (buf += d.toString()));
    child.stderr.on('data', d => (buf += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 900_000);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({code: code ?? -1, seconds: Math.round((Date.now() - start) / 1000), out: buf});
    });
  });
}

await mkdir(OUT, {recursive: true});
const results: Array<{round: number; code: number; seconds: number; platforms: Record<string, {code: number; seconds: number}>}> = [];
for (let round = 1; round <= rounds; round++) {
  log(`=== 第 ${round}/${rounds} 轮 ===`);
  const r = await runOnce();
  const platforms: Record<string, {code: number; seconds: number}> = {};
  // 从 multi-platform 的输出里解析每平台 {name, code, seconds}
  for (const m of r.out.matchAll(/\{\s*"name":\s*"(\w+)",\s*"code":\s*(-?\d+),\s*"seconds":\s*(\d+)/g)) {
    platforms[m[1]!] = {code: Number(m[2]), seconds: Number(m[3])};
  }
  const row = {round, code: r.code, seconds: r.seconds, platforms};
  results.push(row);
  await appendFile(`${OUT}/rows.jsonl`, JSON.stringify(row) + '\n');
  log(`round ${round}`, JSON.stringify({code: r.code, seconds: r.seconds, platforms}));
}

// 汇总
const summary: Record<string, {runs: number; ok: number | null; rate: string; avgSeconds: number}> = {};
for (const name of ['meituan', 'taobao', 'jd']) {
  const hits = results.filter(r => r.platforms[name]).map(r => r.platforms[name]!);
  // 退出码不代表报价正确；在接入业务结果与人工复核前不报告成功率。
  const ok = null;
  summary[name] = {runs: hits.length, ok, rate: 'unverified',
    avgSeconds: hits.length ? Math.round(hits.reduce((s, h) => s + h.seconds, 0) / hits.length) : 0};
}
const totalAvg = Math.round(results.reduce((s, r) => s + r.seconds, 0) / results.length);
await writeFile(`${OUT}/summary.json`, JSON.stringify({rounds, totalAvg, summary, results}, null, 2));
log('批次完成', JSON.stringify({totalAvg, summary}));
console.log(JSON.stringify({out: OUT, totalAvg, summary}, null, 2));
