import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSignature, matchLayout, type LayoutRegistry } from '../src/domain/layout.js';

const registry: LayoutRegistry = {
  version: 1,
  updated_at: '2026-11-20T00:00:00Z',
  entries: [
    { id: 'jd-webview', platform: 'jd', activity: 'com.jingdong.app.mall', node_readable: true, strategy: 'node_shelf', stores: [], status: 'verified', first_seen: '', verified_runs: [], notes: '' },
    { id: 'jd-manto', platform: 'jd', activity: 'com.jingdong.manto.card.MantoLightActivity', node_readable: false, strategy: 'manto_visual', stores: [], status: 'pending', first_seen: '', verified_runs: [], notes: '' },
  ],
};

test('布局签名由平台、容器和节点可读性组成', () => {
  assert.equal(layoutSignature('jd', 'com.jingdong.app.mall', true), 'jd:com.jingdong.app.mall:nodes');
  assert.equal(layoutSignature('jd', null, false), 'jd:unknown:visual');
});

test('按 Activity 精确匹配策略', () => {
  const hit = matchLayout(registry, { platform: 'jd', activity: 'com.jingdong.manto.card.MantoLightActivity', nodeReadable: false });
  assert.equal(hit?.strategy, 'manto_visual');
});

test('没有 Activity 时按节点可读性退选，不匹配平台返回空', () => {
  assert.equal(matchLayout(registry, { platform: 'jd', activity: null, nodeReadable: true })?.id, 'jd-webview');
  assert.equal(matchLayout(registry, { platform: 'meituan', activity: null, nodeReadable: true }), null);
});
