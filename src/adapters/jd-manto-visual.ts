// 京东 Manto 小程序门店页的视觉兜底：门店页节点不可读时，用截图定位单品、点开详情、点「立即购买」，
// 再复用已有的视觉结算读取（隐私涂黑、金额双读、费用核对）。
import { setTimeout as wait } from 'node:timers/promises';
import type { Evidence } from '../domain/contracts.js';
import { CollectionError } from '../domain/contracts.js';
import type { ModelGateway } from '../infra/model.js';
import type { EvidenceStore } from '../infra/evidence.js';
import { captureVisualCheckout } from './visual-checkout.js';
import type { ReviewedScreen } from './android-collector.js';
import type { VerifiedCheckout } from './checkout-reading.js';

export type MantoPageKind = 'item_detail' | 'checkout' | 'other';

/** 把模型返回的 pageKind 归一化；未知值一律按 other，避免把商品详情当结算页。 */
export function classifyPageKind(raw: unknown): MantoPageKind {
  return raw === 'item_detail' || raw === 'checkout' ? raw : 'other';
}

/** 节点数量很少且截图非空，判定为小程序/自绘布局，需要走视觉策略。 */
export function looksLikeNodeLessLayout(textNodeCount: number, screenshotBytes: number): boolean {
  return textNodeCount < 5 && screenshotBytes > 10_000;
}

async function pageKind(
  model: Pick<ModelGateway, 'json'>,
  attemptId: string,
  image: Buffer,
  signal: AbortSignal,
  operation: string,
): Promise<MantoPageKind> {
  const result = await model.json(attemptId, operation,
    '判断这张京东外卖页面属于哪种：商品详情页（有“加入购物车/立即购买”）返回 {"pageKind":"item_detail"}；结算页（有“应付总额/打白条/提交订单”）返回 {"pageKind":"checkout"}；其他返回 {"pageKind":"other"}。只输出 JSON。',
    {}, (raw) => ({ pageKind: classifyPageKind((raw as { pageKind?: unknown }).pageKind) }), { image, signal });
  return result.pageKind;
}

/**
 * 在 Manto 门店页完成：定位单品 → 打开详情 → 点立即购买 → 读取结算页。
 * 不做任何下单动作；「立即购买」只进入结算页，不改购物车。
 */
export async function readMantoCheckout(
  screen: ReviewedScreen,
  model: Pick<ModelGateway, 'json' | 'locate'>,
  evidenceStore: EvidenceStore,
  attemptId: string,
  signal: AbortSignal,
  itemName: string,
  contextProof: string[] = [],
): Promise<{ checkout: VerifiedCheckout; itemDetailEvidence: Evidence | null }> {
  const first = await screen.device.screenshot(signal);
  // 门店页上先定位目标单品文字；点文字所在行会打开商品详情。
  const [itemX, itemY] = await model.locate(attemptId, first, itemName, signal);
  signal.throwIfAborted();
  await screen.device.tap(itemX, itemY);
  await wait(2_500, undefined, { signal });

  const detail = await screen.device.screenshot(signal);
  let kind = await pageKind(model, attemptId, detail, signal, 'manto_page_kind');
  if (kind === 'checkout') {
    // 有些门店点单品后直接进结算页，跳过详情页。
  } else if (kind === 'item_detail') {
    const [buyX, buyY] = await model.locate(attemptId, detail, '立即购买', signal);
    signal.throwIfAborted();
    await screen.device.tap(buyX, buyY);
    await wait(3_500, undefined, { signal });
  } else {
    // 第一次点偏了或页面没跳转：重拍一次再定位，仍不对就明确失败并保留截图给人工复盘。
    const retryShot = await screen.device.screenshot(signal);
    const [retryX, retryY] = await model.locate(attemptId, retryShot, itemName, signal);
    await screen.device.tap(retryX, retryY);
    await wait(2_500, undefined, { signal });
    const second = await screen.device.screenshot(signal);
    kind = await pageKind(model, attemptId, second, signal, 'manto_page_kind_retry');
    if (kind === 'item_detail') {
      const [buyX, buyY] = await model.locate(attemptId, second, '立即购买', signal);
      await screen.device.tap(buyX, buyY);
      await wait(3_500, undefined, { signal });
    } else if (kind !== 'checkout') {
      throw new CollectionError('manto_visual_item_not_found');
    }
  }

  // 复用京东已有的视觉结算读取：隐私区涂黑、保存证据、金额双读一致才发布。
  const checkout = await captureVisualCheckout(screen, model, evidenceStore, attemptId, signal, contextProof, { itemName, quantity: 1 });
  return { checkout, itemDetailEvidence: null };
}
