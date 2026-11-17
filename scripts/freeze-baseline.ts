// 冻结验收基线：固定代码、构建产物、运行配置、模型与设备状态，并把数据库做一致性副本。
// 用法：npx tsx scripts/freeze-baseline.ts --label=A [--dir=artifacts/baseline-A-<时间>]
// 只读冻结，不修改源码；写入清单和数据库副本，便于以后证明“哪一版跑的验收”。
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const run = promisify(execFile);
const base = 'http://127.0.0.1:4318';
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true']; }));
const label = String(args.label ?? 'A').replace(/[^A-Za-z0-9_-]/g, '');
if (!label) throw new Error('需要 --label=A');
const dir = resolve(String(args.dir ?? `artifacts/baseline-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
await mkdir(dir, {recursive: true});
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const trySha = (path: string) => sha(path).catch(() => null);
const git = async (...cmd: string[]) => (await run('git', cmd, {encoding: 'utf8'}).catch(() => ({stdout: ''}))).stdout.trim();

const status = await git('status', '--porcelain');
const head = await git('rev-parse', 'HEAD');
const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
const commitSubject = await git('log', '-1', '--format=%s');
const workspace = await fetch(base + '/api/workspace').then(r => r.json()).catch(() => null) as
  {version?: string; model?: unknown; platforms?: {id: string; status: string; appVersion?: string; problem?: string | null}[]} | null;
const devices = await fetch(base + '/api/devices').then(r => r.json()).catch(() => null);
const sourceFiles = ['src/adapters/android-collector.ts', 'src/adapters/visual-checkout.ts', 'src/adapters/checkout-reading.ts', 'src/adapters/jd-shelf-collector.ts',
  'src/adapters/meituan-collect.ts', 'src/adapters/taobao-collect.ts', 'src/adapters/taobao-collector.ts', 'src/http/competition-api.ts', 'src/infra/sqlite-store.ts'];
const sourceHashes: Record<string, string | null> = {};
for (const file of sourceFiles) sourceHashes[file] = await trySha(file);
const distFiles: Record<string, string | null> = {};
for (const file of ['dist/main.js', 'dist/adapters/android-collector.js', 'dist/adapters/visual-checkout.js', 'dist/adapters/meituan-collect.js', 'dist/adapters/taobao-collect.js']) distFiles[file] = await trySha(file);
const configHashes = {androidSources: await trySha('.runtime/android-sources.json')};

// 数据库一致性副本（VACUUM INTO，不移动原库）。
const dbPath = '.runtime/observatory.sqlite';
const dbCopy = join(dir, 'observatory.sqlite');
const db = new DatabaseSync(dbPath);
const integrity = db.prepare('PRAGMA integrity_check').get() as {integrity_check?: string};
db.exec(`VACUUM INTO '${dbCopy.replace(/\\/g, '/')}'`);
db.close();
const copy = new DatabaseSync(dbCopy);
const copyIntegrity = copy.prepare('PRAGMA integrity_check').get() as {integrity_check?: string};
const counts = {runs: (copy.prepare('SELECT count(*) n FROM runs').get() as {n: number}).n, slots: (copy.prepare('SELECT count(*) n FROM slots').get() as {n: number}).n,
  observations: (copy.prepare('SELECT count(*) n FROM observations').get() as {n: number}).n, quoteSnapshots: (copy.prepare('SELECT count(*) n FROM quote_snapshots').get() as {n: number}).n};
copy.close();

const manifest = {
  label, frozenAt: new Date().toISOString(), branch, head, commitSubject, worktreeClean: status.length === 0, dirtyEntries: status ? status.split('\n').length : 0,
  appVersion: workspace?.version ?? null, model: workspace?.model ?? null, platforms: workspace?.platforms ?? null, devices: devices ? {connected: (devices as {connected?: number}).connected, platforms: (devices as {platforms?: unknown}).platforms} : null,
  sourceHashes, distHashes: distFiles, configHashes,
  database: {path: dbPath, integrity: integrity.integrity_check, copyIntegrity: copyIntegrity.integrity_check, counts},
  note: '冻结只读快照；基线版本不包含未验证的优化改动。真机页面规则、App 版本、模型服务和设备状态以本次记录为准。',
};
await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
await writeFile(join(dir, 'README.md'), [
  `# 验收基线 ${label}`, '', `冻结时间：${manifest.frozenAt}`, `应用版本：${manifest.appVersion}；代码提交：${head}（${commitSubject}）`,
  `工作区是否干净：${manifest.worktreeClean ? '是' : '否（有 ' + manifest.dirtyEntries + ' 项未提交，基线不可用于正式验收）'}`,
  `模型：${JSON.stringify(manifest.model)}`, `设备：${JSON.stringify(manifest.devices)}`,
  `数据库：完整性 ${manifest.database.integrity}，副本完整性 ${manifest.database.copyIntegrity}，运行 ${counts.runs} 次 / 槽位 ${counts.slots} 个 / 旧观察 ${counts.observations} 条 / 报价快照 ${counts.quoteSnapshots} 条`,
  '', '本目录是冻结记录，不要修改；正式验收引用本清单和数据库副本。',
].join('\n'), 'utf8');
console.log('基线已冻结', dir);
console.log(JSON.stringify({worktreeClean: manifest.worktreeClean, head, appVersion: manifest.appVersion, counts}, null, 2));
if (!manifest.worktreeClean) process.exitCode = 2;
