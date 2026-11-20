// 门店布局签名表命令：查看布局、按平台/容器/节点可读性选择策略。
// 用法：npx tsx scripts/layout-registry.ts list
//       npx tsx scripts/layout-registry.ts match --platform=jd --activity=... --text=0
import { readFileSync } from 'node:fs';
import { matchLayout, type LayoutRegistry } from '../src/domain/layout.js';

const file = '前期调研/43_门店布局签名表.json';
const registry = JSON.parse(readFileSync(file, 'utf8')) as LayoutRegistry;
const args = process.argv.slice(2);
const command = args[0] ?? 'list';
const flags = Object.fromEntries(args.slice(1).filter((a) => a.startsWith('--')).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k!, v.join('=') || 'true'];
}));

if (command === 'list') {
  console.log(`布局签名 ${registry.entries.length} 条`);
  for (const e of registry.entries) {
    console.log(`  ${e.id} [${e.status}] ${e.platform}/${e.activity ?? '任意'} 节点=${e.node_readable ? '可读' : '不可读'} 策略=${e.strategy} 门店=${e.stores.join('、') || '未登记'}`);
  }
} else if (command === 'match') {
  const platform = flags.platform;
  const textCount = Number(flags.text ?? 0);
  if (!platform) throw new Error('用法：match --platform=jd [--activity=...] [--text=0]');
  const hit = matchLayout(registry, { platform, activity: flags.activity ?? null, nodeReadable: textCount >= 5 });
  console.log(JSON.stringify(hit ?? { strategy: 'unknown', reason: '没有匹配的布局，需要人工确认' }, null, 2));
} else {
  console.log('可用命令：list / match');
}
