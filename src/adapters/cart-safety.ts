import type {U2Node} from './meituan-semantic.js';
import {nodeLabel} from './meituan-semantic.js';

const label=(node:U2Node)=>nodeLabel(node).replace(/\s+/g,'').trim();
const visible=(node:U2Node)=>node.width>0 && node.height>0;

/** Only explicit empty-cart labels establish the precondition for mutation. */
export function cartIsExplicitlyEmpty(nodes:U2Node[]):boolean {
  const labels=nodes.map(label);
  return nodes.some(node=>visible(node) && /^(购物车为空|购物车是空的|购物车空空如也|购物车0件)$/.test(label(node))) &&
    !labels.some(value=>/^(共[1-9]\d*件|[1-9]\d*件商品|购物车[1-9]\d*件)$/.test(value));
}

/**
 * 门店页底部购物车栏的空车判断：空车时显示“¥20起送”等起送文案，没有“到手约/共减/去结算”与商品件数。
 * 面板打开时仍以明确的空车标签为准；这是面板不可读时的补充判据，不能反过来覆盖明确空车标签。
 */
export function cartLooksEmpty(nodes:U2Node[]):boolean {
  if(cartIsExplicitlyEmpty(nodes))return true;
  const labels=nodes.map(label);
  const hasMinDelivery=labels.some(value=>/起送/.test(value));
  const hasCartContent=labels.some(value=>/到手约|共减|去结算|购物车.*[1-9]\d*件|已加购商品/.test(value));
  return hasMinDelivery && !hasCartContent;
}

/** Require a visible cart, one explicitly counted item and a unique matching minus control. */
export function ownedCartRemoveControl(nodes:U2Node[],item:string,spec:string):U2Node|null {
  const labels=nodes.map(label);
  if (!nodes.some(n=>visible(n) && /^购物车/.test(label(n))) || !nodes.some(n=>visible(n) && /^(共1件|1件商品|购物车1件)$/.test(label(n)))) return null;
  if (labels.some(v=>/^(共(?:[2-9]|[1-9]\d+)件|(?:[2-9]|[1-9]\d+)件商品|购物车(?:[2-9]|[1-9]\d+)件)$/.test(v))) return null;
  const expected=item.replace(/\s+/g,''), expectedSpec=spec.replace(/\s+/g,'');
  if (!expected || !expectedSpec) return null;
  const items=nodes.filter(n=>visible(n) && (label(n)===expected || label(n)===expected+expectedSpec));
  const specs=nodes.filter(n=>visible(n) && (label(n)===expectedSpec || label(n)===expected+expectedSpec));
  if (items.length!==1 || specs.length!==1) return null;
  const itemNode=items[0]!;
  const controls=nodes.filter(n=>/^(减少|减少一份|减少购买数量|−|－|-)$/.test(label(n)) && n.width>0 && n.height>0 && Math.abs((n.top+n.height/2)-(itemNode.top+itemNode.height/2))<Math.max(itemNode.height,n.height)*3);
  if (controls.length!==1) return null;
  const contains=(parent:U2Node,child:U2Node)=>parent.left<=child.left && parent.top<=child.top && parent.left+parent.width>=child.left+child.width && parent.top+parent.height>=child.top+child.height;
  const bounded=nodes.some(n=>n!==itemNode && n!==specs[0] && n!==controls[0] && n.width>0 && n.height>0 && n.height<=8*Math.max(itemNode.height,specs[0]!.height,controls[0]!.height) && contains(n,itemNode) && contains(n,specs[0]!) && contains(n,controls[0]!));
  return bounded ? controls[0]! : null;
}
