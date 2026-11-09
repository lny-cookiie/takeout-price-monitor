import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 京东单店验收编排：前置检查 → 20 次连续批次 → 汇总报告 → 冻结基线 → 证据索引。
 *
 * 用于大促结束后的复测与每次适配器变更后的回归。默认只做前置检查（--dry-run），
 * 确认环境就绪后才加 --run 真正启动真机采集；任何一步失败都不覆盖已有结果。
 */

const run = promisify(execFile);
const NODE = process.execPath;
const ROOT = process.cwd();

export interface AcceptanceOptions {
  rounds: number;
  dryRun: boolean;
  evidenceIndex: boolean;
}

function parseArgs(argv: string[]): AcceptanceOptions {
  const roundsArg = argv.find(value => value.startsWith('--rounds='));
  const rounds = roundsArg ? Number(roundsArg.split('=')[1]) : 20;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('轮次应为 1-20');
  return { rounds, dryRun: !argv.includes('--run'), evidenceIndex: !argv.includes('--no-evidence') };
}

async function tsx(script: string, args: string[] = [], timeoutMs = 30 * 60_000): Promise<string> {
  const { stdout, stderr } = await run(NODE, ['--env-file-if-exists=.env', '--import', 'tsx', script, ...args], {
    cwd: ROOT, timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  }).catch(error => { throw new Error(`${script} 失败：${String((error as Error).message).slice(0, 400)}`); });
  if (stderr.trim()) process.stderr.write(stderr);
  return stdout;
}

function lastJsonLine(output: string): Record<string, unknown> | null {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { /* 继续找上一行 */ }
  }
  return null;
}

async function spawnCollector(args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, ['--env-file-if-exists=.env', '--import', 'tsx', 'scripts/live-pilot-cohort.ts', ...args], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); process.stdout.write(String(chunk)); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => {
      if (stderr.trim()) process.stderr.write(stderr);
      if (code !== 0) reject(new Error(`批次进程退出码 ${code}`));
      else resolvePromise(code ?? 0);
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary: Record<string, unknown> = { mode: options.dryRun ? 'dry_run' : 'run', rounds: options.rounds, startedAt: new Date().toISOString() };

  process.stdout.write(`[1/5] 前置检查\n`);
  const preflight = lastJsonLine(await tsx('scripts/pilot-preflight.ts'));
  summary.preflight = preflight;
  const ready = preflight?.connected === true && preflight?.unlocked === true && preflight?.modelReachable === true;
  if (!ready) {
    summary.ready = false;
    summary.reason = '前置条件未满足（设备连接/解锁/模型可达）';
    process.stdout.write(JSON.stringify(summary) + '\n');
    process.exitCode = 1;
    return;
  }
  summary.ready = true;

  if (options.dryRun) {
    process.stdout.write(JSON.stringify({ ...summary, note: 'dry-run 只做前置检查，未启动采集；确认后加 --run 执行' }) + '\n');
    return;
  }

  process.stdout.write(`[2/5] 运行 ${options.rounds} 次连续批次\n`);
  if (options.rounds !== 20) process.env.PILOT_COHORT_COUNT = String(options.rounds);
  const cohortOutput = await spawnCollector([]).then(() => null).catch(error => { throw error; });
  void cohortOutput;
  // 批次脚本退出后才落盘，按 artifacts 目录最新 cohort 文件定位本轮结果
  const { readdir, stat } = await import('node:fs/promises');
  const dir = resolve(ROOT, 'artifacts/specified-pilot');
  const files = (await readdir(dir)).filter(name => name.startsWith('cohort-') && name.endsWith('.json') && !name.includes('evidence'));
  const latest = await Promise.all(files.map(async name => ({ name, mtime: (await stat(resolve(dir, name))).mtimeMs })))
    .then(rows => rows.sort((a, b) => b.mtime - a.mtime)[0]);
  if (!latest) throw new Error('没有找到本轮批次文件');
  const cohortPath = resolve(dir, latest.name);
  const cohort = JSON.parse(await readFile(cohortPath, 'utf8')) as { plan: { state: string }[]; planned: number };
  summary.cohort = cohortPath;

  process.stdout.write(`[3/5] 生成汇总报告\n`);
  const reportOutput = await tsx('scripts/report-pilot-cohort.ts', [cohortPath], 10 * 60_000);
  const report = lastJsonLine(reportOutput);
  summary.report = report ?? null;

  process.stdout.write(`[4/5] 冻结验收基线\n`);
  const reportPath = String(report?.report ?? '').replace(/\.md$/, '.json');
  if (!reportPath) throw new Error('汇总报告路径缺失');
  const baselineOutput = await tsx('scripts/freeze-jd-baseline.ts', [reportPath], 10 * 60_000);
  summary.baseline = lastJsonLine(baselineOutput) ?? null;

  if (options.evidenceIndex) {
    process.stdout.write(`[5/5] 生成证据索引\n`);
    const indexOutput = await tsx('scripts/pilot-evidence-index.ts', [cohortPath], 10 * 60_000);
    summary.evidence = lastJsonLine(indexOutput) ?? null;
  }

  summary.finishedAt = new Date().toISOString();
  summary.verdict = {
    planned: cohort.planned,
    completed: cohort.plan.filter(item => item.state === 'completed').length,
    quality: (report as { quality?: unknown } | null)?.quality ?? null,
    performance: (report as { performance?: unknown } | null)?.performance ?? null,
  };
  process.stdout.write(JSON.stringify(summary, null, 1) + '\n');
}

main().catch(error => {
  process.stderr.write(`验收失败：${String((error as Error).message).slice(0, 600)}\n`);
  process.exitCode = 1;
});
