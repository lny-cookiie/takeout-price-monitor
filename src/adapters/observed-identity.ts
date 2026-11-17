import type {U2Node} from './meituan-semantic.js';
import {normalize, specKey} from '../domain/competition.js';

const text=(n:U2Node)=>(n.text || n.desc).trim();
const visible=(n:U2Node)=>n.width>0 && n.height>0;

/** Only accept an unambiguous store name and explicitly labelled merchant address. */
export function observedStore(nodes:U2Node[],brand:string,city:string) {
  const cityKey=normalize(city).replace(/市$/,'');
  const names=nodes.filter(n=>visible(n)&&normalize(text(n)).includes(normalize(brand))&&/店[）)]?$/.test(text(n)));
  const addresses=nodes.filter(n=>visible(n)&&/^(商家地址|营业地址)[:：]/.test(text(n))&&normalize(text(n)).includes(cityKey));
  if (!brand || !cityKey || names.length!==1 || addresses.length!==1) return null;
  return {name:text(names[0]!),address:text(addresses[0]!).replace(/^(商家地址|营业地址)[:：]\s*/,''),nodes:[names[0]!,addresses[0]!]};
}

/** Reject ambiguous names or missing visible specifications. */
export function observedItem(nodes:U2Node[],name:string,spec:string) {
  if (!name || !spec) return null;
  const names=nodes.filter(n=>visible(n)&&normalize(text(n))===normalize(name));
  const specs=nodes.filter(n=>visible(n)&&specKey(text(n))===specKey(spec));
  if (names.length!==1 || specs.length!==1) return null;
  if (Math.abs(names[0]!.top-specs[0]!.top)>4*Math.max(names[0]!.height,specs[0]!.height)) return null;
  const contains=(parent:U2Node,child:U2Node)=>parent.left<=child.left && parent.top<=child.top && parent.left+parent.width>=child.left+child.width && parent.top+parent.height>=child.top+child.height;
  if (!nodes.some(n=>n!==names[0] && n!==specs[0] && visible(n) && n.height<=8*Math.max(names[0]!.height,specs[0]!.height) && contains(n,names[0]!) && contains(n,specs[0]!))) return null;
  return {name:text(names[0]!),spec:text(specs[0]!),nodes:[names[0]!,specs[0]!]};
}

export function observedSingleBasket(nodes:U2Node[],name:string,spec:string):boolean {
  return !!observedItem(nodes,name,spec) && nodes.some(n=>/^(共1件|1件商品|商品共1件)$/.test(text(n).replace(/\s+/g,'')));
}

export function payableEvidenceNodes(nodes:U2Node[],raw:Record<string,string>):U2Node[]|null {
  const label=raw['实付']?'实付':raw['合计']?'合计':null;
  const amount=label?raw[label]:null;
  const labels=nodes.filter(n=>visible(n)&&text(n)===label);
  const values=nodes.filter(n=>visible(n)&&text(n)===amount);
  if (!label || !amount || labels.length!==1 || values.length!==1 ||
      Math.abs(labels[0]!.top-values[0]!.top)>Math.max(labels[0]!.height,values[0]!.height)*2 || values[0]!.left<labels[0]!.left) return null;
  return [labels[0]!,values[0]!];
}
