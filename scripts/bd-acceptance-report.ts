// 汇总 A/B 验收批次：按 v2 口径输出完整组率、平台有效率、恢复结果、P50/P90 与改善幅度，并生成逐份复核清单。
// 用法：npx tsx scripts/bd-acceptance-report.ts --a=.runtime/acceptance/<A目录> --b=.runtime/acceptance/<B目录> [--out=.runtime/acceptance/report.md]
import {readFile, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';

type SlotRow = {platform: string; state?: string; status?: string | null; error?: string | null; cleanup?: string | null; amountFen?: number | null;
  quoteValid?: boolean; observedAt?: string | null; store?: string | null; item?: string | null; spec?: string | null;
  evidenceId?: string | null; evidenceVerified?: boolean | null; missingKeys?: string[]; attempts?: number | null; quoteMs?: number | null};
type Row = {round: number; cold?: boolean; runId?: string | null; elapsedMs: number; groupComplete: boolean; skewMinutes?: number | null;
  clean?: boolean; evidenceAll?: boolean; slots: SlotRow[]; error?: string};
type Summary = {label: string; planned: number; finished: number; group: {complete: number; rate: number; p50Ms: number | null; p90Ms: number | null};
  platform: Record<string, {tasks: number; valid: number; clean: number; evidenceVerified: number; retried: number}>; failures: {round: number; error: string | null; runId: string | null}[]};
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true']; }));
const load = async (dir: string) => {
  const root = resolve(dir);
  const summary = JSON.parse(await readFile(resolve(root, 'summary.json'), 'utf8')) as Summary;
  const text = await readFile(resolve(root, 'rows.jsonl'), 'utf8').catch(() => '');
  const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
  return {dir: root, summary, rows};
};
const fmt = (ms: number | null | undefined) => ms == null ? '—' : (ms / 1000).toFixed(1) + ' 秒';
const pct = (a: number | null, b: number | null) => a == null || b == null || a === 0 ? null : (a - b) / a;
const showPct = (value: number | null) => value == null ? '无法计算' : (value * 100).toFixed(1) + '%';
const evidenceUrl = (id: string | null | undefined) => id ? `/api/evidence/${id}.png` : '—';
const reviewRows = (rows: Row[]) => rows.flatMap(row => (row.slots ?? []).filter(s => s.quoteValid).map(slot =>
  `| ${row.round} | ${slot.platform} | ${fmt(row.elapsedMs)} | ¥${((slot.amountFen ?? 0) / 100).toFixed(2)} | ${slot.store ?? '—'} | ${slot.item ?? ''}${slot.spec ? ' · ' + slot.spec : ''} | ${slot.observedAt ?? '—'} | ${slot.cleanup ?? '—'} | ${slot.evidenceVerified === true ? '通过' : slot.evidenceVerified === false ? '不通过' : '未核对'} | [截图](${evidenceUrl(slot.evidenceId)}) |`));
const slotStats = (rows: Row[], platform?: string) => {
  const slots = rows.flatMap(r => (r.slots ?? []).filter(s => !platform || s.platform === platform));
  return {total: slots.length, valid: slots.filter(s => s.quoteValid).length, clean: slots.filter(s => ['untouched', 'restored'].includes(String(s.cleanup))).length,
    evidence: slots.filter(s => s.evidenceVerified === true).length, retried: slots.filter(s => Number(s.attempts ?? 0) > 1).length,
    detailComplete: slots.filter(s => s.quoteValid && !(s.missingKeys ?? []).length).length};
};

const a = await load(args.a);
const b = await load(args.b);
const lines: string[] = [];
lines.push(`# 三平台比价验收报告：${a.summary.label} 对比 ${b.summary.label}`, '');
lines.push(`生成时间：${new Date().toISOString()}`, '');
lines.push('## 一、批次与冻结信息', '');
lines.push(`| 项 | ${a.summary.label} | ${b.summary.label} |`, '| --- | --- | --- |');
lines.push(`| 批次目录 | ${basename(a.dir)} | ${basename(b.dir)} |`);
lines.push(`| 计划组数 | ${a.summary.planned} | ${b.summary.planned} |`);
lines.push(`| 已执行组数 | ${a.summary.finished} | ${b.summary.finished} |`);
lines.push(`| 完整成功组 | ${a.summary.group.complete} | ${b.summary.group.complete} |`);
lines.push(`| 完整组率 | ${showPct(a.summary.group.rate)} | ${showPct(b.summary.group.rate)} |`);
lines.push(`| 完整组耗时 P50 | ${fmt(a.summary.group.p50Ms)} | ${fmt(b.summary.group.p50Ms)} |`);
lines.push(`| 完整组耗时 P90 | ${fmt(a.summary.group.p90Ms)} | ${fmt(b.summary.group.p90Ms)} |`, '');
lines.push('## 二、判定', '');
const p50 = pct(a.summary.group.p50Ms, b.summary.group.p50Ms), p90 = pct(a.summary.group.p90Ms, b.summary.group.p90Ms);
const stabilityOk = b.summary.planned === 20 ? b.summary.group.complete >= 19 : b.summary.group.complete >= Math.ceil(b.summary.planned * 0.95);
const speedOk = p50 != null && p90 != null && p50 >= 0.2 && p90 >= 0.2;
lines.push(`- 优化版稳定性：计划 ${b.summary.planned} 组，完整成功 ${b.summary.group.complete} 组，${stabilityOk ? '达标（按 ≥19/20 或 ≥95%）' : '未达标'}。`);
lines.push(`- 效率改善：P50 改善 ${showPct(p50)}，P90 改善 ${showPct(p90)}，${speedOk ? '达标（两项均 ≥20%）' : '未达标或样本不足'}。`);
lines.push('- 说明：完整组只统计“三家均有效、证据哈希核对通过、购物车未变更或已恢复、观察时差 ≤5 分钟”的组；失败组不参与分位数。', '');
lines.push('## 三、分平台统计', '');
lines.push('| 平台 | 有效报价 | 购物车未变更/已恢复 | 证据核对通过 | 重试过的任务 |', '| --- | --- | --- | --- | --- |');
for (const platform of Object.keys(b.summary.platform)) {
  const sa = slotStats(a.rows, platform), sb = slotStats(b.rows, platform);
  lines.push(`| ${platform} | ${sb.valid}/${sb.total}（基线 ${sa.valid}/${sa.total}） | ${sb.clean}/${sb.total} | ${sb.evidence}/${sb.total} | ${sb.retried} |`);
}
lines.push('');
lines.push('## 四、失败与未完成', '');
const failedRows = [...a.rows.filter(r => !r.groupComplete).map(r => ({batch: a.summary.label, row: r})), ...b.rows.filter(r => !r.groupComplete).map(r => ({batch: b.summary.label, row: r}))];
if (!failedRows.length) lines.push('两个批次没有失败组。');
for (const {batch, row} of failedRows.slice(0, 40)) {
  const reasons = (row.slots ?? []).filter(s => !s.quoteValid || !['untouched', 'restored'].includes(String(s.cleanup))).map(s => `${s.platform}:${s.error ?? s.status ?? s.state ?? '未完成'}${s.cleanup ? '（购物车 ' + s.cleanup + '）' : ''}`);
  lines.push(`- ${batch} 第 ${row.round} 组：${row.error ? row.error + '；' : ''}${reasons.join('；') || '未达到完整组口径'}${row.runId ? `（任务 ${row.runId}）` : ''}`);
}
lines.push('');
lines.push('## 五、逐份复核清单（全部有效报价）', '');
lines.push('| 组 | 平台 | 组耗时 | 金额 | 实际分店 | 商品 | 观察时间 | 购物车 | 证据核对 | 证据 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
lines.push(...reviewRows(b.rows));
lines.push('', `注：基线批次复核清单未在本文展开，可用同一脚本查看 ${basename(a.dir)} 的 rows.jsonl。证据链接只在生成报告的本机可打开。`, '');
const out = typeof args.out === 'string' ? args.out : null;
const text = lines.join('\n');
if (out) { await writeFile(out, text, 'utf8'); console.log('报告已写入', out); }
else console.log(text);
