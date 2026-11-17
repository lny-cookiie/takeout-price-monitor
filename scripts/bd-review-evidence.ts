// 逐份复核辅助：把有效报价的结算证据下载下来，用 Windows 内置 OCR 独立读一遍页面文字，
// 与模型读取的金额并排列出，供人工逐份对照。只读，不修改任何历史记录。
// 用法：npx tsx scripts/bd-review-evidence.ts --run=<runId> [--out=.runtime/review/<name>.md]
//      npx tsx scripts/bd-review-evidence.ts --batch=.runtime/acceptance/<批次目录> [--out=...]
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join, resolve} from 'node:path';

const run = promisify(execFile);
const base = 'http://127.0.0.1:4318';
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true']; }));
const outRoot = resolve('.runtime/review');
await mkdir(outRoot, {recursive: true});

type Slot = {
  platform: string; state: string; status: string | null; error?: string | null; cleanup?: string | null;
  item?: string | null; spec?: string | null; context?: {store?: string};
  observation?: {amount_fen: number; raw_value: string; observed_at: string; quote_valid: boolean;
    details?: {missing?: Record<string, string>; storeEvidence?: {id: string}; itemEvidence?: {id: string}};
    evidence_refs?: {id: string; screenshot: string; text_file: string; sha256?: string}[]} | null;
};
type Details = {run: {id: string; created_at: string; label: string}; slots: Slot[]};

async function ocr(imagePath: string): Promise<{ok: boolean; lines: string[]}> {
  try {
    const {stdout} = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '.runtime/ocr.ps1', imagePath], {timeout: 90_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
    const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => !/^engine_lang=|^lines=/.test(l));
    return {ok: true, lines};
  } catch (error) {
    return {ok: false, lines: [(error as Error).message]};
  }
}
const relevant = (line: string) => /应付|共减|优惠|商品金额|商品小计|打包|包装|配送|运费|合计/.test(line.replace(/\s+/g, ''));
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function reviewRun(runId: string): Promise<{lines: string[]; count: number}> {
  const details = await fetch(base + '/api/market/runs/' + encodeURIComponent(runId)).then(r => r.json()) as Details;
  const lines: string[] = [];
  let count = 0;
  for (const slot of details.slots) {
    const ref = slot.observation?.evidence_refs?.[0];
    if (!slot.observation?.quote_valid || !ref) continue;
    count += 1;
    const image = Buffer.from(await (await fetch(base + ref.screenshot)).arrayBuffer());
    const imagePath = join(outRoot, `${runId}-${slot.platform}.png`);
    await writeFile(imagePath, image);
    const meta = await fetch(base + ref.text_file).then(r => r.ok ? r.json() : null) as {sha256?: string; captured_at?: string} | null;
    const hashOk = meta?.sha256 === sha256(image);
    const text = await ocr(imagePath);
    const rows = text.lines.filter(relevant).slice(0, 14);
    const storeEvidence = slot.observation.details?.storeEvidence?.id;
    const itemEvidence = slot.observation.details?.itemEvidence?.id;
    lines.push(`### ${slot.platform} · ¥${(slot.observation.amount_fen / 100).toFixed(2)}`, '');
    lines.push(`- 实际分店：${slot.context?.store ?? '未记录'}；商品：${slot.item ?? ''}${slot.spec ? ' · ' + slot.spec : ''}`);
    lines.push(`- 模型读取应付：${slot.observation.raw_value} 元（观察时间 ${slot.observation.observed_at}）`);
    lines.push(`- 证据文件：${ref.screenshot}（哈希核对 ${hashOk ? '通过' : '不通过'}；本地副本 ${imagePath}）`);
    if (storeEvidence) lines.push(`- 门店证据：/api/evidence/${storeEvidence}.png`);
    if (itemEvidence) lines.push(`- 商品证据：/api/evidence/${itemEvidence}.png`);
    lines.push(`- 明细缺失项：${Object.keys(slot.observation.details?.missing ?? {}).filter(k => !['verification', 'reconciliation'].includes(k)).join('、') || '无'}`);
    lines.push(`- Windows OCR 独立识读：${text.ok ? '见下方原始识别行；OCR 对小数点和小号数字可能误识别，只作交叉参考' : 'OCR 不可用'}`);
    if (rows.length) lines.push('', ...rows.slice(0, 10).map(row => `  - ${row.replace(/\s+/g, ' ')}`), '');
    lines.push('| 人工复核 | 待填：金额是否一致 / 店品是否一致 / 购物车是否一致 |', '');
  }
  return {lines, count};
}

const target = typeof args.run === 'string' ? args.run : null;
const batch = typeof args.batch === 'string' ? args.batch : null;
const multiple = typeof args.runs === 'string' ? args.runs.split(',').map(s => s.trim()).filter(Boolean) : [];
if (!target && !batch && !multiple.length) throw new Error('用法：--run=<runId> 或 --runs=<id1,id2> 或 --batch=<批次目录>');
const runIds: string[] = [...multiple];
let prefix = '';
if (target) runIds.push(target);
if (batch) {
  const dir = resolve(batch);
  prefix = dir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'batch';
  const text = await readFile(join(dir, 'rows.jsonl'), 'utf8').catch(() => '');
  for (const row of text.split('\n').filter(Boolean).map(line => JSON.parse(line) as {runId?: string | null})) if (row.runId) runIds.push(row.runId);
}
const report: string[] = [`# 报价证据逐份复核（${runIds.length} 个任务）`, '', `生成时间：${new Date().toISOString()}`, ''];
let total = 0;
for (const runId of runIds) {
  const {lines, count} = await reviewRun(runId);
  total += count;
  if (count) report.push(`## 任务 ${runId}`, '', ...lines);
}
report.push('', `## 汇总`, '', `- 复核任务 ${runIds.length} 个，有效报价 ${total} 条。`, '- OCR 只用于交叉参考，金额与店品最终以截图人工对照为准；OCR 对小数点和小号字体可能误识别。');
const out = typeof args.out === 'string' ? args.out : join(outRoot, 'review-' + (target ?? prefix) + '.md');
await writeFile(out, report.join('\n'), 'utf8');
console.log('复核清单已写入', out, '有效报价', total, '条');
