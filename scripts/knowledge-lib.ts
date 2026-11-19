// 自愈知识库的共享逻辑：读取失败记录、读取失败模式注册表、生成摘要、标记验证状态。
// 设计目标是把“记录原始错误 → 归纳共性问题 → 记录解决方案 → 验证迭代”四步变成可重复执行的命令，
// 而不是靠人回忆。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const ATTEMPTS_FILE = process.env.TAKEOUT_KNOWLEDGE_ATTEMPTS ?? '.runtime/knowledge/attempts.jsonl';
export const REGISTRY_FILE = process.env.TAKEOUT_KNOWLEDGE_REGISTRY ?? '前期调研/42_失败模式注册表.json';

export type FixEntry = {
  id: string;
  title: string;
  platforms: string[];
  error_codes: string[];
  step: string;
  symptom: string;
  root_cause: string;
  fix: string;
  code_files: string[];
  fix_commit: string | null;
  status: 'verified' | 'pending' | 'regressed';
  first_seen: string;
  verified_at: string | null;
  verified_runs: string[];
  note: string;
};

export type AttemptRecord = {
  at: string;
  platform: string;
  status: string;
  error_code: string | null;
  cleanup: string;
  run_id?: string;
  steps?: { phase: string; note: string }[];
};

export function loadRegistry(file = REGISTRY_FILE): { version: number; entries: FixEntry[] } {
  if (!existsSync(file)) return { version: 1, entries: [] };
  return JSON.parse(readFileSync(file, 'utf8')) as { version: number; entries: FixEntry[] };
}

export function saveRegistry(registry: { version: number; entries: FixEntry[] }, file = REGISTRY_FILE): void {
  registry.updated_at = new Date().toISOString();
  writeFileSync(file, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

export function loadAttempts(file = ATTEMPTS_FILE): AttemptRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as AttemptRecord]; } catch { return []; }
    });
}

/** 按 error_code 查是否有登记过的失败模式和修复方案；返回第一个命中的条目。 */
export function matchFix(registry: { entries: FixEntry[] }, platform: string, errorCode: string | null): FixEntry | null {
  if (!errorCode) return null;
  return registry.entries.find((e) => e.error_codes.includes(errorCode) && (e.platforms.includes('*') || e.platforms.includes(platform))) ?? null;
}

function dayKey(at: string): string { return String(at).slice(0, 10); }

export type Digest = {
  generated_at: string;
  window_days: number;
  total_records: number;
  window_records: number;
  by_signature: { signature: string; count: number; last_at: string }[];
  unregistered: { signature: string; count: number; example_run: string | null }[];
  regressions: { id: string; title: string; error_codes: string[]; count: number; last_at: string; example_run: string | null }[];
  pending_fixes: { id: string; title: string; status: string; occurrences: number; last_at: string | null }[];
  markdown: string;
  memory_lines: string[];
};

/** 生成失败摘要：按签名聚合、找出未登记的失败模式、已修复但再次出现的回退、待验证修复。 */
export function buildDigest(windowDays = 7): Digest {
  const registry = loadRegistry();
  const attempts = loadAttempts();
  const since = Date.now() - windowDays * 24 * 3600_000;
  const recent = attempts.filter((a) => Number.isFinite(Date.parse(a.at)) && Date.parse(a.at) >= since);

  const signatureOf = (a: AttemptRecord) => `${a.platform}:${a.error_code ?? a.status}`;
  const counts = new Map<string, { count: number; last_at: string }>();
  for (const a of recent) {
    const key = signatureOf(a);
    const cur = counts.get(key) ?? { count: 0, last_at: a.at };
    cur.count += 1;
    if (Date.parse(a.at) > Date.parse(cur.last_at)) cur.last_at = a.at;
    counts.set(key, cur);
  }
  const bySignature = [...counts.entries()]
    .map(([signature, v]) => ({ signature, count: v.count, last_at: v.last_at }))
    .sort((a, b) => b.count - a.count);

  const registeredCodes = new Set(registry.entries.flatMap((e) => e.error_codes));
  const unregistered = bySignature
    .filter((s) => {
      const code = s.signature.split(':').slice(1).join(':');
      return code && code !== 'partial' && code !== 'failed' && !registeredCodes.has(code);
    })
    .map((s) => {
      const code = s.signature.split(':').slice(1).join(':');
      const example = recent.find((a) => signatureOf(a) === s.signature);
      return { signature: s.signature, count: s.count, example_run: example?.run_id ?? null };
    });

  const regressions = registry.entries
    .filter((e) => e.status === 'verified')
    .flatMap((e) => {
      const hits = recent.filter((a) => e.error_codes.includes(a.error_code ?? '') && (e.platforms.includes('*') || e.platforms.includes(a.platform)));
      if (!hits.length) return [];
      const last = hits.map((a) => a.at).sort().at(-1)!;
      // 注册表里的验证日期可能只到天；按当天结束时间算，避免把同一天的修复前样本误判成回退。
      const verifiedAt = e.verified_at ? (e.verified_at.length <= 10 ? Date.parse(e.verified_at + 'T23:59:59Z') : Date.parse(e.verified_at)) : 0;
      // 只在“修复验证之后”再次出现才算回退；验证之前的记录属于修复前样本。
      const after = hits.filter((a) => Date.parse(a.at) > verifiedAt);
      if (!after.length) return [];
      return [{ id: e.id, title: e.title, error_codes: e.error_codes, count: after.length, last_at: last, example_run: after[0]?.run_id ?? null }];
    });

  const pendingFixes = registry.entries
    .filter((e) => e.status === 'pending')
    .map((e) => {
      const hits = attempts.filter((a) => e.error_codes.includes(a.error_code ?? ''));
      return { id: e.id, title: e.title, status: e.status, occurrences: hits.length, last_at: hits.map((a) => a.at).sort().at(-1) ?? null };
    })
    .filter((e) => e.occurrences > 0);

  const lines: string[] = [];
  lines.push(`# 失败摘要（${new Date().toISOString().slice(0, 10)}，最近 ${windowDays} 天）`, '');
  lines.push(`自动记录总数 ${attempts.length} 条，窗口内 ${recent.length} 条。`, '');
  lines.push('## 按失败签名统计', '', '| 签名 | 次数 | 最近一次 |', '| --- | --- | --- |');
  for (const s of bySignature.slice(0, 15)) lines.push(`| ${s.signature} | ${s.count} | ${s.last_at} |`);
  lines.push('');
  lines.push('## 已登记但再次出现的回退风险', '');
  if (regressions.length) for (const r of regressions) lines.push(`- ${r.id} ${r.title}：${r.count} 次，最近 ${r.last_at}，示例 ${r.example_run ?? '无'}`);
  else lines.push('- 无');
  lines.push('');
  lines.push('## 未登记的新失败签名（需要归纳成条目）', '');
  if (unregistered.length) for (const u of unregistered) lines.push(`- ${u.signature}：${u.count} 次，示例 ${u.example_run ?? '无'}`);
  else lines.push('- 无');
  lines.push('');
  lines.push('## 待验证的修复', '');
  if (pendingFixes.length) for (const p of pendingFixes) lines.push(`- ${p.id} ${p.title}：历史出现 ${p.occurrences} 次，最近 ${p.last_at ?? '无'}`);
  else lines.push('- 无');
  lines.push('');
  lines.push('## 下一步动作');
  lines.push('1. 未登记签名优先归纳成 F 系列条目，写入 前期调研/41_失败与修复知识库.md 和 42_失败模式注册表.json。');
  lines.push('2. 待验证修复用 `npx tsx scripts/knowledge-registry.ts verify <id> --run <运行编号>` 标注验证，不要停留在“已修”。');
  lines.push('3. 回退风险条目要重新打开，查清是修复不彻底还是平台改版。');

  const memoryLines = [
    `失败摘要（最近 ${windowDays} 天）：记录 ${recent.length} 条，未登记签名 ${unregistered.length} 个，回退风险 ${regressions.length} 个，待验证修复 ${pendingFixes.length} 个。`,
    bySignature.slice(0, 3).map((v) => `${v.signature}×${v.count}`).join('；') || '最近无高频失败。',
    unregistered.slice(0, 3).map((v) => v.signature).join('；') || '没有未登记的新签名。',
    regressions.slice(0, 3).map((v) => `${v.id}:${v.title}`).join('；') || '没有回退风险。',
  ];
  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    total_records: attempts.length,
    window_records: recent.length,
    by_signature: bySignature,
    unregistered,
    regressions,
    pending_fixes: pendingFixes,
    markdown: lines.join('\n') + '\n',
    memory_lines: memoryLines,
  };
}
