// 设备锁串行性测试：三平台并发发起时必须严格串行占用同一台设备。
// 背景见 src/adapters/device-lock.ts：调度器会让不同平台真并发，
// 但物理上只有一台手机，必须靠这把锁保证串行。
import {withDeviceLock, deviceHolder, deviceQueueLength} from '../src/adapters/device-lock.js';

const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));
const events: string[] = [];
const jobs = [
  {name: 'jd', ms: 120},
  {name: 'meituan', ms: 80},
  {name: 'taobao_instant', ms: 50},
];

await Promise.all(jobs.map(j => withDeviceLock(j.name, async () => {
  events.push(`${j.name}:start`);
  await sleep(j.ms);
  events.push(`${j.name}:end`);
})));

console.log('执行顺序:', events.join(' → '));

let bad = false;
for (const j of jobs) {
  const s = events.indexOf(`${j.name}:start`), e = events.indexOf(`${j.name}:end`);
  if (!(s >= 0 && e > s)) { console.log(`✗ ${j.name} 顺序异常`); bad = true; }
}
let depth = 0, maxDepth = 0;
for (const ev of events) {
  if (ev.endsWith(':start')) { depth++; maxDepth = Math.max(maxDepth, depth); } else depth--;
}
const ok = !bad && maxDepth === 1 && deviceHolder() === null;
console.log(`最大并发度: ${maxDepth}（期望 1）`);
console.log(`结束后设备空闲: ${deviceHolder() === null ? '✓' : '✗'} 队列=${deviceQueueLength()}`);
console.log(ok ? '\n✅ 设备锁工作正常：三平台会串行使用同一台设备' : '\n❌ 设备锁异常');
process.exit(ok ? 0 : 1);
