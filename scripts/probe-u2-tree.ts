import { AndroidUiTreeReader } from '../src/adapters/android-uitree.js';
import { deviceInventory } from '../src/adapters/android-transport.js';

const serial = process.argv[2];
if (!serial) throw new Error('用法: tsx scripts/probe-u2-tree.ts <设备序列号> [次数]');
const rounds = Number(process.argv[3] ?? 10);

const status = await deviceInventory();
const device = status.devices.find(item => item.serial === serial);
if (device?.state !== 'device') throw new Error(`设备不在线: ${serial} (${device?.state ?? 'not found'})`);

const reader = await AndroidUiTreeReader.create({
  serial,
  onDiagnostic: event => console.log('diag', JSON.stringify(event)),
});

const times: number[] = [];
for (let i = 0; i < rounds; i++) {
  const started = Date.now();
  const tree = await reader.read();
  const ms = Date.now() - started;
  times.push(ms);
  const count = (function flatten(node): number { return 1 + node.children.reduce((sum, child) => sum + flatten(child), 0); })(tree.root);
  console.log(`read#${i + 1} ${ms}ms nodes=${count} root=${tree.root.type} pkg=${tree.root.attrs.package ?? ''}`);
}
times.sort((a, b) => a - b);
const pick = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)]!;
console.log(JSON.stringify({ rounds, min: times[0], p50: pick(0.5), p90: pick(0.9), max: times.at(-1), mean: Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) }));
