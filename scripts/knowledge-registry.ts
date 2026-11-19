// 失败模式注册表命令行：查看、检查回退、生成摘要、标注验证。
// 用法：
//   npx tsx scripts/knowledge-registry.ts list [--platform=meituan]
//   npx tsx scripts/knowledge-registry.ts check [--days=7] [--write=进度与实验记录/失败摘要.md] [--memory]
//   npx tsx scripts/knowledge-registry.ts verify F-19 --run 92d12059
import { writeFileSync } from 'node:fs';
import { buildDigest, loadRegistry, saveRegistry } from './knowledge-lib.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'check';
const flags = Object.fromEntries(
  args.slice(1).filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k!, v.join('=') || 'true'];
  }),
);

if (command === 'list') {
  const { entries } = loadRegistry();
  const platform = flags.platform;
  const rows = platform ? entries.filter((e) => e.platforms.includes('*') || e.platforms.includes(platform)) : entries;
  console.log(`失败模式登记 ${rows.length} 条`);
  for (const e of rows) {
    console.log(`  ${e.id} [${e.status}] ${e.title}  错误码=${e.error_codes.join(',') || '无'}  修复提交=${e.fix_commit ?? '无'}`);
  }
} else if (command === 'check') {
  const digest = buildDigest(Number(flags.days ?? 7));
  if (flags.memory) { console.log(digest.memory_lines.join('\n')); } else { console.log(digest.markdown); }
  if (flags.write) {
    writeFileSync(flags.write, digest.markdown, 'utf8');
    console.log(`摘要已写入 ${flags.write}`);
  }
  if (digest.regressions.length) {
    console.error(`发现 ${digest.regressions.length} 个已修复条目再次出现，请重新打开或确认平台是否改版。`);
    process.exitCode = 1;
  }
} else if (command === 'verify') {
  const id = args[1];
  const run = flags.run;
  if (!id || !run) throw new Error('用法：verify <条目编号> --run <运行编号>');
  const registry = loadRegistry();
  const entry = registry.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`找不到条目 ${id}`);
  entry.status = 'verified';
  entry.verified_at = new Date().toISOString().slice(0, 10);
  entry.verified_runs = [...new Set([...entry.verified_runs, run])];
  saveRegistry(registry);
  console.log(`已标注 ${id} 为 verified，验证运行 ${run}`);
} else {
  console.log('可用命令：list / check / verify');
}
