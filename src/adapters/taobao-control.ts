import type {U2Node} from './meituan-semantic.js';

export function selectTaobaoControl(nodes:U2Node[],input:{tag:string;brand:string;storeKeyword?:string;itemNode?:U2Node;bounds:{xMin:number;xMax:number;yMin:number;yMax:number}}):U2Node|null {
  const {tag,brand,storeKeyword,itemNode,bounds}=input;
  if (tag==='add-item' && (!itemNode || !nodes.some(n=>(n.text||n.desc)===(itemNode.text||itemNode.desc) && Math.abs(n.top-itemNode.top)<2 && Math.abs(n.left-itemNode.left)<2))) return null;
  const matches=nodes.filter(n=>{
    const label=(n.text || n.desc).trim(),x=n.left+n.width/2,y=n.top+n.height/2;
    let target=false;
    if(tag==='flash-tab') target=label==='闪购外卖' || label==='闪购,未选中' || label==='闪购，未选中';
    else if(tag==='searchbox' || tag==='shopsearch') target=/EditText$/.test(n.cls) || label==='搜一搜';
    else if(tag==='brand-search' || tag==='item-search') target=label==='搜索';
    else if(tag==='store' || tag==='store-2' || tag==='store-retry') target=!!brand && label.includes(brand) && /店[）)]?$/.test(label) && (!storeKeyword || label.includes(storeKeyword));
    else if(tag==='add-item') target=!!itemNode && /^(\+|＋|增加|加购)$/.test(label) && Math.abs(n.top-itemNode.top)<4*Math.max(n.height,itemNode.height);
    else if(tag==='addcart') target=label==='加入购物车';
    else if(tag==='checkout') target=label==='去结算';
    return n.width>0 && n.height>0 && target && x>=bounds.xMin && x<=bounds.xMax && y>=bounds.yMin && y<=bounds.yMax;
  });
  return matches.length===1?matches[0]!:null;
}
