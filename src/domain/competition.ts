import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Evidence, Platform } from './contracts.js';

export const BUSINESS_VERSION = '2.0.0';
export const platformNames: Record<Platform,string> = { jd:'京东外卖', meituan:'美团', taobao_instant:'淘宝闪购' };
export const liveSources: Record<Platform,string> = { jd:'JD_FRONTEND', meituan:'MT_FRONTEND', taobao_instant:'TB_FRONTEND' };
export const meals = { lunch:'午市', dinner:'晚市', night:'夜宵' } as const;
export type Meal = keyof typeof meals;
export type Customer = 'new' | 'existing' | 'unknown';

export interface Supply {
  store: { key: string; brand: string; name: string; city: string; address: string };
  item: { key: string; name: string; kind: 'single' | 'set'; spec: string; options: string[] | null;
    parts: { name: string; spec: string; quantity: number }[] | null };
}
export interface Target { id: string; revision: string; supply: Supply; reference: string }
export interface Candidate { platform: Platform; entry: string; supply: Supply; reference: string; evidence?: Evidence }
export type Relation = 'exact' | 'similar' | 'different' | 'unknown';
export interface Judgment { relation: Relation; reason: string; missing: string[] }
export interface Mapping {
  id: string; targetId: string; targetRevision: string; candidate: Candidate;
  store: Judgment; item: Judgment; status: 'proposed' | 'verified' | 'rejected';
  proposedAt: string; reviewedAt: string | null; reviewMinutes?: number;
}
export interface Eligibility {
  accountRef: string; platformCustomer: Customer; storeCustomer: Customer; memberSegment: string;
  memberProduct: string; memberTier: string; benefits: string[]; evidence: string; storeEvidence?: string;
}
export interface Profile {
  id: string; name: string; city: string; point: string;
  eligibility: Partial<Record<Platform,Eligibility>>;
  checkedAt?: string; validUntil?: string;
  storeQualifications?: { storeKey:string; platform:Platform; customer:Customer; evidence:string }[];
}
export interface Plan {
  id: string; name: string; targetIds: string[]; profileId: string; quantity: number;
  startDate: string; days: number; times: Partial<Record<Meal,string>>; enabled: boolean;
}
export interface LiveContext {
  target: Target; mapping: Mapping | null; profile: Profile; planName: string; meal: Meal;
  quantity: number; couponPolicy: 'page_applied'|'claim_on_checkout'; sourceRevision: string | null;
}
export const breakdownKeys = ['subtotal','packaging','delivery','other','discount'] as const;
export type BreakdownKey = typeof breakdownKeys[number];
export interface Reading { raw: string; fen: number; evidence: Evidence }
export interface Coupon {
  label: string; rule: string | null; threshold: string | null; basis: string | null;
  scope: string | null; validTime: string | null; memberCondition: string | null;
  stacking: string | null; eligible: boolean | null; applied: Reading | null;
}
export interface MarketRead {
  prices: { kind: 'display_current' | 'display_reference'; qualifier: 'exact' | 'from' | 'range' | 'unknown'; raw: string; fen: number | null; evidence: Evidence }[];
}
export interface QuoteDetails {
  fieldResults?:Record<string,FieldVerification>;
  supplementaryEvidence?:Evidence[];
  couponCandidates?:{label:string;rule:string|null;applied:string|null}[];
  components: Record<BreakdownKey, Reading | null>;
  subtotalBasis: 'before_discount' | 'after_discount' | 'unknown';
  feesSeparate: boolean | null;
  eta: { raw: string; evidence: Evidence } | null;
  coupons: Coupon[] | null;
  missing: Record<string,string>;
  reconciled: boolean;
  contextEvidence: Evidence; storeEvidence: Evidence; itemEvidence: Evidence;
}
export interface FieldVerification {
  propertyId?:string;
  modelAttempts?:{raw:string|null;status:string}[];
  raw:string|null; modelRaw:string|null; fen:number|null; status:'verified'|'missing'|'unverified'|'mismatch';reason:string|null;
  evidenceId:string;box:{left:number;top:number;width:number;height:number}|null;
}
export interface OrderImport { key: string; supply: Supply; paidAt: string | null; actualPaidFen: number | null; reference: string }
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value,(_key,v:unknown)=>v && typeof v==='object' && !Array.isArray(v) ?
  Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)) : v)).digest('hex');
export const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/[\s，,、（）()]/g,'');
export const redactSensitive = (s: string) => s.replace(/\b1[3-9]\d{9}\b/g,'***');
export function addressKey(s: Supply['store']) {
  const address = normalize(s.address), city = normalize(s.city);
  return city && address.startsWith(city) ? address.slice(city.length) : address;
}
export function specKey(s: string) {
  return normalize(s).replace(/(\d+(?:\.\d+)?)\s*(?:千克|kg)/g,(_,n) => String(Number(n)*1000)+'g')
    .replace(/(\d+(?:\.\d+)?)\s*(?:毫升|ml)/g,'$1ml').replace(/(\d+(?:\.\d+)?)克/g,'$1g')
    .replace(/(\d+(?:\.\d+)?)升/g,(_,n) => String(Number(n)*1000)+'ml');
}
export function storeGate(a: Supply, b: Supply): Judgment | null {
  if (![a.store,b.store].every(s => s.city && s.brand && addressKey(s))) return { relation:'unknown', reason:'需要补齐城市、品牌或营业地址。', missing:['门店身份'] };
  if (normalize(a.store.city) !== normalize(b.store.city)) return { relation:'different',reason:'城市不同。',missing:[] };
  if (addressKey(a.store) !== addressKey(b.store) || normalize(a.store.brand) !== normalize(b.store.brand))
    return { relation:'similar',reason:'营业地址或品牌尚未核实为一致。',missing:[] };
  return null;
}
export function itemGate(a: Supply, b: Supply): Judgment | null {
  const x = a.item, y = b.item;
  if (x.kind !== y.kind) return { relation:'different',reason:'单品与套餐不能作为同一商品。',missing:[] };
  if (!x.spec || !y.spec || !x.options || !y.options || (x.kind === 'set' && (!x.parts?.length || !y.parts?.length || [...x.parts,...y.parts].some(p => !p.spec))))
    return { relation:'unknown',reason:'规格、已选选项或套餐组成需要补齐。',missing:['商品规格'] };
  const options = (v: string[]) => JSON.stringify(v.map(specKey).sort());
  const parts = (v: NonNullable<Supply['item']['parts']>) => JSON.stringify(v.map(p => [normalize(p.name),specKey(p.spec),p.quantity].join('|')).sort());
  if (specKey(x.spec) !== specKey(y.spec) || options(x.options) !== options(y.options) || (x.kind === 'set' && parts(x.parts!) !== parts(y.parts!)))
    return { relation:'similar',reason:'规格、选项或套餐内容尚未核实为一致。',missing:[] };
  return null;
}
export function profileApplies(p:Profile, at:number) {
  return !!p.checkedAt && !!p.validUntil && Number.isFinite(at) && Date.parse(p.checkedAt)<=at && at<=Date.parse(p.validUntil);
}
export function sameEligibility(a?: Eligibility, b?: Eligibility): boolean {
  if (!a || !b || !a.evidence || !b.evidence || !a.storeEvidence || !b.storeEvidence || !a.memberSegment || !b.memberSegment) return false;
  if (a.platformCustomer === 'unknown' || a.storeCustomer === 'unknown') return false;
  const verifiedMember = (e: Eligibility) => e.memberSegment==='非会员' ? !e.memberProduct && !e.memberTier && !e.benefits.length : !!e.memberProduct && !!e.memberTier && !!e.benefits.length;
  if (!verifiedMember(a) || !verifiedMember(b)) return false;
  return a.platformCustomer === b.platformCustomer && a.storeCustomer === b.storeCustomer &&
    a.memberSegment === b.memberSegment && JSON.stringify(a.benefits.map(normalize).sort()) === JSON.stringify(b.benefits.map(normalize).sort());
}

const ajv = new Ajv2020();
export const string = (maxLength = 160, minLength = 1) => ({type:'string', minLength,maxLength});
export const nullable = (schema: object) => ({anyOf:[schema,{type:'null'}]});
export const array = (items: object, maxItems: number, minItems = 0) => ({type:'array', items, maxItems,minItems});
export const object = (properties: Record<string,object>, required = Object.keys(properties)) => ({type:'object', additionalProperties:false, required, properties});
export const number = (minimum: number, maximum: number) => ({type:'integer',minimum,maximum});
export const enumOf = (...values: string[]) => ({type:'string',enum:values});
export const boolean = {type:'boolean'};
export const supplySchema = object({
  store:object({key:string(),brand:string(100,0),name:string(),city:string(80,0),address:string(250,0)}),
  item:object({key:string(),name:string(),kind:enumOf('single','set'),spec:string(150,0),options:nullable(array(string(),20)),
    parts:nullable(array(object({name:string(),spec:string(150,0),quantity:number(1,99)}),30))})
});
export const judgmentSchema = object({relation:enumOf('exact','similar','different','unknown'),reason:string(300),missing:array(string(100),10)});
export const eligibilitySchema = object({
  accountRef:string(80),platformCustomer:enumOf('new','existing','unknown'),storeCustomer:enumOf('new','existing','unknown'),memberSegment:string(80,0),
  memberProduct:string(80,0),memberTier:string(80,0),benefits:array(string(80),20),evidence:string(200,0)
});
export const profileSchema = object({
  id:string(60),name:string(80),city:string(80),point:string(80),
  eligibility:object({jd:eligibilitySchema,meituan:eligibilitySchema,taobao_instant:eligibilitySchema},[]),
  checkedAt:string(40),validUntil:string(40),
  storeQualifications:array(object({storeKey:string(),platform:enumOf('jd','meituan','taobao_instant'),customer:enumOf('new','existing','unknown'),evidence:string(200,0)}),300)
},['id','name','city','point','eligibility']);
export const orderSchema = object({key:string(100),supply:supplySchema,paidAt:nullable(string(40)),actualPaidFen:nullable(number(0,10_000_000)),reference:string(200)});
export const candidateSchema = object({platform:enumOf('jd','meituan','taobao_instant'),entry:string(100),supply:supplySchema,reference:string(200)});
export const planSchema = object({id:string(60),name:string(100),targetIds:array(string(100),6,1),profileId:string(60),quantity:number(1,9),
  startDate:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},days:number(1,30),
  times:object(Object.fromEntries(Object.keys(meals).map(k=>[k,{type:'string',pattern:'^([01]\\d|2[0-3]):[0-5]\\d$'}])),[]),enabled:boolean});
export function validator<T>(schema: object, label: string) {
  const validate = ajv.compile<T>(schema);
  return (value: unknown): T => {
    if (!validate(value)) throw new Error(label + '：' + (validate.errors?.[0]?.instancePath || '输入') + ' ' + (validate.errors?.[0]?.message ?? '格式错误'));
    return value;
  };
}
export function safeDate(value: string) {
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('时间必须包含时区');
  return new Date(value).toISOString();
}
