// 用真实本地页面生成 README 操作截图，不包含地址、姓名、电话等个人信息。
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.env.BD_BASE_URL ?? 'http://127.0.0.1:4318';
const outDir = 'docs/images';
await mkdir(outDir, { recursive: true });
// 本机已有 Playwright Chromium 缓存时直接复用，避免重新下载浏览器。
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

await page.goto(base + '/bd#auto', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.screenshot({ path: outDir + '/bd-auto.png', fullPage: true });

await page.click('.bd-tab[data-tab="screenshots"]');
await page.waitForTimeout(500);
await page.fill('#shot-batch-form [name="city"]', '天津市');
await page.fill('#shot-batch-form [name="brand"]', '康师傅私房牛肉面');
await page.fill('#shot-batch-form [name="item"]', '宝藏红烧牛肉面');
await page.click('#create-shot-batch');
await page.waitForTimeout(800);
await page.screenshot({ path: outDir + '/bd-screenshots.png', fullPage: true });

await page.click('.bd-tab[data-tab="ledger"]');
await page.waitForTimeout(900);
await page.screenshot({ path: outDir + '/bd-ledger.png', fullPage: false });

// 用一条历史完整组展示结果页，不触发任何真实采集。
await page.evaluate(() => localStorage.setItem('bd-last-group', '91763593-124d-4cd5-8edd-6c8db4d78c8f'));
await page.goto(base + '/bd#auto', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const result = page.locator('#result-panel');
if (await result.count()) {
  await result.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
}
await page.screenshot({ path: outDir + '/bd-result.png', fullPage: true });

await browser.close();
if (errors.length) {
  console.log('页面错误：');
  for (const error of errors.slice(0, 10)) console.log('- ' + error);
  process.exitCode = 1;
} else {
  console.log('截图已生成：' + outDir);
}
