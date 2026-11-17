// 三平台比价验收批次：按 v2 口径逐组提交比较组、保留全部结果与证据、生成统计。
// 用法：npx tsx scripts/bd-acceptance.ts --label=A --groups=20 --input=scripts/bd-batch.example.json
// 说明：脚本只通过正式入口 /api/bd/runs 发起任务，不直接操作手机；失败与重试原样保留。
import {readFile, mkdir, appendFile, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const run = promisify(execFile);
const base = 'http://127.0.0.1:4318';
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.join('=') || 'true'];
}));
const label = args.label ?? 'A';
const groups = Number(args.groups ?? 20);
const inputPath = args.input ?? 'scripts/bd-batch.example.json';
const outRoot = resolve(args.dir ?? '.runtime/acceptance');
const platformId = (value: string): 'jd' | 'meituan' | 'taobao_instant' | null => {
  if (value === 'jd' || value === 'meituan') return value;
  if (value === 'taobao' || value === 'taobao_instant') return 'taobao_instant';
  return null;
};

type Plan = {city: string; brand: string; store?: string; item: string; platforms: string[]};
const parsed = JSON.parse(await readFile(inputPath, 'utf8')) as Plan | Plan[];
const raw = Array.isArray(parsed) ? parsed[0]! : parsed;
const platforms = (raw?.platforms ?? []).map(platformId);
if (!raw?.city || !raw.brand || !raw.item || !platforms.length || platforms.some(p => !p)) throw new Error('输入需要 city/brand/item/platforms（jd/meituan/taobao 或 taobao_instant）');
const plan = {city: raw.city, brand: raw.brand, store: raw.store, item: raw.item, platforms: platforms as ('jd' | 'meituan' | 'taobao_instant')[]};
if (groups < 1 || groups > 40) throw new Error('groups 需在 1-40 之间');

const dir = join(outRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`);
await mkdir(dir, {recursive: true});
const terminal = new Set(['completed', 'source_blocked', 'window_missed', 'interrupted', 'cancelled']);

async function hashFile(path: string) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); } catch { return null; }
}
async function versionStamp() {
  const gitHead = await run('git', ['rev-parse', 'HEAD']).then(r => r.stdout.trim()).catch(() => null);
  const dirty = await run('git', ['status', '--porcelain']).then(r => r.stdout.trim()).catch(() => '');
  const files = ['src/adapters/android-collector.ts', 'src/adapters/visual-checkout.ts', 'src/adapters/meituan-collect.ts', 'src/adapters/taobao-collect.ts', 'src/adapters/checkout-reading.ts'];
  const hashes: Record<string, string | null> = {};
  for (const file of files) hashes[file] = await hashFile(file);
  const workspace = await fetch(base + '/api/workspace').then(r => r.json()).catch(() => null) as {model?: unknown; platforms?: unknown} | null;
  return {label, at: new Date().toISOString(), gitHead, dirtyPatchHash: dirty ? createHash('sha256').update(dirty).digest('hex') : null, sourceHashes: hashes, model: workspace?.model ?? null, platforms: workspace?.platforms ?? null};
}
async function adb(...cmd: string[]) {
  const adbPath = process.env.MIDSCENE_ADB_PATH ?? 'D:/vibecoding/03-TakeoutUE-外卖竞争监测/app/.runtime/adb-official-probe/platform-tools/adb.exe';
  return run(adbPath, ['-s', process.env.MIDSCENE_ADB_SERIAL ?? '2NP0224627007133', ...cmd], {timeout: 20_000, encoding: 'utf8'}).then(r => r.stdout).catch(() => '');
}
async function submit(requestId: string): Promise<string> {
  const res = await fetch(base + '/api/bd/runs', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({city: plan.city, brand: plan.brand, store: plan.store ?? '', item: plan.item, platforms: plan.platforms, requestId}),
  });
  const data = await res.json() as {platforms?: {runId?: string}[]; error?: string; message?: string};
  if (!res.ok || !data.platforms?.[0]?.runId) throw new Error(data.message ?? data.error ?? 'submit_failed');
  return data.platforms[0].runId;
}
type Slot = {
  id: string; platform: string; state: string; status: string | null; error: string | null; cleanup: string | null;
  item: string | null; spec: string | null; context?: {store?: string}; quoteMs?: number | null;
  observation: {amount_fen: number; quote_valid: boolean; observed_at: string; evidence_refs: {id: string; screenshot: string; text_file: string; sha256?: string}[]; details?: {missing?: Record<string, string>}} | null;
  attempts?: {number: number; state?: string}[]; timings?: Record<string, number>;
};
type RunDetails = {run: {id: string; created_at: string}; state: string; slots: Slot[]};
async function waitRun(runId: string): Promise<RunDetails> {
  const deadline = Date.now() + 40 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const data = await fetch(base + '/api/market/runs/' + encodeURIComponent(runId)).then(r => r.json()) as RunDetails;
    const line = data.slots.map(s => `${s.platform}:${s.state}`).join(' ');
    if (line !== last) { console.log('  ', ((Date.now() - submitAt) / 1000).toFixed(0) + 's', line); last = line; }
    if (data.slots.every(s => terminal.has(s.state))) return data;
    await delay(3_000);
  }
  throw new Error('run_timeout');
}
async function verifyEvidence(slot: Slot): Promise<boolean | null> {
  const ref = slot.observation?.evidence_refs?.[0];
  if (!ref) return null;
  try {
    const meta = await fetch(base + ref.text_file).then(r => r.ok ? r.json() : null) as {sha256?: string} | null;
    const image = Buffer.from(await (await fetch(base + ref.screenshot)).arrayBuffer());
    const actual = createHash('sha256').update(image).digest('hex');
    return !!meta?.sha256 && meta.sha256 === actual;
  } catch { return null; }
}

console.log('版本信息', JSON.stringify(await versionStamp()).slice(0, 400));
await writeFile(join(dir, 'version.json'), JSON.stringify(await versionStamp(), null, 2));
const rows: Record<string, unknown>[] = [];
let submitAt = Date.now();
for (let round = 1; round <= groups; round++) {
  const cold = round <= 4;
  if (cold) {
    for (const platform of plan.platforms) {
      const pkg = {jd: 'com.jingdong.app.mall', meituan: 'com.sankuai.meituan', taobao_instant: 'com.taobao.taobao'}[platform];
      await adb('shell', 'am', 'force-stop', pkg);
    }
    await delay(3_000);
  }
  submitAt = Date.now();
  let runId: string | null = null;
  try {
    runId = await submit(randomUUID());
    const details = await waitRun(runId);
    const elapsedMs = Date.now() - submitAt;
    const slotRows: Record<string, unknown>[] = [];
    for (const platform of plan.platforms) {
      const slot = details.slots.find(s => s.platform === platform);
      if (!slot) { slotRows.push({round, cold, platform, state: 'missing', quoteValid: false}); continue; }
      const evidenceOk = await verifyEvidence(slot);
      const obs = slot.observation;
      slotRows.push({
        round, cold, platform, slotId: slot.id, state: slot.state, status: slot.status, error: slot.error,
        cleanup: slot.cleanup, amountFen: obs?.amount_fen ?? null, quoteValid: !!obs?.quote_valid,
        observedAt: obs?.observed_at ?? null, store: slot.context?.store ?? null, item: slot.item, spec: slot.spec,
        evidenceId: obs?.evidence_refs?.[0]?.id ?? null, evidenceVerified: evidenceOk,
        missingKeys: Object.keys(obs?.details?.missing ?? {}), attempts: slot.attempts?.length ?? null,
        quoteMs: slot.quoteMs ?? null, timings: slot.timings ?? null,
      });
    }
    const valid = slotRows.filter(r => r.quoteValid);
    const clean = slotRows.every(r => ['untouched', 'restored'].includes(String(r.cleanup)));
    const times = valid.map(r => Date.parse(String(r.observedAt))).filter(Number.isFinite);
    const skewMinutes = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 60_000 : null;
    const evidenceAll = slotRows.every(r => r.evidenceVerified === true);
    const groupComplete = valid.length === plan.platforms.length && clean && evidenceAll && (skewMinutes == null || skewMinutes <= 5);
    rows.push({round, cold, runId, elapsedMs, groupComplete, skewMinutes, clean, evidenceAll, slots: slotRows});
    await appendFile(join(dir, 'rows.jsonl'), JSON.stringify(rows.at(-1)) + '\n');
    console.log(`第 ${round}/${groups} 组 ${groupComplete ? '完整成功' : '未达完整'}：${(elapsedMs / 1000).toFixed(0)}s，有效 ${valid.length}/${plan.platforms.length}`);
    const blocked = slotRows.some(r => ['quarantined', 'needs_attention'].includes(String(r.cleanup)) || /captcha|access_restricted|rate_limited|source_blocked/.test(String(r.error ?? '')));
    if (blocked) { console.log('检测到购物车隔离或访问限制，停止批次并保留现场'); break; }
  } catch (error) {
    rows.push({round, cold, runId, elapsedMs: Date.now() - submitAt, groupComplete: false, error: (error as Error).message, slots: []});
    await appendFile(join(dir, 'rows.jsonl'), JSON.stringify(rows.at(-1)) + '\n');
    console.log(`第 ${round} 组提交或等待失败：${(error as Error).message}`);
    break;
  }
  await delay(cold ? 3_000 : 5_000);
}
const complete = rows.filter(r => r.groupComplete);
const times = complete.map(r => Number(r.elapsedMs)).sort((a, b) => a - b);
const percentile = (p: number) => times.length ? times[Math.ceil(times.length * p) - 1] ! : null;
const slotRows = rows.flatMap(r => (r.slots as Record<string, unknown>[]) ?? []);
const summary = {
  label, at: new Date().toISOString(), planned: groups, finished: rows.length,
  group: {complete: complete.length, rate: rows.length ? complete.length / rows.length : 0, p50Ms: percentile(.5), p90Ms: percentile(.9)},
  platform: Object.fromEntries(plan.platforms.map(p => {
    const list = slotRows.filter(r => r.platform === p);
    return [p, {tasks: list.length, valid: list.filter(r => r.quoteValid).length, clean: list.filter(r => ['untouched', 'restored'].includes(String(r.cleanup))).length,
      evidenceVerified: list.filter(r => r.evidenceVerified === true).length, retried: list.filter(r => Number(r.attempts ?? 0) > 1).length}];
  })),
  failures: rows.filter(r => !r.groupComplete).map(r => ({round: r.round, error: r.error ?? null, runId: r.runId ?? null})),
  note: '耗时只统计完整成功组的实际完整耗时；失败组不参与分位数；正确性仍需逐份对照证据复核。',
};
await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('批次目录', dir);
console.log(JSON.stringify(summary, null, 2));
