import {csvRows} from '../domain/csv.js';
export {csvRows} from '../domain/csv.js';
import type { OrderImport, Supply } from '../domain/competition.js';

export const jdColumns=['订单行编号','门店编号','品牌','门店名称','城市','营业地址','商品编号','商品名称','商品类型','规格',
  '已选选项','套餐组成','订单实付分','支付时间','来源记录编号'] as const;
const required=['订单行编号','门店编号','门店名称','商品编号','商品名称','商品类型','来源记录编号'] as const;
export function parseOrderCsv(text:string):{records:OrderImport[]} {
  const [head,...rows]=csvRows(text.replace(/^\uFEFF/,''));
  if(!head || !rows.length || rows.length>500)throw new Error('请在 CSV 中保留标题行和 1–500 条记录。');
  if(new Set(head).size!==head.length)throw new Error('CSV 中存在重复列名。');
  const missing=required.filter(k=>!head.includes(k));
  if(missing.length)throw new Error('CSV 缺少列 '+missing.join('、')+'。可下载模板查看列名。');
  const index=new Map(head.map((k,i)=>[k,i]));
  return {records:rows.map((row,i)=>{
    const at='第 '+(i+2)+' 行';
    if(row.length!==head.length)throw new Error(at+'列数与标题不一致。');
    const value=(k:typeof jdColumns[number])=>row[index.get(k) ?? -1] ?? '';
    if(required.some(k=>!value(k)))throw new Error(at+'的必填字段未填写。');
    const kind=value('商品类型'), amount=value('订单实付分');
    if(kind!=='单品' && kind!=='套餐')throw new Error(at+'商品类型需填写单品或套餐。');
    if(amount && !/^\d{1,8}$/.test(amount))throw new Error(at+'订单实付分必须是非负整数。');
    let paidAt:string|null=value('支付时间') || null;
    if(paidAt && /^\d{4}-\d{2}-\d{2} \d\d:\d\d:\d\d$/.test(paidAt))paidAt=paidAt.replace(' ','T')+'+08:00';
    if(amount && !paidAt)throw new Error(at+'填写了实付金额，请补充支付时间。');
    const options=value('已选选项'),partText=value('套餐组成');
    const parts:Supply['item']['parts']=partText ? partText.split(/[\r\n；]+/).filter(x=>x.trim()).map(part=>{
      const [name,spec,quantity]=part.split('|').map(x=>x.trim());
      if(!name || !spec || !/^[1-9]\d?$/.test(quantity ?? ''))throw new Error(at+'套餐组成使用“名称 | 规格 | 数量”，每项用分号或换行分隔。');
      return {name,spec,quantity:Number(quantity)};
    }):null;
    return {key:value('订单行编号'),reference:value('来源记录编号'),actualPaidFen:amount?Number(amount):null,paidAt,
      supply:{store:{key:value('门店编号'),brand:value('品牌'),name:value('门店名称'),city:value('城市'),address:value('营业地址')},
        item:{key:value('商品编号'),name:value('商品名称'),kind:kind==='单品'?'single':'set',spec:value('规格'),
          options:options==='无'?[]:options?options.split('、').map(o=>o.trim()).filter(Boolean):null,parts}}};
  })};
}
export function jdCsvTemplate() {
  return '\uFEFF'+jdColumns.join(',')+'\r\n示例-订单行-1,示例门店ID,示例品牌,示例门店,示例城市,示例营业地址,示例SKU,示例商品,单品,500ml,无,,,,示例来源记录\r\n';
}
