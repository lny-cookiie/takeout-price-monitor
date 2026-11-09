import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 跨机型静态门禁（P0-5）：适配器代码里不允许出现物理分辨率常量。
 *
 * 允许的比例（如 0.17、0.55）代表版式比例，不属于物理像素；禁止的是 1260×2844
 * 这类写死的屏幕像素，它们只在单台机型上成立，换机后必然错位。
 */

const ADAPTERS = 'src/adapters';
const FORBIDDEN = /\b(1220|2712|1080|2400|1260|2844|1440|3200|1600|2560)\b/;

function adapterFiles(): string[] {
  return readdirSync(ADAPTERS).filter(file => file.endsWith('.ts')).map(file => join(ADAPTERS, file));
}

test('适配器源码不出现物理分辨率常量', () => {
  const hits: string[] = [];
  for (const file of adapterFiles()) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      // 注释里的校准记录（例如基线机型分辨率）不算硬编码，只检查可执行代码。
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/^\s*\/\*.*$/, '');
      const match = FORBIDDEN.exec(code);
      if (match) hits.push(`${file}:${index + 1} -> ${match[0]}`);
    });
  }
  assert.deepEqual(hits, [], '适配器里出现物理分辨率常量，请改为比例或设备几何档案');
});

test('适配器源码不出现按物理像素写死的点击坐标', () => {
  // 形如 tap(950, 1118)、input tap 958 1118 这类硬编码点按坐标
  const pattern = /\b(?:tap|input\s+tap)\s*[（(]\s*\d{3,4}\s*,\s*\d{3,4}/;
  const hits: string[] = [];
  for (const file of adapterFiles()) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(hits, [], '适配器里出现硬编码像素点按坐标，请改为控件 bounds 中心');
});
