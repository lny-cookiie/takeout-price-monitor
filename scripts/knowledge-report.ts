// 失败知识库报表：汇总自动采集的失败记录，并检查哪些错误码已经有整理后的经验条目。
// 用法：npx tsx scripts/knowledge-report.ts [--platform=taobao_instant] [--last=20]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k!, v ?? 'true'];
}));
const platform = args.platform;
const lastN = Number(args.last ?? 20);
const file = join('.runtime', 'knowledge', 'attempts.jsonl');
const kbFile = '前期调研/41_失败与修复知识库.md';

type Record_ = { at: string; platform: string; status: string; error_code: string | null; cleanup: string; steps?: { phase: string; note: string }[] };
const rows: Record_[] = existsSync(file)
  ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Record_]; } catch { return []; } })
  : [];
const filtered = (platform ? rows.filter((r) => r.platform === platform) : rows).slice(-lastN);

const byError = new Map<string, number>();
for (const row of rows) {
  if (platform && row.platform !== platform) continue;
  const key = `${row.platform}:${row.error_code ?? row.status}`;
  byError.set(key, (byError.get(key) ?? 0) + 1);
}
console.log('自动采集的失败记录总数', rows.length, '条，本次筛选', filtered.length, '条');
console.log('\n按错误码汇总（全部历史）：');
for (const [key, count] of [...byError.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${count} 次  ${key}`);

console.log(`\n最近 ${filtered.length} 条失败：`);
for (const row of filtered) {
  const steps = (row.steps ?? []).slice(-3).map((s) => `${s.phase}:${s.note}`).join(' | ');
  console.log(`  ${row.at}  ${row.platform}  ${row.status}  ${row.error_code ?? '无错误码'}  清理=${row.cleanup}  ${steps}`);
}

const kb = existsSync(kbFile) ? readFileSync(kbFile, 'utf8') : '';
const covered = new Set((kb.match(/错误码[：:]\s*([^\n]+)/g) ?? []).flatMap((line) => line.replace(/^错误码[：:]\s*/, '').split(/[、,，\s]+/)).filter(Boolean));
const uncovered = [...new Set(rows.map((r) => r.error_code).filter((code): code is string => Boolean(code)))].filter((code) => !covered.has(code));
console.log('\n知识库覆盖检查：');
console.log('  已整理条目覆盖的错误码数量', covered.size, '；知识库文件', existsSync(kbFile) ? '存在' : '缺失');
if (uncovered.length) console.log('  尚未整理成经验条目的错误码：', uncovered.join(', '));
else console.log('  所有出现过的错误码都已有经验条目');
