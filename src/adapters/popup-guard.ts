// 通用弹窗守卫：平台经常在搜索、进店、加购、结算前弹出优惠券或活动浮层。
// 浮层会让后续截图和模型读取全部错位，所以每次关键步骤前先用本地亮度特征快速判断，
// 只有疑似浮层时才调用视觉模型定位关闭按钮，关闭后必须复查浮层确实消失。
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import sharp from 'sharp';
import { CollectionError, type Evidence } from '../domain/contracts.js';
import type { ModelGateway } from '../infra/model.js';
import type { EvidenceStore } from '../infra/evidence.js';
import type { ReviewedScreen } from './android-collector.js';

/** 模态浮层的亮度特征：四周被遮罩压暗，中间卡片仍然明亮。 */
export async function looksLikeModal(png: Buffer): Promise<boolean> {
  const { data, info } = await sharp(png).resize(64, 128, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const width = info.width, height = info.height;
  const border: number[] = [], center: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = data[y * width + x]!;
      const edge = x < width * 0.1 || x > width * 0.9 || y < height * 0.1 || y > height * 0.9;
      if (edge) border.push(value);
      else if (x > width * 0.25 && x < width * 0.75 && y > height * 0.3 && y < height * 0.7) center.push(value);
    }
  }
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const borderMean = avg(border), centerMean = avg(center);
  // 正常页面四周通常明亮；只有四周明显变暗且中间仍亮，才判为模态浮层。
  return borderMean < 120 && centerMean > 120 && centerMean > borderMean + 25;
}

/**
 * 如果检测到弹窗就关闭它，返回是否关过。
 * 关闭失败会明确抛错并保留现场截图，不带着弹窗继续读取，避免把弹窗文字当页面内容。
 */
export async function dismissPopup(
  screen: ReviewedScreen,
  model: Pick<ModelGateway, 'locate'>,
  evidenceStore: EvidenceStore,
  attemptId: string,
  signal: AbortSignal,
): Promise<{ dismissed: boolean; evidence: Evidence | null }> {
  let shot = await screen.device.screenshot(signal);
  if (!(await looksLikeModal(shot))) return { dismissed: false, evidence: null };
  const evidence = await evidenceStore.save(randomUUID(), 'popup', shot, '检测到模态浮层，准备关闭', 'live', new Date().toISOString());
  for (let attempt = 0; attempt < 2; attempt++) {
    const hint = attempt === 0 ? '弹窗底部的关闭按钮（×）' : '关闭按钮';
    const [x, y] = await model.locate(attemptId, shot, hint, signal);
    signal.throwIfAborted();
    await screen.device.tap(x, y);
    await wait(900, undefined, { signal });
    shot = await screen.device.screenshot(signal);
    if (!(await looksLikeModal(shot))) return { dismissed: true, evidence };
  }
  // 关不掉时把最新现场也留一份，方便人工复盘是哪一种弹窗。
  try {
    await evidenceStore.save(randomUUID(), 'popup_failed', shot, '弹窗关闭失败，保留现场', 'live', new Date().toISOString());
  } catch { /* 证据保存失败不覆盖主错误 */ }
  throw new CollectionError('popup_close_unverified', 'blocked');
}
