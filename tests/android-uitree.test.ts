import test from 'node:test';
import assert from 'node:assert/strict';
import { uiautomatorXmlToUiNode } from '../src/adapters/android-uitree.js';

const DPR = 3.375;

const sample = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
  `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.jingdong.app.mall" content-desc="" bounds="[0,0][1260,2844]">` +
  `<node index="0" text="板烧鸡腿堡" resource-id="com.jingdong.app.mall:id/title" class="android.widget.TextView" package="com.jingdong.app.mall" content-desc="" bounds="[27,486][540,594]" />` +
  `<node index="1" text="已售 39 &amp; 好评 &quot;100%&quot;" resource-id="" class="android.widget.TextView" package="com.jingdong.app.mall" content-desc="" bounds="[27,600][700,690]" />` +
  `</node></hierarchy>`;

test('解析层级：hierarchy 单子节点为根，保留 class/package 与文本', () => {
  const root = uiautomatorXmlToUiNode(sample, DPR);
  assert.equal(root.type, 'android.widget.FrameLayout');
  assert.equal(root.attrs.package, 'com.jingdong.app.mall');
  assert.equal(root.attrs.class, 'android.widget.FrameLayout');
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0]?.attrs.text, '板烧鸡腿堡');
  assert.equal(root.children[0]?.attrs['resource-id'], 'com.jingdong.app.mall:id/title');
});

test('bounds 从物理像素换算为逻辑坐标', () => {
  const root = uiautomatorXmlToUiNode(sample, DPR);
  assert.deepEqual(root.bounds, { left: 0, top: 0, width: 373.3333333333333, height: 842.6666666666666 });
  const item = root.children[0]!.bounds;
  assert.ok(Math.abs(item.left - 27 / DPR) < 1e-9);
  assert.ok(Math.abs(item.top - 486 / DPR) < 1e-9);
  assert.ok(Math.abs(item.width - 513 / DPR) < 1e-9);
  assert.ok(Math.abs(item.height - 108 / DPR) < 1e-9);
});

test('实体与引号解码', () => {
  const root = uiautomatorXmlToUiNode(sample, DPR);
  assert.equal(root.children[1]?.attrs.text, '已售 39 & 好评 "100%"');
});

test('缺少 bounds 的节点返回零尺寸而不是报错', () => {
  const xml = `<hierarchy rotation="0"><node class="android.widget.TextView" package="p" text="x" /></hierarchy>`;
  const root = uiautomatorXmlToUiNode(xml, DPR);
  assert.deepEqual(root.bounds, { left: 0, top: 0, width: 0, height: 0 });
});

test('hierarchy 有多个子节点时保留 hierarchy 自身', () => {
  const xml = `<hierarchy rotation="0"><node class="a" bounds="[0,0][10,10]" /><node class="b" bounds="[0,0][20,20]" /></hierarchy>`;
  const root = uiautomatorXmlToUiNode(xml, 1);
  assert.equal(root.type, 'hierarchy');
  assert.equal(root.children.length, 2);
});

test('畸形或空 XML 抛错', () => {
  assert.throws(() => uiautomatorXmlToUiNode('', DPR));
  assert.throws(() => uiautomatorXmlToUiNode('<hierarchy><node></hierarchy>', DPR));
});
