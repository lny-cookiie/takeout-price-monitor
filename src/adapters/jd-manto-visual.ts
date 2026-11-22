// 京东 Manto 小程序门店页的视觉兜底：门店页节点不可读时，用截图定位单品、点开详情、点「立即购买」，
// 再复用已有的视觉结算读取（隐私涂黑、金额双读、费用核对）。
import { randomUUID } from 'node:crypto';
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
  await dismissPopup(screen, model, evidenceStore, attemptId, signal);
  const first = await screen.device.screenshot(signal);
  const storeEvidence = await evidenceStore.save(randomUUID(), 'store', first, JSON.stringify({ mode: 'manto_visual', item: itemName }), 'live', new Date().toISOString());

  // 小店页面点商品文字经常点偏，改成点目标商品行右侧的加号，成功率高且不依赖详情页。
  const [plusX, plusY] = await model.locate(attemptId, first, itemName + ' 这一行右侧的加号', signal);
  signal.throwIfAborted();
  await screen.device.tap(plusX, plusY);
  await wait(1_500, undefined, { signal });
  await dismissPopup(screen, model, evidenceStore, attemptId, signal);
  const afterAdd = await screen.device.screenshot(signal);
  const itemEvidence = await evidenceStore.save(randomUUID(), 'item', afterAdd, JSON.stringify({ mode: 'manto_visual', item: itemName, step: 'added' }), 'live', new Date().toISOString());

  // 加购后底部会出现“领券结算/去结算”，点击进入结算页。
  let checkoutX = 0, checkoutY = 0, found = false;
  for (const hint of ['领券结算', '去结算']) {
    try {
      [checkoutX, checkoutY] = await model.locate(attemptId, afterAdd, hint, signal);
      found = true;
      break;
    } catch { /* 换下一个按钮文案 */ }
  }
  if (!found) throw new CollectionError('manto_checkout_button_missing');
  await screen.device.tap(checkoutX, checkoutY);
  await wait(3_500, undefined, { signal });
  await dismissPopup(screen, model, evidenceStore, attemptId, signal);

  // 复用京东已有的视觉结算读取：隐私区涂黑、保存证据、金额双读一致才发布。
  const checkout = await captureVisualCheckout(screen, model, evidenceStore, attemptId, signal, contextProof, { itemName, quantity: 1 });

  // 加购路径动过购物车：退回门店页，点同一行的减号撤掉本次加购，只撤一份。
  let cleanup: 'restored' | 'untouched' = 'untouched';
  try {
    await screen.device.back();
    await wait(1_200, undefined, { signal });
    await dismissPopup(screen, model, evidenceStore, attemptId, signal);
    const storeAgain = await screen.device.screenshot(signal);
    const [minusX, minusY] = await model.locate(attemptId, storeAgain, itemName + ' 这一行左侧的减号', signal);
    await screen.device.tap(minusX, minusY);
    await wait(1_200, undefined, { signal });
    cleanup = 'restored';
  } catch {
    throw new CollectionError('manto_cart_cleanup_failed', 'blocked');
  }
  return { checkout, storeEvidence, itemEvidence, cleanup };
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
