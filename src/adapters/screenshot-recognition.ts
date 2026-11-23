// 上传结算页截图的识别入口：不经过手机，只把脱敏后的截图交给本地视觉模型，
// 读取门店、商品、规格、数量和金额费用，再按统一口径转成分并做费用核对。
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Evidence } from '../domain/contracts.js';
import type { ModelGateway } from '../infra/model.js';
import type { EvidenceStore } from '../infra/evidence.js';
import { confidenceOf, moneyToFen, reconcileFees, type ScreenshotFields, type ScreenshotPlatform } from '../domain/screenshot.js';
import { CollectionError } from '../domain/contracts.js';

const platformName: Record<ScreenshotPlatform, string> = { jd: '京东外卖', meituan: '美团外卖', taobao_instant: '淘宝闪购' };

export interface RecognizedScreenshot {
  fields: ScreenshotFields;
  evidence: Evidence;
  imageSha256: string;
  raw: unknown;
  reconciled: boolean;
  confidence: 'high' | 'medium' | 'low';
  issues: string[];
}

/** 只保留顶部 24% 的黑条，遮住地址、姓名、电话；其余内容用于识别。 */
async function maskTop(image: Buffer): Promise<{ png: Buffer; sha256: string }> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new CollectionError('screenshot_invalid');
  const top = Math.round(height * 0.24);
  const png = await sharp(image).composite([{ input: { create: { width, height: top, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }, top: 0, left: 0 }]).png().toBuffer();
  const { createHash } = await import('node:crypto');
  return { png, sha256: createHash('sha256').update(png).digest('hex') };
}

function asText(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function asQuantity(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 99) return value;
  if (typeof value === 'string' && /^[x×*]?\s*\d{1,2}$/i.test(value.trim())) return Number(value.trim().replace(/^[x×*]?\s*/i,''));
  return null;
}

function asCoupons(value: unknown): { label: string; rule: string | null; applied: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const label = asText(row.label, 120);
    if (!label) return [];
    return [{ label, rule: asText(row.rule, 200), applied: asText(row.applied, 80) }];
  }).slice(0, 10);
}

export async function recognizeScreenshot(input: {
  platform: ScreenshotPlatform;
  image: Buffer;
  filename: string;
  model: Pick<ModelGateway, 'json'>;
  evidenceStore: EvidenceStore;
  signal: AbortSignal;
  expected?: { city?: string; brand?: string; store?: string; item?: string };
}): Promise<RecognizedScreenshot> {
  if (!input.model) throw new CollectionError('screenshot_model_unavailable', 'blocked');
  const masked = await maskTop(input.image);
  const evidence = await input.evidenceStore.save(randomUUID(), 'upload_checkout', masked.png, JSON.stringify({ mode: 'screenshot_upload', platform: input.platform, filename: input.filename }), 'live');
  const instruction = `读取这张${platformName[input.platform]}结算页截图，严格返回 JSON：
{"pageKind":"checkout或item_detail或other","storeName":null,"city":null,"brand":null,"itemName":null,"spec":null,"quantity":null,"payable":null,"subtotal":null,"packaging":null,"delivery":null,"discount":null,"eta":null,"coupons":[]}
pageKind 看到应付总额/提交订单/去支付/打白条等填 checkout，看到加入购物车/立即购买但无应付填 item_detail，其他填 other。
金额只填页面明确出现的数字，以元为单位，保留两位小数；没显示就填 null，绝不倒推或编造。payable 是应付总额，subtotal 是商品小计，packaging 是打包费，delivery 是配送费，discount 是优惠合计。
coupons 只填已使用的券，每项 {label,rule,applied}，没有就空数组。不要读取和返回姓名、电话、地址。`;
  const raw = await input.model.json('screenshot', 'screenshot_read', instruction, { platform: input.platform }, (value) => {
    if (!value || typeof value !== 'object') throw new Error('screenshot_json_invalid');
    return value as Record<string, unknown>;
  }, { image: masked.png, signal: input.signal, evidenceIds: [evidence.id], maxImageWidth: 1200 });

  const pageKind = asText(raw.pageKind, 40) ?? 'other';
  const fields: ScreenshotFields = {
    pageKind,
    storeName: asText(raw.storeName),
    city: asText(raw.city, 80),
    brand: asText(raw.brand, 80),
    itemName: asText(raw.itemName, 160),
    spec: asText(raw.spec, 80),
    quantity: asQuantity(raw.quantity),
    payableFen: moneyToFen(raw.payable),
    subtotalFen: moneyToFen(raw.subtotal),
    packagingFen: moneyToFen(raw.packaging),
    deliveryFen: moneyToFen(raw.delivery),
    discountFen: moneyToFen(raw.discount),
    coupons: asCoupons(raw.coupons),
    eta: asText(raw.eta, 80),
  };
  if (fields.pageKind !== 'checkout') throw new CollectionError('not_checkout_screenshot', 'blocked');
  const reconciled = reconcileFees(fields);
  const { confidence, issues } = confidenceOf(fields, reconciled);
  if (input.expected?.brand && fields.brand && !fields.brand.includes(input.expected.brand)) issues.push('品牌与填写值不一致');
  if (input.expected?.item && fields.itemName && !fields.itemName.includes(input.expected.item)) issues.push('商品与填写值不一致');
  return { fields, evidence, imageSha256: masked.sha256, raw, reconciled, confidence, issues };
}
