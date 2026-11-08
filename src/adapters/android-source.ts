import { readFile } from 'node:fs/promises';
import { array, boolean, breakdownKeys, enumOf, object, safeDate, string, validator, type BreakdownKey } from '../domain/competition.js';
import { PLATFORMS, type Platform } from '../domain/contracts.js';

export interface Selector { text: string; resource?: string; className?: string; withDescription?: boolean; textHash?:string; textPrefix?:boolean }
export interface Field { resource?: string; className?:string; prefix: string }
export interface ShelfLocator { resource?: string; className?: string; text?: string }
export interface ShelfField { resource?: string; className?: string; prefix: string; endAt?: string }
export interface JdShelfCalibration {
  searchResults: ShelfLocator; resultCard: ShelfLocator; resultName: ShelfField;
  identity: ShelfLocator; storeName: ShelfField; city: ShelfField; address: ShelfField;
  district?: ShelfField; brand?: ShelfField; storeId?: ShelfField;
  reviewedStores?: {id:string; brand:string; name:string; city:string; district:string; address:string; reference:string}[];
  menu: ShelfLocator; menuIdentity?:{resource:string}; itemCard: ShelfLocator; itemName: ShelfField;
  itemKind?: ShelfField; itemSpec?: ShelfField; itemOptions?: ShelfField; itemId?: ShelfField; sales?: ShelfField;
  end?: ShelfLocator; salesOrder?: ShelfLocator;
  brandAliases?: {brand:string; aliases:string[]}[];
  pilot?: {storeId:string; name:string; address:string; reference:string; queryResource:string; resultLabel:string; resultAnchor?:string; singleName:string; singleSpec:string;
    autoSingles?:boolean; directSingle?:boolean; singles?: {name:string; spec:string; options?:string[]}[]};
}
export interface AndroidSource {
  privacy?:{checkoutTopRatio:number};
  platform: Platform; entry: string; package: string; appVersion: string; device: string; account: string; point: string;
  access: { reviewedBy: string; reference: string; expiresAt: string; allowedUse: 'competition_monitoring'; writtenPermission?: string };
  selectors: Record<RequiredSelector,Selector> & Partial<Record<OptionalSelector,Selector>>;
  fields: Partial<Record<BreakdownKey|'eta'|'current'|'reference'|'couponName'|'couponRule'|'couponThreshold'|'couponBasis'|'couponScope'|'couponTime'|'couponMember'|'couponStacking'|'couponApplied'|'couponEligible'|CatalogField,Field>> & { payable: Field };
  couponRowResource?: string;
  searchBy?: 'brand'|'store';
  jdShelf?: JdShelfCalibration;
  subtotalBasis: 'before_discount'|'after_discount'|'unknown'; feesSeparate: boolean | null;
}
const required = ['home','search','searchInput','result','store','address','item','selectedSpec','add','cartEmpty','cartLine','quantity','checkout','checkoutStage','delivery','point','remove'] as const;
const catalogFields = ['catalogStore','catalogBrand','catalogCity','catalogAddress','catalogItem','catalogSpec','catalogOptions','catalogKind'] as const;
type CatalogField = typeof catalogFields[number];
const optional = ['cart','cartPanel','cartCount','checkoutLine','checkoutQuantity','soldOut','closed','outOfRange','minimum',
  'channel','entryCategory','homePoint','searchValue','searchSubmit','category','itemDetail','dismissItemDetail','spec','checkoutSpec','options','composition','increase'] as const;
type RequiredSelector = typeof required[number];
type OptionalSelector = typeof optional[number];
const selector = object({text:string(200,0),resource:string(200),className:string(120),withDescription:boolean,textHash:{type:'string',pattern:'^[a-f0-9]{64}$'},textPrefix:boolean},['text']);
const field = object({resource:string(200),className:string(120),prefix:string(50,0)},['prefix']);
const shelfLocator = object({resource:string(200),className:string(120),text:string(200)},[]);
const shelfField = object({resource:string(200),className:string(120),prefix:string(50,0),endAt:string(50)},['prefix']);
const jdShelfSchema = object({
  menuIdentity:object({resource:string(200)}),
  ...Object.fromEntries(['searchResults','resultCard','identity','menu','itemCard','end','salesOrder'].map(k=>[k,shelfLocator])),
  ...Object.fromEntries(['resultName','storeName','city','address','district','brand','storeId','itemName','itemKind','itemSpec','itemOptions','itemId','sales'].map(k=>[k,shelfField])),
  reviewedStores:array(object({id:string(80),brand:string(100),name:string(150),city:string(80),district:string(80),address:string(250),reference:string(200)}),30),
  brandAliases:array(object({brand:string(100),aliases:array(string(100),15,1)}),30),
  pilot:object({storeId:{type:'string',pattern:'^[a-f0-9]{64}$'},name:string(160),address:string(250),reference:string(250),
    queryResource:string(200),resultLabel:string(150),resultAnchor:string(150),singleName:string(100),singleSpec:string(100),autoSingles:boolean,directSingle:boolean,
    singles:array(object({name:string(100),spec:string(100),options:array(string(100),20)}),20,1)},
    ['storeId','name','address','reference','queryResource','resultLabel','singleName','singleSpec'])
},['searchResults','resultCard','resultName','identity','storeName','city','address','menu','itemCard','itemName']);
const check = validator<AndroidSource>(object({
  privacy:object({checkoutTopRatio:{type:'number',minimum:0,maximum:0.4}}),
  platform:enumOf(...PLATFORMS),entry:string(100),package:{type:'string',pattern:'^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]+)+$'},
  appVersion:string(50),device:{type:'string',pattern:'^[A-Za-z0-9_.:-]{1,80}$'},account:string(80),point:string(80),
  access:object({reviewedBy:string(100),reference:string(250),expiresAt:string(40),allowedUse:enumOf('competition_monitoring'),writtenPermission:string(250)},['reviewedBy','reference','expiresAt','allowedUse']),
  selectors:object(Object.fromEntries([...required,...optional].map(k=>[k,selector])),[...required]),
  fields:object(Object.fromEntries(['payable',...breakdownKeys,'eta','current','reference','couponName','couponRule','couponThreshold','couponBasis','couponScope','couponTime','couponMember','couponStacking','couponApplied','couponEligible',...catalogFields].map(k=>[k,field])),['payable']),
  couponRowResource:string(200),searchBy:enumOf('brand','store'),jdShelf:jdShelfSchema,subtotalBasis:enumOf('before_discount','after_discount','unknown'),feesSeparate:{anyOf:[boolean,{type:'null'}]}
},['platform','entry','package','appVersion','device','account','point','access','selectors','fields','subtotalBasis','feesSeparate']),'Android 来源配置');

export class AndroidSources {
  private constructor(private rows: AndroidSource[], private issues: Partial<Record<Platform,string>> = {}, readonly configurationError: string | null = null) {}
  static async load(path: string) {
    let input: string;
    try { input = await readFile(path,'utf8'); }
    catch(e) { return new AndroidSources([],{},(e as NodeJS.ErrnoException).code === 'ENOENT' ? null : '无法读取 Android 来源配置文件'); }
    let raw: unknown;
    try { raw = JSON.parse(input.replace(/^\uFEFF/,'')); }
    catch { return new AndroidSources([],{},'Android 来源配置需要有效的 JSON'); }
    if (!Array.isArray(raw) || raw.length>12) return new AndroidSources([],{},'Android 来源配置需要平台数组');
    const rows: AndroidSource[] = [], issues: Partial<Record<Platform,string>> = {};
    let configurationError: string|null = null;
    for (const platform of PLATFORMS) {
      const entries = raw.filter((v:unknown)=>v && typeof v==='object' && (v as Partial<AndroidSource>).platform===platform);
      if (!entries.length) continue;
      if (entries.length>1) { issues[platform]='每个平台只能登记一个采集入口'; continue; }
      try {
        const row = check(entries[0]);
        this.checkControls(row);
        rows.push(row);
      } catch (e) { issues[platform]=(e as Error).message; }
    }
    if (raw.some((v:unknown)=>!v || typeof v!=='object' || !PLATFORMS.includes((v as AndroidSource).platform)))
      configurationError='来源配置中存在无法识别的平台';
    return new AndroidSources(rows,issues,configurationError);
  }
  private static checkControls(row: AndroidSource) {
      safeDate(row.access.expiresAt);
      const s=row.selectors;
      const actionText=(control: Selector) => control.text.replace(/[，,]\s*按钮$/,'').trim();
      if (!['加入购物车','加购','+','＋','增加','添加'].includes(actionText(s.add)) || !['-','−','－','减少','减一份','减少购买数量'].includes(actionText(s.remove)))
        throw new Error('购物车操作必须使用已核实的加减控件');
      if (s.increase && !['+','＋','增加','加一份','增加购买数量'].includes(actionText(s.increase))) throw new Error('增加数量必须使用已核实的加号控件');
      if (!['结算','去结算','去结算订单'].includes(actionText(s.checkout))) throw new Error('结算控件必须是已核实的结算入口');
      if (s.searchSubmit && actionText(s.searchSubmit)!=='搜索') throw new Error('搜索提交控件必须对应搜索按钮');
      if (s.dismissItemDetail && (actionText(s.dismissItemDetail)!=='关闭弹层' || !s.dismissItemDetail.resource))
        throw new Error('只能关闭已核实的商品详情弹层');
      if (s.searchSubmit && (!s.searchValue?.text.includes('{query}') || !(s.searchValue.resource || s.searchValue.className))) throw new Error('提交搜索前必须核对搜索框的词');
      const lineHasSpec=(control:Selector)=>control.text.includes('{item}') && control.text.includes('{spec}');
      if (!s.quantity.text.includes('{quantity}') || !lineHasSpec(s.cartLine) || !s.selectedSpec.text.includes('{spec}') ||
        (s.checkoutQuantity && !s.checkoutQuantity.text.includes('{quantity}')) ||
        (s.checkoutLine && !lineHasSpec(s.checkoutLine) && !(s.checkoutLine.text.includes('{item}') && s.checkoutSpec?.resource && s.checkoutSpec.text.includes('{spec}'))))
        throw new Error('购物车和规格控件必须核对商品、规格及数量');
      for (const [key,control] of Object.entries(s)) {
        if (control.textHash && (!['point','homePoint'].includes(key) || !(control.resource || control.className))) throw new Error('仅配送核对控件可以使用本地指纹');
        if (control.textPrefix && !((['search','delivery','cartPanel'].includes(key) && control.text.trim() && (control.resource || control.className)) ||
          (key==='searchInput' && control.resource))) throw new Error('仅已核对的搜索框支持变化提示词');
        if (!control.text.trim() && !control.textHash && !(key==='searchInput' && control.textPrefix && control.resource) && (key!=='cartPanel' || !control.resource))
          throw new Error('控件缺少已核实的文字：'+key);
        if (control.withDescription && !(['item','result'].includes(key)||(key==='selectedSpec'&&control.text==='已选：{spec}'))) throw new Error('只有搜索结果、商品和已选规格可以附带页面说明：'+key);
      }
      for (const key of ['search','searchInput','searchSubmit','result','item','category','spec','add','checkout','remove','cart','channel','entryCategory','increase'] as const) {
        const control=s[key];
        if (control && !control.resource && !control.className) throw new Error('可操作控件需要已核实的资源编号或控件类型：'+key);
      }
      const panelLocated=s.cartPanel?.resource || (s.cartPanel?.textPrefix && s.cartPanel.className);
      if (!s.cartLine.resource && !(panelLocated && s.cartLine.className && s.cartCount?.text.includes('{quantity}') && s.checkoutLine?.resource))
        throw new Error('购物车缺少可核对的范围、件数或结算商品编号');
      if (s.checkoutLine && !s.checkoutLine.resource) throw new Error('结算商品需要已核实的资源编号');
      if (s.cartPanel && !panelLocated) throw new Error('购物车面板需要已核实的资源编号或面板文字');
      for (const [key,reading] of Object.entries(row.fields)) {
        if (!reading.resource && !(reading.className && reading.prefix.trim())) throw new Error('读数字段缺少已核实的定位依据：'+key);
      }
      const shelf=row.jdShelf;
      if (shelf) {
        if (row.platform!=='jd') throw new Error('货架校准只适用于京东入口');
        for (const key of ['searchResults','resultCard','identity','menu','itemCard','end','salesOrder'] as const) {
          const anchor=shelf[key];
          if (anchor && !anchor.resource && !anchor.className) throw new Error('货架控件缺少定位依据：'+key);
          if ((key==='end' || key==='salesOrder') && anchor && !anchor.text) throw new Error('货架范围标志缺少已核实文字：'+key);
        }
        for (const key of ['resultName','storeName','city','address','district','brand','storeId','itemName','itemKind','itemSpec','itemOptions','itemId','sales'] as const) {
          const target=shelf[key];
          if (target && !target.resource && !(target.className && (target.prefix || target.endAt))) throw new Error('货架字段缺少定位依据：'+key);
        }
        if (shelf.reviewedStores?.length && !shelf.storeId) throw new Error('按门店编号核验需要已校准的门店编号字段');
        if (shelf.reviewedStores?.some(r=>!/^[A-Za-z0-9_.:-]+$/.test(r.id)) || new Set(shelf.reviewedStores?.map(r=>r.id)).size!==(shelf.reviewedStores?.length ?? 0))
          throw new Error('已核验平台门店编号格式错误或重复');
      }
  }
  get(platform: Platform) { return this.rows.find(row=>row.platform===platform); }
  permitted(platform: Platform, at = Date.now()) {
    const source = this.get(platform);
    return !!source && Date.parse(source.access.expiresAt)>at && (platform !== 'taobao_instant' || Boolean(source.access.writtenPermission?.trim()));
  }
  status(platform: Platform) {
    const source = this.get(platform);
    return { platform, problem:this.issues[platform] ?? null, entry:source?.entry ?? null, appVersion:source?.appVersion ?? null,
      status:this.issues[platform] ? 'invalid_configuration' : this.permitted(platform) ? 'ready_for_defined_scope' : platform==='taobao_instant' ? 'restricted' : 'pending' };
  }
}

export const entryLabels: Record<Platform,string> = {
  jd:'京东应用 · 外卖入口',meituan:'美团应用 · 外卖入口',taobao_instant:'淘宝应用 · 闪购入口'
};
