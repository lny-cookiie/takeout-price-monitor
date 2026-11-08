import { array, digest, enumOf, normalize, nullable, number, object, specKey, string, supplySchema, validator, type Supply } from './competition.js';
import type { Evidence } from './contracts.js';

export interface JdStoreInput {
  city: string;
  district: string;
  brand: string;
  storeName: string;
}
export interface JdSavedStore extends JdStoreInput {
  id: string;
  verified?: { store:Supply['store']; evidence:Evidence };
}
export interface JdSavedRunInput {
  requestId: string;
  savedStoreId: string;
  profileId: string;
}
export interface JdRunInput extends JdStoreInput {
  requestId: string;
  businessAddress?: string;
  verifiedStoreKey?: string;
  verifiedStoreName?: string;
  verifiedContext?:{store:Supply['store'];evidence:Evidence;sourceRevision:string};
  savedStoreId?: string;
  profileId: string;
}

export interface JdShelfContext { input: JdRunInput; sourceRevision: string }
export type JdShelfCoverage = 'complete' | 'sales_order' | 'partial' | 'direct_single';
export type JdSalesWindow = 'page_unspecified' | 'month';
export interface JdSalesReading { raw: string; window: JdSalesWindow; value: number; qualifier: 'exact' | 'lower_bound' }

export interface JdShelfItem {
  key: string;
  rawName: string;
  kind: 'single' | 'set' | 'unknown';
  spec: string | null;
  sales: JdSalesReading | null;
  salesRaw?: string | null;
  position: number;
  evidence: Evidence | null;
  excludedReason: string | null;
  supply?: Supply;
}

export interface JdShelfSelectedItem extends JdShelfItem {
  kind: 'single';
  spec: string;
  evidence: Evidence;
  supply: Supply;
}

export interface JdShelfResult {
  store: Supply['store'];
  district?: string;
  evidence: Evidence;
  coverage: JdShelfCoverage;
  scannedCount: number;
  stopReason: string;
  items: JdShelfItem[];
  selected: JdShelfSelectedItem[];
}

export const JD_SHELF_LIMIT = 5;
const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const nonBlank = (maxLength: number) => ({ ...string(maxLength), pattern: '\\S' });

const requestIdSchema={type:'string',pattern:uuidPattern};
const storeInputFields={city:nonBlank(80),district:nonBlank(80),brand:nonBlank(100),storeName:nonBlank(160)};
export const jdStoreInputSchema=object(storeInputFields);
export const jdRunInputSchema=object({requestId:requestIdSchema,...storeInputFields,businessAddress:nonBlank(250),profileId:nonBlank(60)});
export const jdSavedRunInputSchema=object({requestId:requestIdSchema,savedStoreId:{type:'string',pattern:'^[a-f0-9]{64}$'},profileId:nonBlank(60)});

const storeSchema = object({ key: nonBlank(160), brand: nonBlank(100), name: nonBlank(160), city: nonBlank(80), address: nonBlank(250) });
const evidenceSchema = object({
  id: { type: 'string', pattern: uuidPattern }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  screenshot: nonBlank(180), text_file: nonBlank(180), captured_at: nonBlank(40), page_stage: nonBlank(80)
});
const salesSchema = object({ raw: nonBlank(120), window: enumOf('page_unspecified','month'), value: number(0,Number.MAX_SAFE_INTEGER), qualifier: enumOf('exact','lower_bound') });
const shelfFields = {
  key: nonBlank(160), rawName: nonBlank(240), kind: enumOf('single','set','unknown'), spec: nullable(nonBlank(150)), sales: nullable(salesSchema),
  salesRaw:nullable(nonBlank(120)),position: number(1,10_000), evidence: nullable(evidenceSchema), excludedReason: nullable(nonBlank(200)), supply: supplySchema
};
const itemSchema = object(shelfFields,Object.keys(shelfFields).filter(k=>k!=='supply' && k!=='salesRaw'));
const selectedSchema = object({...shelfFields, kind:enumOf('single'), spec:nonBlank(150), evidence:evidenceSchema, excludedReason:{type:'null'}},
  Object.keys(shelfFields).filter(k=>k!=='salesRaw'));
const checkShelf = validator<JdShelfResult>(object({
  store:storeSchema, district:nonBlank(80), evidence:evidenceSchema, coverage:enumOf('complete','sales_order','partial','direct_single'),
  scannedCount:number(0,10_000), stopReason:nonBlank(200), items:array(itemSchema,10_000), selected:array(selectedSchema,JD_SHELF_LIMIT)
},['store','evidence','coverage','scannedCount','stopReason','items','selected']),'京东门店货架');

export function parseJdSalesLabel(raw: string): JdSalesReading | null {
  const candidates = raw.normalize('NFKC').trim().split(/[,，、;；](?!\d{3}(?:[,，.]|\s*(?:件|份|单|\+|$)))/);
  const readings = candidates.flatMap(label => {
    const match = /^(已售|月售)\s*(\d{1,12}(?:,\d{3})*|\d{1,12}\.\d{1,4})\s*([万千])?\s*(\+)?\s*(?:件|份|单)?\s*(\+)?$/.exec(label.trim());
    if (!match) return [];
    const [,prefix,digits,scale,plusBefore,plusAfter] = match;
    if (!digits || (scale && !plusBefore && !plusAfter) || (!scale && digits.includes('.')) || (plusBefore && plusAfter)) return [];
    const [whole,fraction='']=digits.replaceAll(',','').split('.');
    const places=10n**BigInt(fraction.length);
    const scaled=BigInt(whole+fraction)*(scale==='万' ? 10_000n : scale==='千' ? 1_000n : 1n);
    if (scaled%places!==0n) return [];
    const value=Number(scaled/places);
    if (!Number.isSafeInteger(value) || value<0) return [];
    return [{raw,window:prefix==='月售'?'month':'page_unspecified',value,qualifier:plusBefore||plusAfter?'lower_bound':'exact'} satisfies JdSalesReading];
  });
  return readings.length===1 ? readings[0]! : null;
}

export function jdBrandKey(brand: string) {
  const key=normalize(brand);
  return key==='麦当劳&麦咖啡' ? '麦当劳' : key;
}

const cityKey=(city:string)=>normalize(city).replace(/市$/,'');
function branchKey(name:string,brand:string,city:string) {
  const normalized=normalize(name);
  const aliases=jdBrandKey(brand)==='麦当劳' ? ['麦当劳&麦咖啡','麦当劳'] : [normalize(brand)];
  const prefix=aliases.find(alias=>alias && normalized.startsWith(alias));
  const branch=prefix ? normalized.slice(prefix.length) : normalized;
  const cityPrefix=[cityKey(city)+'市',cityKey(city)].find(candidate=>candidate && branch.startsWith(candidate));
  return cityPrefix ? branch.slice(cityPrefix.length) : branch;
}
function localAddress(address:string,city:string,district:string) {
  let key=normalize(address);
  const cityPrefix=[cityKey(city)+'市',cityKey(city)].find(prefix=>prefix && key.startsWith(prefix));
  if (cityPrefix) key=key.slice(cityPrefix.length);
  const districtPrefix=normalize(district);
  return districtPrefix && key.startsWith(districtPrefix) ? key.slice(districtPrefix.length) : key;
}

export function matchesJdBranch(input:JdStoreInput,name:string) {
  if ([input.storeName,name].some(value=>/…|\.{3}/.test(value))) return false;
  const branch=branchKey(input.storeName,input.brand,input.city);
  return !!branch && branch===branchKey(name,input.brand,input.city);
}
export function matchesJdStore(input:JdStoreInput & Pick<JdRunInput,'businessAddress'|'verifiedStoreKey'|'verifiedStoreName'>,store:Supply['store'],district?:string) {
  if (!(matchesJdBranch(input,store.name) || (input.verifiedStoreName && normalize(input.verifiedStoreName)===normalize(store.name))) ||
      [input.businessAddress ?? '',store.address].some(value=>/…|\.{3}/.test(value))) return false;
  const requestedArea=normalize(input.district);
  const actualArea=district===undefined ? null : normalize(district);
  const sameArea=requestedArea && (actualArea!==null ? actualArea===requestedArea : normalize(store.address).includes(requestedArea));
  const address=localAddress(store.address,store.city,input.district);
  return Boolean(sameArea && cityKey(input.city) && cityKey(input.city)===cityKey(store.city) && jdBrandKey(input.brand) &&
    jdBrandKey(input.brand)===jdBrandKey(store.brand) && address &&
    (!input.businessAddress || address===localAddress(input.businessAddress,input.city,input.district)) &&
    (!input.verifiedStoreKey || input.verifiedStoreKey===store.key));
}

function isSelectable(item:JdShelfItem):item is JdShelfSelectedItem {
  const product=item.supply?.item;
  return item.kind==='single' && !!item.spec?.trim() && !!item.evidence && item.excludedReason===null && product?.kind==='single' &&
    !!product.name.trim() && specKey(item.spec)===specKey(product.spec) && product.options!==null && !product.parts?.length;
}

export function jdShelfSalesWindow(items:readonly JdShelfItem[]):JdSalesWindow|null {
  const windows=items.filter(isSelectable).flatMap(item=>item.sales && item.sales.value>0 ? [item.sales.window] : []);
  return windows.includes('page_unspecified') ? 'page_unspecified' : windows.includes('month') ? 'month' : null;
}

export function rankJdShelfItems(items:readonly JdShelfItem[],coverage:JdShelfCoverage,limit=JD_SHELF_LIMIT):JdShelfSelectedItem[] {
  const capped=Number.isSafeInteger(limit) ? Math.max(0,Math.min(limit,JD_SHELF_LIMIT)) : JD_SHELF_LIMIT;
  const candidates=items.filter(isSelectable);
  if (coverage==='direct_single') return candidates.slice(0,Math.min(capped,1));
  const byPosition=(a:JdShelfItem,b:JdShelfItem)=>a.position-b.position || a.key.localeCompare(b.key);
  if (coverage==='sales_order') return candidates.filter(i=>i.sales?.value!==0).sort(byPosition).slice(0,capped);
  const window=jdShelfSalesWindow(candidates);
  return candidates.filter(i=>i.sales && i.sales.value>0 && i.sales.window===window)
    .sort((a,b)=>b.sales!.value-a.sales!.value || byPosition(a,b)).slice(0,capped);
}

export function validateJdShelfResult(value:unknown):JdShelfResult {
  const result=checkShelf(value);
  const checkEvidence=(proof:Evidence) => proof.screenshot===`/api/evidence/${proof.id}.png` &&
    proof.text_file===`/api/evidence/${proof.id}.json` && Number.isFinite(Date.parse(proof.captured_at));
  const storeRevision=digest(result.store);
  if (result.coverage==='direct_single' && (result.items.length!==1 || result.scannedCount!==1 || result.selected.length!==1 ||
    result.items.some(item=>item.sales!==null || item.salesRaw!=null))) throw new Error('invalid_jd_direct_single');
  if (!checkEvidence(result.evidence) || result.items.length>result.scannedCount || new Set(result.items.map(item=>item.key)).size!==result.items.length ||
      new Set(result.items.map(item=>item.position)).size!==result.items.length || result.items.some(item=>item.evidence && !checkEvidence(item.evidence) ||
        item.supply && digest(item.supply.store)!==storeRevision || item.sales && (item.salesRaw!=null && item.salesRaw!==item.sales.raw ||
          digest(parseJdSalesLabel(item.sales.raw))!==digest(item.sales))))
    throw new Error('invalid_jd_shelf_evidence');
  if (digest(result.selected)!==digest(rankJdShelfItems(result.items,result.coverage))) throw new Error('invalid_jd_shelf_ranking');
  return result;
}
