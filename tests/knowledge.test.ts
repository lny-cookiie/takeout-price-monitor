import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'takeout-knowledge-'));
  const attempts = join(dir, 'attempts.jsonl');
  const registry = join(dir, 'registry.json');
  await writeFile(registry, JSON.stringify({
    version: 1,
    entries: [
      { id: 'F-X', title: '已修复的问题', platforms: ['meituan'], error_codes: ['known_error'], step: 'checkout', status: 'verified', verified_at: '2026-11-18', first_seen: '2026-11-17', verified_runs: ['run-1'], fix_commit: 'abc', code_files: [], symptom: '', root_cause: '', fix: '', note: '' },
      { id: 'F-Y', title: '待验证的问题', platforms: ['*'], error_codes: ['pending_error'], step: 'cart', status: 'pending', verified_at: null, first_seen: '2026-11-19', verified_runs: [], fix_commit: null, code_files: [], symptom: '', root_cause: '', fix: '', note: '' },
    ],
  }), 'utf8');
  const now = new Date().toISOString();
  const rows = [
    { at: now, platform: 'meituan', status: 'failed', error_code: 'known_error', cleanup: 'untouched', run_id: 'run-new' },
    { at: now, platform: 'meituan', status: 'failed', error_code: 'unknown_error', cleanup: 'untouched', run_id: 'run-unk' },
    { at: now, platform: 'taobao_instant', status: 'failed', error_code: 'pending_error', cleanup: 'restored', run_id: 'run-pending' },
  ];
  await writeFile(attempts, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  process.env.TAKEOUT_KNOWLEDGE_ATTEMPTS = attempts;
  process.env.TAKEOUT_KNOWLEDGE_REGISTRY = registry;
  return import('../scripts/knowledge-lib.js');
}

test('失败摘要能统计签名、未登记项和回退风险', async () => {
  const lib = await setup();
  const digest = lib.buildDigest(7);
  assert.equal(digest.window_records, 3);
  assert.ok(digest.by_signature.some((s: { signature: string }) => s.signature === 'meituan:known_error'));
  assert.ok(digest.unregistered.some((u: { signature: string }) => u.signature === 'meituan:unknown_error'));
  // 已验证条目在验证日期之后再次出现，应报回退。
  assert.ok(digest.regressions.some((r: { id: string }) => r.id === 'F-X'));
  assert.ok(digest.memory_lines.length > 0);
});

test('错误码能匹配到登记条目', async () => {
  const lib = await setup();
  const registry = lib.loadRegistry();
  const hit = lib.matchFix(registry, 'meituan', 'known_error');
  assert.equal(hit?.id, 'F-X');
  assert.equal(lib.matchFix(registry, 'jd', 'known_error'), null);
});
