import { array, boolean, digest, enumOf, normalize, nullable, object, string, validator } from './competition.js';
import { csvRows } from './csv.js';

export interface CatalogRow {
  city:string; district:string; brand:string; storeName:string; itemName:string; spec:string;
  is_baoxiao:boolean|null; storeId?:string; skuId?:string; options?:string[];
}
export interface CatalogEntry extends CatalogRow {
  id:string; revision:string; savedStoreId:string; source:'internal'|'trial'; sourceVersion:string; importedAt:string;
}
export interface CatalogImport { mode:'preview'|'commit'; source:'internal'|'trial'; sourceVersion?:string; records?:CatalogRow[]; csv?:string }
const nonblank=(n:number)=>({...string(n),pattern:'\\S'});
export const catalogRowSchema=object({city:nonblank(80),district:nonblank(80),brand:nonblank(100),storeName:nonblank(160),itemName:nonblank(160),spec:nonblank(150),
  is_baoxiao:nullable(boolean),storeId:nonblank(100),skuId:nonblank(100),options:array(nonblank(100),20)},
  ['city','district','brand','storeName','itemName','spec']);
const checkRows=validator<CatalogRow[]>(array(catalogRowSchema,500,1),'包销品清单');
export const checkCatalogImport=validator<CatalogImport>(object({mode:enumOf('preview','commit'),source:enumOf('internal','trial'),sourceVersion:nonblank(100),
  records:array(catalogRowSchema,500,1),csv:string(1_000_000)},['mode','source']),'清单导入');
export const catalogColumns=['城市','区县','品牌','完整分店名','商品名','规格','是否包销','门店编号','SKU编号','已选选项'] as const;
export const catalogTemplate='\uFEFF'+catalogColumns.join(',')+'\r\n';
export function parseCatalog(input:CatalogImport):CatalogRow[] {
  if (Boolean(input.csv)===Boolean(input.records)) throw new Error('请提供 CSV 或 JSON 记录中的一种');
  let records=input.records;
  if(input.csv) {
    const [head,...rows]=csvRows(input.csv.replace(/^\uFEFF/,''));
    if(!head || new Set(head).size!==head.length)throw new Error('CSV 标题缺失或重复');
    if(catalogColumns.slice(0,7).some(k=>!head.includes(k)))throw new Error('请使用清单模板，保留城市、区县、品牌、完整分店名、商品名、规格和是否包销列');
    records=rows.map((row,i)=>{
      if(row.length!==head.length)throw new Error(`第 ${i+2} 行列数不一致`);
      const v=(key:string)=>row[head.indexOf(key)]?.trim()??'';
      const flag=v('是否包销');
      if(!['','true','false','是','否'].includes(flag))throw new Error(`第 ${i+2} 行是否包销应填 true、false、是或否，未核实时留空`);
      return {city:v('城市'),district:v('区县'),brand:v('品牌'),storeName:v('完整分店名'),itemName:v('商品名'),spec:v('规格'),
        is_baoxiao:flag===''?null:flag==='true'||flag==='是',...(v('门店编号')?{storeId:v('门店编号')}:{}),...(v('SKU编号')?{skuId:v('SKU编号')}:{}),
        options:v('已选选项')?v('已选选项').split('、'):[]};
    });
  }
  const checked=checkRows(records).map(row=>({...row,...Object.fromEntries(Object.entries(row).filter(([,v])=>typeof v==='string').map(([k,v])=>[k,(v as string).trim()])),is_baoxiao:row.is_baoxiao??null,options:row.options??[]}));
  if(input.source==='trial' && checked.some(r=>r.is_baoxiao!==null))throw new Error('试采记录的是否包销必须留空，不能作为包销凭据');
  const ids=checked.map(r=>catalogKey(r,input.source));
  if(new Set(ids).size!==ids.length)throw new Error('清单内存在重复门店商品，请合并或使用不同 SKU 编号');
  return checked;
}
export function catalogKey(row:CatalogRow,source:CatalogEntry['source']) {
  return digest(['catalog',source,row.storeId??[normalize(row.city),normalize(row.district),normalize(row.brand),normalize(row.storeName)],
    row.skuId??[normalize(row.itemName),normalize(row.spec),(row.options??[]).map(normalize).sort()]]);
}
export function catalogEligible(row:CatalogEntry) { return row.source==='trial'||row.is_baoxiao===true; }
