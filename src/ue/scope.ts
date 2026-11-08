import type {Sku,Unit} from '../domain/ue.js';

export interface ScopeFilters {
  city:string; area:string; tier:string; category:string; brand:string; store:string;
  user:string; period:string; channel:string; form:string; days:number;
}
const ALL='全部';
export const defaultScope=():ScopeFilters=>({city:'天津',area:ALL,tier:ALL,category:'快餐',brand:ALL,store:ALL,user:ALL,period:ALL,channel:ALL,form:ALL,days:28});
export function matchesScope(sku:Sku,units:Unit[],scope:ScopeFilters):boolean {
  const unit=units.find(u=>u.id===sku.unitId);
  if(!unit)return false;
  const same=(value:string,selected:string)=>selected===ALL||selected===value;
  return same(unit.city,scope.city)&&same(unit.area,scope.area)&&same(unit.tier,scope.tier)&&same(unit.category,scope.category)
    &&same(sku.brand,scope.brand)&&same(sku.store,scope.store)&&same(unit.user,scope.user)&&same(unit.period,scope.period)&&same(unit.channel,scope.channel);
}
function hasUnit(units:Unit[],scope:ScopeFilters,omit?:keyof ScopeFilters):boolean {
  return units.some(u=>(omit==='city'||scope.city===ALL||u.city===scope.city)
    &&(omit==='area'||scope.area===ALL||u.area===scope.area)
    &&(omit==='tier'||scope.tier===ALL||u.tier===scope.tier)
    &&(omit==='category'||scope.category===ALL||u.category===scope.category)
    &&(omit==='channel'||scope.channel===ALL||u.channel===scope.channel)
    &&(scope.user===ALL||u.user===scope.user)&&(scope.period===ALL||u.period===scope.period));
}
export function changeScope(scope:ScopeFilters,key:keyof ScopeFilters,value:string,skus:Sku[],units:Unit[]):ScopeFilters {
  const next={...scope,[key]:key==='days'?Number(value):value} as ScopeFilters;
  if(key==='city'){next.area=ALL;next.store=ALL;}
  if(key==='category'){next.area=ALL;next.brand=ALL;next.store=ALL;}
  if(key==='area'||key==='brand')next.store=ALL;
  // Preserve the dimension just changed. If another dimension has no data in this combination,
  // clear that dimension instead of showing an empty page.
  const clear=(field:keyof ScopeFilters)=>{(next as unknown as Record<string,string|number>)[field]=ALL;};
  const candidates:Record<string,(keyof ScopeFilters)[]>={city:['tier','category','channel'],tier:['city','category','channel'],category:['city','tier','channel'],channel:['city','tier','category'],area:['city','tier','category','channel']};
  for(const field of candidates[key]??[]){
    if(hasUnit(units,next))break;
    if(hasUnit(units,next,field)){clear(field);break;}
  }
  if(['city','tier','category','channel','area'].includes(key)&&!hasUnit(units,next))clear(key);
  const unitFor=(s:Sku)=>units.find(u=>u.id===s.unitId);
  const skuMatches=(s:Sku)=>{const u=unitFor(s);return !!u&&hasUnit([u],next)&&(next.brand===ALL||s.brand===next.brand)&&(next.store===ALL||s.store===next.store);};
  if(next.brand!==ALL&&!skus.some(skuMatches))next.brand=ALL;
  if(next.store!==ALL&&!skus.some(skuMatches))next.store=ALL;
  return next;
}
