// 截图识别入口的数据模型、金额校验与 CSV 工具。
import { parseCny } from './contracts.js';

export type ScreenshotPlatform = 'jd' | 'meituan' | 'taobao_instant';
export type ReviewStatus = 'auto' | 'edited' | 'confirmed' | 'rejected';
export type Confidence = 'high' | 'medium' | 'low';

export interface ScreenshotFields {
  pageKind: string;
  storeName: string | null;
  city: string | null;
  brand: string | null;
  itemName: string | null;
  spec: string | null;
  quantity: number | null;
  payableFen: number | null;
  subtotalFen: number | null;
  packagingFen: number | null;
  deliveryFen: number | null;
  discountFen: number | null;
  coupons: { label: string; rule: string | null; applied: string | null }[];
  eta: string | null;
}

export interface ScreenshotRecord extends ScreenshotFields {
  id: string;
  batchId: string;
  platform: ScreenshotPlatform;
  createdAt: string;
  sourceFilename: string;
  evidenceId: string;
  imageSha256: string;
  raw: unknown;
  reconciled: boolean;
  confidence: Confidence;
  reviewStatus: ReviewStatus;
  issues: string[];
  error: string | null;
}

export interface ScreenshotBatch {
  id: string;
  createdAt: string;
  city: string;
  brand: string;
  store: string;
  item: string;
  status: string;
}

/** 把模型返回的金额文本转成分；支持 "¥28.63"、"28.63" 和 null。 */
export function moneyToFen(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/[¥￥元]/g, '');
  if (!cleaned) return null;
  try { return parseCny(cleaned); } catch { return null; }
}

/** 费用加减核对：商品小计 + 打包 + 配送 - 优惠 = 应付，允许 1 分误差。 */
export function reconcileFees(fields: Pick<ScreenshotFields, 'payableFen' | 'subtotalFen' | 'packagingFen' | 'deliveryFen' | 'discountFen'>): boolean {
  if (fields.payableFen === null || fields.subtotalFen === null) return false;
  const sum = fields.subtotalFen + (fields.packagingFen ?? 0) + (fields.deliveryFen ?? 0) - (fields.discountFen ?? 0);
  return Math.abs(sum - fields.payableFen) <= 1;
}

/** 统计缺失字段并给出置信度；低置信度不阻止入库，但必须让用户看到。 */
export function confidenceOf(fields: ScreenshotFields, reconciled: boolean): { confidence: Confidence; issues: string[] } {
  const issues: string[] = [];
  if (!fields.storeName) issues.push('未识别出门店名');
  if (!fields.itemName) issues.push('未识别出商品名');
  if (fields.payableFen === null) issues.push('未识别出应付金额');
  if (fields.quantity === null) issues.push('未识别出数量');
  if (fields.packagingFen === null) issues.push('未识别出打包费');
  if (fields.deliveryFen === null) issues.push('未识别出配送费');
  if (!reconciled) issues.push('费用加减未对平');
  const confidence: Confidence = !fields.payableFen ? 'low' : issues.length > 3 ? 'low' : issues.length ? 'medium' : 'high';
  return { confidence, issues };
}

function safeCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  // 防止 Excel 把以 = + - @ 开头的单元格当公式执行。
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map((c) => safeCell(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => safeCell(row[c.key])).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
