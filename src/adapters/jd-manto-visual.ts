// 京东 Manto 小程序门店页的视觉兜底：门店页节点不可读时，用截图定位单品、点开详情、点「立即购买」，
// 再复用已有的视觉结算读取（隐私涂黑、金额双读、费用核对）。
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { setTimeout as wait } from 'node:timers/promises';
import type { Evidence } from '../domain/contracts.js';
import { CollectionError } from '../domain/contracts.js';
import type { ModelGateway } from '../infra/model.js';
import type { EvidenceStore } from '../infra/evidence.js';
import { captureVisualCheckout } from './visual-checkout.js';
import { dismissPopup } from './popup-guard.js';
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
): Promise<{ checkout: VerifiedCheckout; storeEvidence: Evidence; itemEvidence: Evidence; cleanup: 'restored' | 'untouched' }> {
  const thumb = async (png: Buffer) => sharp(png).resize(48, 48, { fit: 'fill' }).greyscale().raw().toBuffer();
  const stableShot = async () => {
    let png = await screen.device.screenshot(signal);
    for (let attempt = 0; attempt < 4; attempt++) {
      await wait(700, undefined, { signal });
      const next = await screen.device.screenshot(signal);
      const [a, b] = [await thumb(png), await thumb(next)];
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! - b[i]!);
      if (diff / a.length < 1.5) return next;
      png = next;
    }
    return png;
  };
  await dismissPopup(screen, model, evidenceStore, attemptId, signal);
  const first = await stableShot();
  const storeEvidence = await evidenceStore.save(randomUUID(), 'store', first, JSON.stringify({ mode: 'manto_visual', item: itemName }), 'live', new Date().toISOString());

  // 点商品标题打开详情页，再点固定的“立即购买”位置进结算；立即购买不经过购物车，清理状态可以保持 untouched。
  let detailReached = false;
  let itemEvidence: Evidence | null = null;
  for (let attempt = 0; attempt < 2 && !detailReached; attempt++) {
    const shot = attempt === 0 ? first : await stableShot();
    const [itemX, itemY] = await model.locate(attemptId, shot, itemName, signal);
    signal.throwIfAborted();
    await screen.device.tap(itemX, itemY);
    await wait(2_500, undefined, { signal });
    await dismissPopup(screen, model, evidenceStore, attemptId, signal);
    const detail = await stableShot();
    const kind = await pageKind(model, attemptId, detail, signal, 'manto_page_kind');
    if (kind === 'item_detail' || kind === 'checkout') {
      itemEvidence = await evidenceStore.save(randomUUID(), 'item', detail, JSON.stringify({ mode: 'manto_visual', item: itemName }), 'live', new Date().toISOString());
      detailReached = true;
      if (kind === 'checkout') break;
    }
  }
  if (!detailReached || !itemEvidence) throw new CollectionError('manto_item_detail_not_reached');

  // 商品详情页底部“立即购买”位置固定，直接点固定比例，避免模型二次定位漂移。
  const viewport = await screen.device.size();
  await screen.device.tap(viewport.width * 0.804, viewport.height * 0.952);
  await wait(3_500, undefined, { signal });
  await dismissPopup(screen, model, evidenceStore, attemptId, signal);

  let checkout: VerifiedCheckout | null = null;
  for (let attempt = 0; attempt < 2 && !checkout; attempt++) {
    try {
      checkout = await captureVisualCheckout(screen, model, evidenceStore, attemptId, signal, contextProof, { itemName, quantity: 1 });
    } catch (error) {
      if (!(error instanceof CollectionError && error.code === 'not_on_checkout_screen') || attempt === 1) throw error;
      // 页面动画或弹窗吃掉第一次点击时，再点一次固定位置；立即购买不会改购物车，重试不会叠加商品。
      await screen.device.tap(viewport.width * 0.804, viewport.height * 0.952);
      await wait(2_500, undefined, { signal });
      await dismissPopup(screen, model, evidenceStore, attemptId, signal);
    }
  }
  if (!checkout) throw new CollectionError('not_on_checkout_screen', 'blocked');
  return { checkout, storeEvidence, itemEvidence, cleanup: 'untouched' };
}

/** 把视觉门店采集结果组装成标准 AttemptResult，供采集器在京东小程序门店路径复用。 */
export async function collectMantoAttempt(input: {
  screen: ReviewedScreen;
  model: Pick<ModelGateway, 'json' | 'locate'>;
  evidenceStore: EvidenceStore;
  attemptId: string;
  signal: AbortSignal;
  task: import('../domain/contracts.js').Task;
  item: { name: string; spec: string };
  platform: import('../domain/contracts.js').Platform;
  trace: import('../domain/contracts.js').AttemptResult['trace'];
  timings: import('../domain/contracts.js').AttemptResult['timings'];
  startedAt: string;
  pageMap?: import('../domain/contracts.js').AttemptResult['pageMap'];
  cost: (attemptId: string) => number | null;
}): Promise<import('../domain/contracts.js').AttemptResult> {
  const { randomUUID } = await import('node:crypto');
  const visual = await readMantoCheckout(input.screen, input.model, input.evidenceStore, input.attemptId, input.signal, input.item.name, []);
  const read = visual.checkout;
  const { task } = input;
  const context = task.live!;
  const component = (value: { fen: number; raw: string } | null) => value
    ? { amount_fen: value.fen, raw_value: value.raw, basis: 'separately_displayed' as const, included_in: 'checkout_payable' as const }
    : { amount_fen: null, raw_value: null, basis: 'unknown' as const, included_in: null };
  const deliveryValue = read.components.delivery;
  const packagingValue = read.components.packaging;
  const complete = deliveryValue !== null && packagingValue !== null;
  const observation: import('../domain/contracts.js').Observation = {
    observation_id: randomUUID(), source_id: task.source_id, tenant_id: task.tenant_id, slot_id: task.slot_id, attempt_id: input.attemptId, platform: input.platform,
    store_id: task.store_id, basket_id: task.basket_id, scenario_id: task.scenario_id, price_kind: 'checkout_payable', price_scope: 'basket', currency: 'CNY',
    amount_fen: read.total, raw_value: read.raw, components: { delivery_fee: component(deliveryValue), packaging_fee: component(packagingValue) },
    missing_reasons: { ...(deliveryValue === null ? { delivery_fee: 'not_verified' } : {}), ...(packagingValue === null ? { packaging_fee: 'not_verified' } : {}) },
    observed_at: read.evidence.captured_at, collected_at: new Date().toISOString(), value_origin: 'observed', quote_valid: true, detail_complete: complete,
    basket_items: [{ product_id: context.target.id, name: input.item.name, variant: context.mapping?.candidate.supply.item.spec ?? input.item.spec, quantity: 1 }],
    account_ref: task.account_ref, delivery_point_id: task.delivery_point_id, entry_point: task.entry_point, evidence_refs: [read.evidence],
    contract_version: task.contract_version, collector_version: 'android-0.4.0',
    details: {
      components: read.components, subtotalBasis: read.basis, feesSeparate: read.feesSeparate, eta: read.eta, coupons: read.coupons,
      couponCandidates: read.couponCandidates, missing: read.missing, reconciled: read.reconciled, contextEvidence: read.evidence,
      storeEvidence: visual.storeEvidence, itemEvidence: visual.itemEvidence, fieldResults: read.fieldResults, supplementaryEvidence: read.supplementaryEvidence,
    },
  };
  return {
    status: complete ? 'success' : 'partial', error_code: null, availability: 'available', observation, evidence: read.evidence,
    resolvedLive: context, quoteReadyAt: new Date().toISOString(), pageMap: input.pageMap, timings: input.timings, trace: input.trace,
    started_at: input.startedAt, finished_at: new Date().toISOString(), cleanup: visual.cleanup,
    cost: { model_yuan: input.cost(input.attemptId), execution_ms: Date.now() - Date.parse(input.startedAt) },
  };
}
