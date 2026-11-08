import { randomUUID } from 'node:crypto';
import { addressKey, itemGate, judgmentSchema, normalize, specKey, storeGate, validator, type Candidate, type Judgment, type Mapping, type Supply, type Target } from '../domain/competition.js';
import type { ModelGateway } from '../infra/model.js';

const check = validator<Judgment>(judgmentSchema,'匹配建议');
const visibleFields = ({store:{key:_store,...store},item:{key:_item,...item}}:Supply) => ({store,item});
const output = '输出 { "relation":"exact|similar|different|unknown", "reason":"中文理由", "missing":[] }。只确认有证据的一致，信息不足时说明缺项。';

export function rankCandidates(target:Target,candidates:Candidate[]) {
  const a=target.supply;
  const score=(c:Candidate)=>Number(normalize(c.supply.store.city)===normalize(a.store.city))*8+
    Number(normalize(c.supply.store.brand)===normalize(a.store.brand))*4+
    Number(normalize(c.supply.store.address)===normalize(a.store.address))*2+
    Number(normalize(c.supply.item.name)===normalize(a.item.name));
  return [...candidates].sort((a,b)=>score(b)-score(a)).slice(0,5);
}
export async function proposeMapping(target:Target,candidate:Candidate,model:Pick<ModelGateway,'json'>):Promise<Mapping> {
  const id=randomUUID(), a=visibleFields(target.supply), b=visibleFields(candidate.supply);
  const evidenceIds=candidate.evidence ? [candidate.evidence.id] : [];
  const store=storeGate(target.supply,candidate.supply) ??
    await model.json(id,'store_match','判断是否同一实体门店，核对品牌、城市、营业地址和分店。'+output,{reference:{...a.store,address:addressKey(target.supply.store)},candidate:{...b.store,address:addressKey(candidate.supply.store)}},check,{evidenceIds});
  const item=store.relation==='exact' && !store.missing.length
    ? itemGate(target.supply,candidate.supply) ??
      await model.json(id,'item_match',
        '判断两个标题指向的菜品主体是否相同。已选规格、单位、口味和套餐组成已经核对一致。标题中仅重复了已选选项的词语，不能据此判不同。菜品主体或配料不同则判不同。信息不足时返回 unknown。'+output,
        {referenceName:a.item.name,candidateName:b.item.name,verifiedCommon:{kind:a.item.kind,spec:specKey(a.item.spec),options:a.item.options,parts:a.item.parts}},check,{evidenceIds})
    : {relation:'unknown' as const,reason:'门店尚未确认一致。',missing:['实体门店']};
  return {id,targetId:target.id,targetRevision:target.revision,candidate,store,item,status:'proposed',proposedAt:new Date().toISOString(),reviewedAt:null};
}