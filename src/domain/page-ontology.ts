import {digest, type BreakdownKey} from './competition.js';
import type {AndroidSource} from '../adapters/android-source.js';
import type {Platform} from './contracts.js';

export const PAGE_ONTOLOGY_VERSION='1.0.0';
export const PAGE_RULESET_VERSION='2026-11-08.11';
export const businessEntities=[
  {id:'brand',name:'品牌'}, {id:'physical_store',name:'实体门店'}, {id:'platform_store',name:'平台店铺'},
  {id:'standard_item',name:'标准单品及规格'}, {id:'platform_sku',name:'平台商品规格'},
  {id:'quote_context',name:'账号、配送、时间与数量条件'}, {id:'price_observation',name:'一次价格观测'},
  {id:'fee_component',name:'费用明细'}, {id:'coupon_application',name:'优惠使用记录'}, {id:'evidence',name:'脱敏证据'},
  {id:'page_state',name:'页面状态'}, {id:'page_region',name:'页面区域'}, {id:'field_binding',name:'字段在页面上的取数规则'},
  {id:'action_transition',name:'操作及前后页面'}, {id:'collection_attempt',name:'一次执行尝试'}
] as const;
export const businessRelations=[
  ['brand','has_store','physical_store'],['physical_store','represented_by','platform_store'],
  ['standard_item','represented_by','platform_sku'],['platform_store','offers','platform_sku'],
  ['price_observation','observes','platform_sku'],['price_observation','under','quote_context'],
  ['price_observation','has_fee','fee_component'],['price_observation','applies','coupon_application'],
  ['price_observation','supported_by','evidence'],['page_state','contains','page_region'],
  ['field_binding','located_in','page_region'],['field_binding','supported_by','evidence'],
  ['action_transition','starts_at','page_state'],['action_transition','ends_at','page_state'],
  ['collection_attempt','uses','field_binding'],['collection_attempt','produces','price_observation']
] as const;
export const quoteFieldDefinitions={
  payable:{id:'price.checkout_payable',name:'结算应付',entity:'price_observation',scope:'所选一份商品的当前订单',aliases:['应付总额','结算应付','实付'],stage:'checkout'},
  subtotal:{id:'price.item_subtotal',name:'商品小计',entity:'price_observation',scope:'当前订单商品部分；优惠前后需另记',aliases:['商品小计','商品金额','商品总额','餐品金额','商品合计','小计'],stage:'checkout'},
  packaging:{id:'fee.packaging.actual',name:'实际包装费',entity:'fee_component',scope:'当前结算实际收取',aliases:['包装费','打包费','餐盒费'],stage:'checkout'},
  delivery:{id:'fee.delivery.actual',name:'实际配送费',entity:'fee_component',scope:'当前结算实际收取',aliases:['配送费','运费'],stage:'checkout'},
  other:{id:'fee.other.actual',name:'其他费用',entity:'fee_component',scope:'仅页面明确列明的其他费用',aliases:['其他费用','其他费','服务费'],stage:'checkout'},
  discount:{id:'coupon.applied_total',name:'实际优惠合计',entity:'coupon_application',scope:'页面本次已抵扣；不代表平台出资',aliases:['优惠合计','优惠总额','共减','已优惠','优惠'],stage:'checkout'},
  eta:{id:'delivery.estimated_arrival',name:'预计配送',entity:'price_observation',scope:'页面预计值，不是实际履约',aliases:['预计送达','预计配送'],stage:'checkout'}
} as const;
export const fieldGovernance={
  currency:'CNY',moneyUnit:'fen',unknown:null,zero:'只有明确免费或零元证据才能写 0',
  verification:'金额经页面结构与视觉模型独立读取，一致才发布；仅模型读数保留待复核',
  references:'原配送费、原包装费、划线商品参考价与当前实收分开',
  changes:'页面位置变化增加地图版本；金额含义变化增加本体版本；旧结果保留原版本'
};
export const supplyFieldDefinitions=[
  {id:'brand.name',name:'品牌名称',entity:'brand',page:'brand_search',rule:'品牌和别名用于找候选，不能直接确认分店'},
  {id:'store.platform_id',name:'平台门店编号',entity:'platform_store',page:'store_identity',rule:'保留原编号；缺失使用本地编号并标注来源'},
  {id:'store.full_name',name:'完整分店名',entity:'physical_store',page:'store_identity',rule:'不接受截断店名；与城市、区县及营业地址一起核对'},
  {id:'store.business_address',name:'营业地址',entity:'physical_store',page:'store_identity',rule:'由页面或已核实的平台店号取得，不要求 BD 每次填写'},
  {id:'item.name',name:'单品名称',entity:'standard_item',page:'item_detail',rule:'精确名称或已确认映射；不拿相似商品替代'},
  {id:'item.specification',name:'商品规格与已选选项',entity:'platform_sku',page:'item_detail',rule:'容量、数量、口味、加料分别核对，单品和套餐分开'},
  {id:'context.quantity',name:'本次商品份数',entity:'quote_context',page:'owned_cart',rule:'本版固定一份；全车总量和该商品数量共同核对'},
  {id:'context.eligibility',name:'账号资格',entity:'quote_context',page:'preflight',rule:'平台和门店新老客、具体会员权益分别记录，未知不推断'},
  {id:'context.delivery_address',name:'配送地址条件',entity:'quote_context',page:'checkout',rule:'本机核对当前地址；模型与公开地图只保留简称或指纹'}
] as const;
export const executionPages:Record<string,string>={
  source_check:'device_check',device_connect:'device_check',launch:'jd_home',brand_search:'brand_search',
  brand_model_match:'store_candidates',store_verify:'store_identity',store_address_open:'store_identity',sku_match:'item_detail',menu_price:'item_detail',
  menu_model:'item_detail_evidence',cart:'owned_cart',checkout:'checkout',coupon_checkout:'checkout_coupon_entry',
  model_verify:'checkout_evidence',restore:'cart_restore'
};
export const mapVersion=(source:AndroidSource)=>digest([PAGE_ONTOLOGY_VERSION,PAGE_RULESET_VERSION,source.platform,source.entry,source.appVersion,source.selectors,source.fields,source.jdShelf,source.privacy]);
export function publicPageMap(platform:Platform,source?:AndroidSource){
  const bindings=Object.entries(quoteFieldDefinitions).map(([key,definition])=>({
    id:platform+'.checkout.'+key,propertyId:definition.id,page:'checkout',region:key==='payable'?'amount_total':key==='eta'?'delivery':'fees',
    selector:source?.fields[key as BreakdownKey|'eta'|'payable']??null,
    extraction:source?.fields[key as BreakdownKey|'eta'|'payable']?'configured_and_semantic':'semantic_rows',
    verification:'independent_text_and_model',status:source?'calibrating':'unverified',evidenceRequired:true
  }));
  return {platform,ontologyVersion:PAGE_ONTOLOGY_VERSION,rulesetVersion:PAGE_RULESET_VERSION,mapVersion:source?mapVersion(source):null,appVersion:source?.appVersion??null,
    entry:source?.entry??null,status:source?'calibrating':'unverified',
    note:source?'配置存在不等于全页面已通过真机验证；逐字段状态以任务证据为准':'尚未取得该平台的页面样本，不能启用或宣称已掌握',
    bindings,transitions:[{from:'store_menu',action:'verify_business_address',to:'store_identity',precondition:'缺少可复用的近期同店证据；重新定位商家标签且无商品详情遮挡',postcondition:'核对完整分店与地址并返回菜单'},
      {from:'item_detail',action:'add_one',to:'owned_cart',precondition:'同店同品同规格、空购物车',postcondition:'本次一份商品且总数量为一'},
      {from:'owned_cart',action:'read_checkout',to:'checkout',precondition:'已核对本次商品与数量',postcondition:'核对商品、条件及应付；不提交订单'},
      {from:'checkout',action:'restore_own_item',to:'store_menu',precondition:'独立恢复预算',postcondition:'核对空购物车或暂停设备'}]};
}
