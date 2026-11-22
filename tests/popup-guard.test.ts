import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { looksLikeModal } from '../src/adapters/popup-guard.js';

async function image(background: string, center: string): Promise<Buffer> {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="640">
    <rect width="320" height="640" fill="${background}"/>
    <rect x="60" y="220" width="200" height="200" rx="16" fill="${center}"/>
  </svg>`)).png().toBuffer();
}

test('正常明亮页面不判为弹窗', async () => {
  assert.equal(await looksLikeModal(await image('#f5f5f5', '#ffffff')), false);
});

test('四周压暗、中间明亮的模态浮层判为弹窗', async () => {
  assert.equal(await looksLikeModal(await image('#4a4a4a', '#ffffff')), true);
});

test('整页都很暗时不会仅因暗就误判为弹窗', async () => {
  assert.equal(await looksLikeModal(await image('#555555', '#555555')), false);
});
