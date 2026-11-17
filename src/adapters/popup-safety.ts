import type {U2Node} from './meituan-semantic.js';

/** A popup needs an explicit prompt and a unique labelled close control. */
export function popupCloseControl(nodes:U2Node[]):U2Node | 'unresolved' | null {
  const visible=nodes.filter(n=>n.width>0 && n.height>0);
  const label=(n:U2Node)=>(n.text || n.desc).trim();
  const prompts=visible.filter(n=>/^(立即领取|领取优惠券|恭喜获得优惠券|稍后再说|暂不升级)$/.test(label(n)));
  if (!prompts.length) return null;
  const candidates=visible.filter(n=>/^(关闭|关闭弹窗|关闭浮层|暂不领取|稍后再说|暂不升级|×|✕)$/.test(label(n)));
  // 首页可能同时展示多个分散的领券入口；没有关闭按钮且入口相距很远时，不把它们当作同一弹窗。
  if (!candidates.length && prompts.every(n=>/^(立即领取|领取优惠券)$/.test(label(n))) &&
      prompts.some((n,i)=>prompts.some((m,j)=>i!==j && Math.abs(n.top-m.top)>5*Math.max(n.height,m.height)))) return null;
  return candidates.length===1 ? candidates[0]! : 'unresolved';
}
