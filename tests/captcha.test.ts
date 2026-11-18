import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTCHA_PATTERN, looksLikeCaptcha } from '../src/adapters/captcha.js';

test('验证码识别覆盖美团图片验证码输入框', () => {
  assert.equal(looksLikeCaptcha(['请输入图片中的内容']), true);
  assert.equal(looksLikeCaptcha(['搜索', '麦当劳']), false);
  assert.equal(CAPTCHA_PATTERN.test('请拖动滑块完成验证'), true);
});
