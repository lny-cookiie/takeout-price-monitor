import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { UiNode } from '@midscene/core';
import sharp from 'sharp';
import { CollectionError, type AttemptResult, type Evidence, type StepSink, type Task } from '../domain/contracts.js';
import { digest, normalize, specKey, type Supply } from '../domain/competition.js';
import { JD_SHELF_LIMIT, jdBrandKey, jdShelfSalesWindow, matchesJdBranch, matchesJdStore, parseJdSalesLabel, rankJdShelfItems, type JdRunInput, type JdShelfItem, type JdShelfResult, type JdShelfSelectedItem } from '../domain/jd-shelf.js';
import type { EvidenceStore } from '../infra/evidence.js';
import type { ModelGateway } from '../infra/model.js';
import { ReviewedScreen, resourceOf, textOf } from './android-collector.js';
import type { AndroidSource, JdShelfCalibration, ShelfField, ShelfLocator } from './android-source.js';
import { connectAndroid, type AndroidTransport } from './android-transport.js';
import { searchCropRegion, storeHeaderAnchor } from './jd-search-layout.js';

const maximumScrolls=20, scanTimeoutMs=120_000;
/** 页面文本比较前统一空白与全角符号，避免零宽空格、全角 & 与括号导致门店名匹配不上。 */
function normalizeKey(value:string):string {
  return value.replace(/[\s\u200b\u200c\u200d\ufeff]+/g,'').replace(/＆/g,'&').replace(/（/g,'(').replace(/）/g,')');
}
const unsafeText=/\b\d{11,}\b|收货地址|联系人|收货人|手机号|https?:|账号密码/;
const unsafeTap=/提交订单|确认支付|立即支付|去支付|支付订单|领取|开通会员|购买会员|去登录|同意并/;
const packageLabel=/套餐|组合餐|随心选|随心拼|[一二两三四五六七八九十1-9]人餐|[二三四五六七八九十2-9](?:件套|件任选|拼)/;
const platformKey=/^[A-Za-z0-9_.:-]{1,80}$/;
const classOf=(n:UiNode)=>n.attrs.class?.split('.').at(-1);
const flattened=(n:UiNode):UiNode[]=>[n,...n.children.flatMap(flattened)];
const scoped=(n:UiNode,source:AndroidSource)=>flattened(n).filter(v=>v.attrs.package===source.package && v.bounds.width>0 && v.bounds.height>0);
const validPublic=(s:string, max=200)=>s.length>0 && s.length<=max && !unsafeText.test(s);
const byPosition=(a:UiNode,b:UiNode)=>a.bounds.top-b.bounds.top || a.bounds.left-b.bounds.left;

function anchors(locator:ShelfLocator,nodes:UiNode[]) {
  return nodes.filter(n=>(!locator.resource || resourceOf(n)===locator.resource) &&
    (!locator.className || classOf(n)===locator.className) && (locator.text===undefined || textOf(n)===locator.text));
}

function oneAnchor(locator:ShelfLocator,nodes:UiNode[]) {
  const matches=anchors(locator,nodes);
  if (matches.length>1) throw new CollectionError('ambiguous_control','blocked');
  return matches[0];
}

function field(selector:ShelfField|undefined,nodes:UiNode[]) {
  if (!selector) return null;
  const matched=nodes.flatMap(node=>{
    if ((selector.resource && resourceOf(node)!==selector.resource) || (selector.className && classOf(node)!==selector.className)) return [];
    const label=textOf(node);
    if (!validPublic(label,300) || !label.startsWith(selector.prefix)) return [];
    let raw=label.slice(selector.prefix.length).trim();
    if (selector.endAt) {
      const end=raw.indexOf(selector.endAt);
      if (end<0) return [];
      raw=raw.slice(0,end).trim();
    }
    return validPublic(raw) ? [{raw,node}] : [];
  });
  return matched.length===1 ? matched[0]! : null;
}

async function stage<T>(emit:StepSink|undefined,phase:string,operation:()=>Promise<{value:T;data?:Record<string,unknown>;evidenceIds?:string[]}>) {
  emit?.({phase,state:'started'});
  let result:{value:T;data?:Record<string,unknown>;evidenceIds?:string[]};
  try { result=await operation(); }
  catch (e) {
    emit?.({phase,state:e instanceof CollectionError && e.status==='blocked' ? 'blocked':'failed',errorCode:e instanceof CollectionError ? e.code:'android_collection_failed'});
    throw e;
  }
  emit?.({phase,state:'succeeded',data:result.data,evidenceIds:result.evidenceIds});
  return result.value;
}

export function jdPopupClose(nodes:UiNode[]):UiNode | 'unresolved' | null {
  if (!nodes.some(node=>node.bounds.width>0 && node.bounds.height>0 && /^(立即领取|领取优惠券|恭喜获得优惠券|稍后再说|暂不升级)$/.test(textOf(node).trim()))) return null;
  const closes=nodes.filter(node=>node.bounds.width>0 && node.bounds.height>0 && /^(关闭|关闭弹窗|关闭浮层|暂不领取|稍后再说|暂不升级|×|✕)$/.test(textOf(node).trim()));
  return closes.length===1?closes[0]!:'unresolved';
}

async function waitFor<T>(screen:ReviewedScreen,signal:AbortSignal,select:(nodes:UiNode[])=>T|undefined) {
  const deadline=Date.now()+(screen.source.jdShelf?.pilot ? 20_000 : 12_000);
  let lastReadOutside=false;
  let dismissed=0;
  do {
    signal.throwIfAborted();
    let nodes:UiNode[]=[];
    try { nodes=await screen.nodes(); lastReadOutside=false; }
    catch(e){
      // Empty/foreign trees during a transition are retried. A persistent
      // wrong page ends as page_not_ready with the state budget exhausted.
      if (!(e instanceof CollectionError && e.code==='entry_mismatch')) throw e;
      lastReadOutside=true;
    }
    const close=jdPopupClose(nodes);
    if (close) {
      if (close==='unresolved' || ++dismissed>2) throw new CollectionError('popup_close_unverified','blocked');
      await tapNode(screen,close,signal);
      continue;
    }
    const found=select(nodes);
    if (found!==undefined) return found;
    await wait(230,undefined,{signal});
  } while(Date.now()<deadline);
  throw new CollectionError(lastReadOutside?'entry_mismatch':'page_not_ready');
}

async function tapNode(screen:ReviewedScreen,node:UiNode,signal:AbortSignal) {
  if (node.attrs.package!==screen.source.package || node.attrs.enabled==='false' || unsafeTap.test(textOf(node)))
    throw new CollectionError('action_not_allowed','blocked');
  const {left,top,width,height}=node.bounds, x=left+width/2,y=top+height/2;
  const size=await screen.device.size();
  if (x<=0 || y<=0 || x>=size.width || y>=size.height) throw new CollectionError('invalid_control_bounds');
  signal.throwIfAborted();
  await screen.device.tap(x,y);
  await wait(350,undefined,{signal});
}

function namesFor(input:JdRunInput,source:AndroidSource) {
  const names=[input.brand];
  for(const row of source.jdShelf?.brandAliases ?? []) {
    if ([row.brand,...row.aliases].some(name=>jdBrandKey(name)===jdBrandKey(input.brand))) names.push(row.brand,...row.aliases);
  }
  return [...new Set(names.map(normalize))].filter(Boolean);
}

function brandScore(value:string,names:string[]) {
  const text=normalize(value);
  return Math.max(0,...names.map(name=>{
    if (text===name) return 1;
    if (text.startsWith(name)) return .95;
    if (text.includes(name)) return .8;
    if (name.length<3) return 0;
    const prefix=text.slice(0,name.length+1);
    const grams=[...name].slice(0,-1).map((_,i)=>name.slice(i,i+2));
    return .78*grams.filter(gram=>prefix.includes(gram)).length/Math.max(1,grams.length);
  }));
}

function searchCandidates(screen:ReviewedScreen,cal:JdShelfCalibration,nodes:UiNode[],input:JdRunInput) {
  const root=oneAnchor(cal.searchResults,nodes);
  if (!root) return undefined;
  return anchors(cal.resultCard,scoped(root,screen.source)).sort(byPosition).flatMap((node,i)=>{
    const name=field(cal.resultName,scoped(node,screen.source));
    if (!name) return [];
    const score=brandScore(name.raw,namesFor(input,screen.source));
    return score>=.48 ? [{id:String(i+1),name:name.raw,score,exactBranch:matchesJdBranch(input,name.raw),node:name.node}] : [];
  }).sort((a,b)=>Number(b.exactBranch)-Number(a.exactBranch) || b.score-a.score || byPosition(a.node,b.node));
}

function modelOrder(value:unknown) {
  if (!value || typeof value!=='object' || !Array.isArray((value as {ids?:unknown}).ids)) throw new Error('invalid_brand_suggestion');
  return (value as {ids:unknown[]}).ids.filter((id):id is string=>typeof id==='string' && /^\d{1,3}$/.test(id)).slice(0,5);
}

export function pilotStoreHeader(anchor:UiNode, viewport:{width:number;height:number}) {
  // 统一委托到参数化的版式函数：默认窗口与历史实现一致，窗口可由配置覆盖。
  return storeHeaderAnchor(anchor.bounds, viewport) ?? undefined;
}
export function canReuseJdIdentity(input:JdRunInput,source:AndroidSource,title:string|null,at=Date.now()) {
  const cached=input.verifiedContext,age=cached?at-Date.parse(cached.evidence.captured_at):Infinity;
  return !!cached&&age>=0&&age<=30*60_000&&cached.sourceRevision===digest(source)&&title===cached.store.name&&matchesJdStore(input,cached.store,input.district);
}

function storeIdentity(screen:ReviewedScreen,cal:JdShelfCalibration,nodes:UiNode[],input:JdRunInput) {
  const root=oneAnchor(cal.identity,nodes);
  if (!root) return undefined;
  const local=scoped(root,screen.source);
  const name=field(cal.storeName,local), city=field(cal.city,local), address=field(cal.address,local), district=field(cal.district,local);
  const brand=field(cal.brand,local), id=field(cal.storeId,local);
  const key=id && platformKey.test(id.raw) ? id.raw : null;
  const reviewed=key && cal.reviewedStores?.find(s=>s.id===key);
  const identityNodes=[name,city,address,district,brand].flatMap(v=>v ? [v.node] : []);
  if (reviewed) {
    const store={key:reviewed.id,brand:reviewed.brand,name:reviewed.name,city:reviewed.city,address:reviewed.address};
    const comparison={...store,name:name?.raw ?? store.name,city:city?.raw ?? store.city,address:address?.raw ?? store.address,brand:brand?.raw ?? store.brand};
    if (!matchesJdStore(input,store,reviewed.district) || !matchesJdStore(input,comparison,district?.raw ?? reviewed.district))
      return {verified:false as const,reason:'store_identity_mismatch'};
    return {verified:true as const,store,district:reviewed.district,identityNodes:[...identityNodes,id!.node],method:'reviewed_store_id'};
  }
  if (!name || !city || !address) return {verified:false as const,reason:'store_identity_incomplete'};
  // The supplied brand remains a search key. A full observed branch, city and address are the store proof.
  const store={key:key ?? digest(['jd',normalize(city.raw),normalize(name.raw),normalize(address.raw)]),brand:brand?.raw ?? input.brand,
    name:name.raw,city:city.raw,address:address.raw};
  return matchesJdStore(input,store,district?.raw) ? {verified:true as const,store,district:district?.raw,identityNodes,method:'full_branch_address'} :
    {verified:false as const,reason:'store_identity_mismatch'};
}

export async function openJdStore(screen:ReviewedScreen,input:JdRunInput,attemptId:string,signal:AbortSignal,
  model:Pick<ModelGateway,'status'|'json'|'locate'>,evidenceStore:EvidenceStore,emit?:StepSink,reusePilotStore=false) {
  const configured=screen.source.jdShelf;
  if (!configured) throw new CollectionError('jd_shelf_not_configured','blocked');
  const cal=configured;
  const src=screen.source.selectors;
  const pilot=cal.pilot;
  const searchAnchor=(nodes:UiNode[])=>{
    if(!pilot?.resultAnchor)return undefined;
    const expected=pilot.resultAnchor;
    const ranking=/第\d+名/.test(expected)?new RegExp('^'+expected.split(/第\d+名/).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('第\\d+名')+'$'):null;
    const candidates=nodes.filter(n=>n.attrs.class?.endsWith('.Button')&&(textOf(n)===expected||ranking?.test(textOf(n))));
    return candidates.length===1?candidates[0]:undefined;
  };
  if (pilot && pilot.storeId!==input.savedStoreId) throw new CollectionError('jd_pilot_store_scope','blocked');
  // 搜索框只认品牌名（门店名会搜出错误结果），门店关键词用于模糊匹配展开列表里被截断的店名。
  const storeSearchQuery=pilot?.storeQuery ?? input.brand;
  const nameBracket=pilot ? /[（(]([^）)]+)[）)]/.exec(pilot.name)?.[1] : undefined;
  const storeKeyword=nameBracket ? normalizeKey(nameBracket).replace(/^天津/,'').slice(0,2) : undefined;
  // 门店级搜索可能直接落在门店页（ChannelSearchActivity），不一定有结果列表容器；只要搜索框内容匹配即可。
  const matchingQuery=(nodes:UiNode[])=>!!pilot && nodes.some(n=>resourceOf(n)===pilot.queryResource && normalizeKey(textOf(n)).includes(normalizeKey(storeSearchQuery)));
  const merchant={text:'商家，未选中',className:'TextView'};
  function merchantTab(ns:UiNode[],size:{width:number;height:number}) {
    const tab=screen.find(merchant,ns,false);
    if (!tab) return undefined;
    const {left,top,width,height}=tab.bounds;
    const x=(left+width/2)/size.width, y=(top+height/2)/size.height;
    // The pilot tab moves horizontally while the storefront finishes laying out.
    return x>=.47 && x<=.55 && y>=.11 && y<=.16 && height>=size.height*.035 ? tab : undefined;
  }
  function pilotIdentity(ns:UiNode[]) {
    // 用户确认同城门店价差很小，允许搜到品牌下的任意门店；门店名必读，地址读到就记录、读不到不阻断。
    const brand=normalizeKey(input.brand);
    const name=ns.find(node=>normalizeKey(textOf(node)).includes(brand) && /店[）)]?$/.test(textOf(node).trim()));
    if (!name) return undefined;
    const city=normalizeKey(input.city).replace(/市$/,'');
    const address=ns.find(node=>node!==name && city.length>0 && normalizeKey(textOf(node)).includes(city) && textOf(node).trim().length>input.city.length+2);
    if (!address) return undefined;
    const menu=screen.find({text:'外卖，未选中',className:'TextView'},ns,false);
    return {name,address,menu};
  }
  function pilotMenuIdentity(ns:UiNode[]) {
    const name=ns.find(node=>normalizeKey(textOf(node)).includes(normalizeKey(pilot!.name)));
    const address=ns.find(node=>normalizeKey(textOf(node)).includes(normalizeKey(pilot!.address)));
    const menu=screen.find({text:'外卖，已选中',className:'View'},ns,false);
    return name && address && menu ? {name,address,menu} : undefined;
  }
  function recentStore(ns:UiNode[]){
    const cached=input.verifiedContext;
    if(!cached||!canReuseJdIdentity(input,screen.source,screen.currentStoreTitle)||!screen.find({text:'外卖，已选中',className:'View'},ns,false)||!oneAnchor(cal.menu,ns))return undefined;
    return {value:{store:cached.store,district:input.district,nodes:ns,identityNodes:[] as UiNode[],evidence:cached.evidence},
      data:{store:cached.store.name,city:cached.store.city,method:'current_store_title_with_recent_address_evidence',reused:true,identityAgeMs:Date.now()-Date.parse(cached.evidence.captured_at)},evidenceIds:[cached.evidence.id]};
  }
  async function verifyPilotStore(details:UiNode|undefined,reused:boolean,visible?:ReturnType<typeof pilotIdentity>,onMenu=false,current?:UiNode[]) {
    return stage(emit,'store_verify',async()=>{
      // 门店页是小程序 WebView，u2 即时快照读不到内部节点；进入门店后切回 dump 通道。
      await screen.device.setTreeMode?.('dump').catch(()=>undefined);
      // 进店后常弹出优惠券/活动浮层挡住门店名与地址，先识别并关闭再核对身份。
      await wait(1_500,undefined,{signal});
      const probe=await screen.nodes().catch(()=>[] as UiNode[]);
      if (probe.some(node=>/好运券|去使用|满\d+可用/.test(textOf(node)))) {
        // 只点击唯一且明确标为关闭的控件，不能用猜测坐标关闭弹窗。
        const closes=probe.filter(node=>/^(关闭|关闭弹窗|关闭浮层|暂不领取|×|✕)$/.test(textOf(node).trim()) || /^(关闭|关闭弹窗|关闭浮层)$/.test(String(node.attrs['content-desc'] ?? '').trim()));
        if (closes.length!==1) throw new CollectionError('popup_close_unverified','blocked');
        await tapNode(screen,closes[0]!,signal);
        await wait(900,undefined,{signal});
        if ((await screen.nodes()).some(node=>/好运券|去使用|满\d+可用/.test(textOf(node)))) throw new CollectionError('popup_close_unverified','blocked');
      }
      let found=visible;
      if (!found) {
        const size=await screen.device.size();
        // A supplied node is only a hint. Store layout can move after entry.
        const destination=await waitFor(screen,signal,ns=>{
          const cached=recentStore(ns);if(cached)return {cached};
          if (src.dismissItemDetail && screen.selector('dismissItemDetail',ns,false)) throw new CollectionError('jd_search_opened_product','blocked');
          const tab=merchantTab(ns,size);return tab?{tab}:undefined;
        });
        if(destination.cached)return destination.cached;
        const reusedIdentity=await stage(emit,'store_address_open',async()=>{
          const fresh=await screen.nodes(true),cached=recentStore(fresh);
          if(cached)return {value:cached,data:{skipped:true,reason:'当前门店身份已与近期地址证据一致'}};
          const target=merchantTab(fresh,size);
          if(!target||screen.selector('add',fresh,false)||(src.dismissItemDetail&&screen.selector('dismissItemDetail',fresh,false)))throw new CollectionError('jd_merchant_tab_obstructed','blocked');
          await tapNode(screen,target,signal);
          return {value:undefined,data:{reason:input.verifiedContext?'当前门店身份无法复用，核对营业地址':'首次核对营业地址',target:'商家',relocated:true}};
        });
        if(reusedIdentity)return reusedIdentity;
        found=await waitFor(screen,signal,ns=>{
          if (src.dismissItemDetail && screen.selector('dismissItemDetail',ns,false)) throw new CollectionError('jd_merchant_tab_obstructed','blocked');
          return pilotIdentity(ns);
        });
      }
      // 用户确认同城门店价差很小：允许搜到品牌下任意门店，记录实际门店名与地址，不再按配置门店阻断。
      const store={key:digest(['jd',textOf(found.name),textOf(found.address)]),brand:input.brand,name:textOf(found.name),city:input.city,address:textOf(found.address)};
      const identityNodes=[found.name,found.address];
      const proof=await screen.capture(identityNodes);
      const evidence=await evidenceStore.save(randomUUID(),'store',proof.image,JSON.stringify({store,reference:pilot!.reference}),'live',proof.at);
      let nodes:UiNode[];
      const currentRoot=onMenu && current ? oneAnchor(cal.menu,current) : undefined;
      if (currentRoot && menuRows(screen,cal,currentRoot,store).cardCount) nodes=current!;
      else {
        // 商家页没有“外卖”tab 时用返回键回门店页，避免卡在商家信息页。
        if (!onMenu) { if (found.menu) await tapNode(screen,found.menu,signal); else await screen.device.back(); }
        const menu=await menuAt(screen,cal,signal,store);
        nodes=menu.nodes;
      }
      return {value:{store,district:input.district,nodes,identityNodes,evidence},data:{store:store.name,city:store.city,
        method:'verified_public_address',reused},evidenceIds:[evidence.id]};
    });
  }
  const isTakeoutHome=(ns:UiNode[])=>!!src.homePoint&&!!screen.selector('homePoint',ns,false)&&!!screen.selector('home',ns,false)&&!!screen.selector('search',ns,false);
  let homeEntry:UiNode[]|undefined, categoryEntry:UiNode[]|undefined, takeoutEntry:UiNode[]|undefined, searchEntry:UiNode[]|undefined;
  if (pilot && reusePilotStore) {
    let nodes=await screen.nodes().catch(error=>{
      if (error instanceof CollectionError && ['entry_mismatch','screen_unreadable'].includes(error.code)) return [];
      throw error;
    });
    if(src.itemDetail&&screen.selector('itemDetail',nodes,false)&&screen.selector('add',nodes,false)) {
      if(src.dismissItemDetail&&screen.selector('dismissItemDetail',nodes,false))await screen.tap('dismissItemDetail',nodes);
      else await screen.device.back();
      nodes=await screen.nodes();
    }
    const cached=recentStore(nodes);if(cached)return stage(emit,'store_verify',async()=>cached);
    const onMenu=pilotMenuIdentity(nodes);
    if (onMenu) return verifyPilotStore(undefined,true,onMenu,true,nodes);
    const visible=pilotIdentity(nodes);
    // 只有确实在门店页（有门店购物车入口）才复用，避免把结算页/详情页当成门店页。
    if (visible && screen.selector('cart',nodes,false)) return verifyPilotStore(undefined,true,visible);
    if (screen.find(merchant,nodes,false)) {
      const details=merchantTab(nodes,await screen.device.size());
      if (details) return verifyPilotStore(details,true);
    }
    if (pilot.resultAnchor && matchingQuery(nodes) && searchAnchor(nodes)) searchEntry=nodes;
    else if(isTakeoutHome(nodes))takeoutEntry=nodes;
    else if (src.channel && screen.selector('channel',nodes,false)) homeEntry=nodes;
    else if(src.entryCategory&&screen.selector('entryCategory',nodes,false))categoryEntry=nodes;
  }
  const initial=searchEntry ? [] : await stage(emit,'launch',async()=>{
    if(takeoutEntry)return {value:takeoutEntry,data:{reusedHome:true,entryState:'takeout_home',entryActions:[]}};
    // 京东会恢复上次停留的页面（真机遇到过停在搜索页）：直接 launch 只会把旧页面带回前台，
    // 导致首页等待超时并报 page_not_ready。先按返回键退回首页，再重新拉起。
    if (!homeEntry&&!categoryEntry){
      for (let i=0;i<3;i++) {
        await screen.device.back().catch(()=>null);
        await wait(600,undefined,{signal});
        const probe=await screen.nodes(true).catch(()=>[] as UiNode[]);
        if (isTakeoutHome(probe)||screen.selector('home',probe,false)||screen.selector('channel',probe,false)) break;
      }
    }
    if (!homeEntry&&!categoryEntry) await screen.device.launch(Boolean(pilot));
    const actions:string[]=[];
    if(src.channel||src.entryCategory){
      let current=homeEntry??categoryEntry??await waitFor(screen,signal,ns=>isTakeoutHome(ns)||(src.channel&&screen.selector('channel',ns,false))||(src.entryCategory&&screen.selector('entryCategory',ns,false))?ns:undefined);
      if(!isTakeoutHome(current)&&src.channel&&screen.selector('channel',current,false)){
        await screen.tap('channel',current);actions.push('channel');
        current=await waitFor(screen,signal,ns=>isTakeoutHome(ns)||(src.entryCategory&&screen.selector('entryCategory',ns,false))?ns:undefined);
      }
      if(!isTakeoutHome(current)&&src.entryCategory&&screen.selector('entryCategory',current,false)){
        await screen.tap('entryCategory',current);actions.push('entryCategory');
      }
    }
    // u2 读首页时控件 class 可能与配置不同；任一首页特征出现即视为就绪，避免死等单一控件。
    const probe=await screen.nodes(true).catch(()=>[] as UiNode[]);
    const alreadyReady=screen.selector('home',probe,false)||screen.selector('homePoint',probe,false)||screen.selector('point',probe,false);
    const ready=alreadyReady ? probe : await screen.waitFor([src.channel?'channel':'home'],{onLaunch:true,timeoutMs:20_000}).catch(async()=>{
      const probe=await screen.nodes(true).catch(()=>[] as UiNode[]);
      if (screen.selector('home',probe,false)||screen.selector('homePoint',probe,false)||screen.selector('point',probe,false)) return probe;
      return await screen.waitFor(['home'],{onLaunch:true,timeoutMs:10_000});
    });
    return {value:ready,data:{reusedHome:!!(homeEntry||categoryEntry),entryActions:actions}};
  });
  const candidates=searchEntry ? [] : await stage(emit,'brand_search',async()=>{
    // 首页/频道页切换瞬间搜索框可能还没渲染，先等控件出现再点，避免 control_missing。
    await screen.tap('search',await screen.waitFor(['search'],{timeoutMs:8_000}));
    const inputNodes=await screen.waitFor(['searchInput']);
    await screen.tap('searchInput',inputNodes);
    // 输入品牌名后直接回车提交：页面上的“搜索”按钮 className 与配置不一致，点按钮会等待超时。
    await screen.device.search(storeSearchQuery,signal,true);
    // 部分版本回车不提交，页面仍停在搜索建议页；此时点右上角“搜索”按钮。
    await wait(900,undefined,{signal});
    const stillSuggest=await screen.nodes(true).catch(()=>[] as UiNode[]);
    if (stillSuggest.some(node=>/搜索发现|换一批|约\d+个结果/.test(textOf(node)))) {
      const viewport=await screen.device.size();
      await screen.device.tap(viewport.width*.88,viewport.height*.076);
      await wait(900,undefined,{signal});
    }
    if (cal.pilot) return {value:[],data:{query:input.brand}};
    const found=await waitFor(screen,signal,ns=>searchCandidates(screen,cal,ns,input));
    if (!found.length) throw new CollectionError('brand_candidates_missing');
    const fullMatches=found.filter(c=>c.exactBranch);
    if (!input.businessAddress && !input.verifiedStoreKey && fullMatches.length>1) throw new CollectionError('jd_saved_store_ambiguous','blocked');
    const considered=(fullMatches.length ? fullMatches : found).slice(0,5);
    return {value:considered,data:{query:input.brand,candidateCount:found.length,candidates:considered.map(c=>({id:c.id,name:c.name,score:c.score}))}};
  });
  if (pilot) {
    await stage(emit,'brand_model_match',async()=>{
      // 搜索结果页用 u2 即时快照（实测可读到 156 个文本含门店名，比 dump 快约 10 倍）；门店详情的 WebView 再切 dump。
      await screen.device.setTreeMode?.('u2').catch(()=>undefined);
      const device=await screen.device.size();
      const results=()=>waitFor(screen,signal,ns=>{
        if (!matchingQuery(ns)) return undefined;
        // 搜索结果页加载中只有搜索框和少量节点；等门店卡片真正渲染（排除顶部搜索框）再匹配。
        const cardVisible=ns.some(node=>{
          const label=normalizeKey(textOf(node));
          return (label.includes('麦当劳')||label.includes('麦咖啡'))&&node.bounds.width>0&&node.bounds.height>0&&node.bounds.top>device.height*.08;
        });
        if (!cardVisible) return undefined;
        return !pilot.resultAnchor || searchAnchor(ns) ? ns : undefined;
      });
      // searchEntry 可能是刚提交搜索、结果尚未渲染的页面；这里始终等结果卡片真正出现再匹配。
      let nodes=await results();
      const anchor=pilot.resultAnchor ? searchAnchor(nodes) : undefined;
      const header=anchor ? pilotStoreHeader(anchor,device) : undefined;
      if (anchor && !header) throw new CollectionError('jd_search_layout_changed','blocked');
      const screenshot=await screen.device.screenshot(signal);
      const {width,height}=await sharp(screenshot).metadata();
      if (anchor && header) {
        const top=Math.floor((header.y-device.height*.018)*height/device.height);
        const bottom=Math.ceil((anchor.bounds.top+anchor.bounds.height)*height/device.height);
        const area=await sharp(screenshot).extract({left:0,top,width,height:bottom-top}).resize(640).png().toBuffer();
        const proof=await evidenceStore.save(randomUUID(),'jd_search',area,input.brand,'live');
        signal.throwIfAborted();
        await screen.device.tap(header.x,header.y);
        return {value:null,data:{query:input.brand,method:'reviewed_store_header',reusedSearch:!!searchEntry},evidenceIds:[proof.id]};
      }
      // 搜索结果页可能先显示品牌聚合卡（只显示品牌名，没有门店名）；点“查看该商家更多门店”展开后才出现门店列表。
      const moreEntry=nodes.find(node=>textOf(node).includes('查看该商家更多门店')&&node.bounds.width>0&&node.bounds.height>0);
      if (moreEntry) {
        await tapNode(screen,moreEntry,signal);
        await wait(1_200,undefined,{signal});
        nodes=await screen.nodes(true);
      }
      // 同城门店价差很小（用户确认），搜索结果页点品牌对应的任意门店即可，不再要求精确店名。
      const fullKey=normalizeKey(pilot.name);
      const fuzzyKey=normalizeKey(input.brand);
      const findCard=(list:UiNode[])=>list.filter(node=>{
        const label=normalizeKey(textOf(node));
        // 排除顶部搜索框里的同名文本（top 小于 8% 屏高），只认真正的门店卡片。
        return label.length>=2 && label.includes(fuzzyKey) && node.bounds.width>0 && node.bounds.height>0 && node.bounds.top>device.height*.08;
      }).sort((a,b)=>b.bounds.top-a.bounds.top)[0];
      let textNode=findCard(nodes);
      if (!textNode) {
        // 目标门店可能不在首屏，滚动一屏再找一次。
        await screen.device.swipe?.({x:device.width/2,y:device.height*.78},{x:device.width/2,y:device.height*.32},signal);
        await wait(900,undefined,{signal});
        nodes=await screen.nodes(true);
        textNode=findCard(nodes);
      }
      if (!textNode) {
        const visible=nodes.filter(node=>normalizeKey(textOf(node)).includes('麦当劳')).slice(0,6).map(node=>textOf(node).slice(0,24));
        emit?.({phase:'brand_model_match',state:'started',data:{storeNotFound:true,visible,total:nodes.length}});
        throw new CollectionError('store_not_found','blocked');
      }
      {
        // 文本节点可能是顶部品牌栏或结果卡片标题；找包含它的可点击容器（真卡片）再点，避免点文字不跳转。
        const cx=textNode.bounds.left+textNode.bounds.width/2, cy=textNode.bounds.top+textNode.bounds.height/2;
        const containers=nodes.filter(node=>
          node.attrs.clickable==='true' &&
          node.bounds.width>device.width*.5 && node.bounds.height>40 &&
          node.bounds.left<=cx && cx<=node.bounds.left+node.bounds.width &&
          node.bounds.top<=cy && cy<=node.bounds.top+node.bounds.height
        ).sort((a,b)=>b.bounds.top-a.bounds.top);
        const target=containers[0]??textNode;
        // 树匹配后直接截整屏作为证据，不再走 capture 的「重读屏对齐节点」，避免页面刷新导致对齐失败。
        const frame=await screen.device.screenshot(signal);
        const treeProof=await evidenceStore.save(randomUUID(),'jd_search',frame,textOf(target),'live');
        signal.throwIfAborted();
        await tapNode(screen,target,signal);
        return {value:null,data:{query:input.brand,method:'tree_store_match',targetTop:Math.round(target.bounds.top),container:target!==textNode},evidenceIds:[treeProof.id]};
      }
      // 容器裁剪在 u2 读屏下会改变模型输入区域，先回退到基线固定比例，等真机验收后再启用（P0-2）。
      const top=Math.round(height*.17);
      const cropHeight=Math.round(height*.55);
      const area=await sharp(screenshot).extract({left:0,top,width,height:cropHeight}).resize(640).png().toBuffer();
      const dimensions=await sharp(area).metadata();
      const proof=await evidenceStore.save(randomUUID(),'jd_search',area,input.brand,'live');
      const [x,y]=await model.locate(attemptId,area,pilot!.resultLabel,signal,[proof.id]);
      if (!(x>dimensions.width*.25 && x<dimensions.width*.83 && y>dimensions.height*.03 && y<dimensions.height*.15) ||
          !matchingQuery(await screen.nodes())) throw new CollectionError('model_location_mismatch');
      signal.throwIfAborted();
      await screen.device.tap(device.width*x/dimensions.width,device.height*top/height+device.width*y/dimensions.width);
      return {value:null,data:{query:input.brand},evidenceIds:[proof.id]};
    });
    return verifyPilotStore(undefined,false);
  }
  if (candidates.length>1 && model.status.configured) {
    let order:string[]=[];
    emit?.({phase:'brand_model_match',state:'started'});
    try {
      order=await model.json(attemptId,'jd_brand_candidates','按品牌和完整分店名排序已提供的候选编号。只输出 {"ids":["1"]}。该建议不确认门店身份。',
        {brand:input.brand,branch:input.storeName,candidates:candidates.map(c=>({id:c.id,name:c.name}))},modelOrder,{signal});
    } catch {
      signal.throwIfAborted();
      emit?.({phase:'brand_model_match',state:'failed',errorCode:'model_brand_match_failed'});
    }
    if (order.length) {
      const positions=new Map(order.map((id,i)=>[id,i]));
      candidates.sort((a,b)=>(positions.get(a.id) ?? 999)-(positions.get(b.id) ?? 999));
      emit?.({phase:'brand_model_match',state:'succeeded',data:{candidateOrder:candidates.map(c=>c.id)}});
    }
  }
  return stage(emit,'store_verify',async()=>{
    let rejectedCount=0;
    for (const candidate of candidates) {
      const current=await waitFor(screen,signal,ns=>searchCandidates(screen,cal,ns,input));
      const matches=current.filter(c=>c.name===candidate.name);
      const selected=matches.length===1 ? matches[0] : matches.find(c=>c.id===candidate.id);
      emit?.({phase:'store_candidate',state:'started',data:{candidate:candidate.name}});
      if (!selected) {
        emit?.({phase:'store_candidate',state:'skipped',errorCode:'store_candidate_changed',data:{candidate:candidate.name}});
        rejectedCount++;
        continue;
      }
      await tapNode(screen,selected.node,signal);
      let inspected:{nodes:UiNode[];checked:NonNullable<ReturnType<typeof storeIdentity>>}|undefined;
      try {
        inspected=await waitFor(screen,signal,ns=>{
          const checked=storeIdentity(screen,cal,ns,input);
          return checked===undefined ? undefined : {nodes:ns,checked};
        });
      } catch(e) {
        if (!(e instanceof CollectionError && ['screen_changed','page_not_ready'].includes(e.code))) throw e;
      }
      if (inspected?.checked.verified) {
        const {store,district,identityNodes,method}=inspected.checked;
        const proof=await screen.capture([...new Set(identityNodes)]);
        const evidence=await evidenceStore.save(randomUUID(),'store',proof.image,JSON.stringify({store,district,method}),'live',proof.at);
        emit?.({phase:'store_candidate',state:'succeeded',data:{candidate:candidate.name,method},evidenceIds:[evidence.id]});
        return {value:{store,district,nodes:inspected.nodes,identityNodes,evidence},data:{store:store.name,city:store.city,method,rejectedCount},evidenceIds:[evidence.id]};
      }
      emit?.({phase:'store_candidate',state:'blocked',errorCode:inspected?.checked.reason ?? 'store_identity_incomplete',data:{candidate:candidate.name}});
      rejectedCount++;
      const now=await screen.nodes();
      if (!oneAnchor(cal.searchResults,now)) {
        signal.throwIfAborted();
        await screen.device.back();
      }
    }
    throw new CollectionError('store_identity_mismatch','blocked');
  });
}

function productOptions(raw:string|undefined): string[]|null {
  if (!raw) return null;
  if (['无','无可选项','无额外选项'].includes(raw)) return [];
  const options=raw.split(/[、，,]/).map(v=>v.trim()).filter(Boolean);
  return options.length>0 && options.length<=20 && options.every(v=>validPublic(v,100)) ? options : null;
}

export function menuRows(screen:ReviewedScreen,cal:JdShelfCalibration,root:UiNode,store:Supply['store']) {
  if (cal.pilot) {
    const pilot=cal.pilot;
    const singles=pilot.singles?.length ? pilot.singles : [{name:pilot.singleName,spec:pilot.singleSpec,options:[]}];
    const byName=new Map(singles.map(single=>[normalize(single.name),single]));
    const auto=pilot.autoSingles===true;
    const found=scoped(root,screen.source).flatMap(node=>{
      const raw=textOf(node), match=/^([^，,]+)[，,]((?:已售|月售)\s*[^，,]+)/.exec(raw);
      if (!match?.[1] || !validPublic(raw,160) || node.bounds.height<8 || node.bounds.width<35 ||
          node.bounds.top+node.bounds.height>root.bounds.top+root.bounds.height*.89) return [];
      const rawName=match[1].trim(), salesRaw=match[2]!.trim(), single=byName.get(normalize(rawName)), packageItem=packageLabel.test(rawName);
      const kind=single ? 'single' : auto && !packageItem ? 'single' : packageItem ? 'set' : 'unknown';
      const spec=single?.spec ?? null, options=single?.options ?? [];
      const key=digest([store.key,normalize(rawName),kind,specKey(spec ?? ''),JSON.stringify(options.map(specKey).sort())]);
      const supply:Supply|undefined=single ? {store,item:{key,name:rawName,kind:'single',spec:single.spec,options,parts:null}} : undefined;
      return [{card:node,nodes:[node],evidenceNodes:[node],snapshot:{key,rawName,kind,spec,sales:parseJdSalesLabel(salesRaw),salesRaw,
        excludedReason:kind==='set' ? 'package_excluded' : kind==='unknown' ? 'product_kind_unknown' : null,supply} satisfies Omit<JdShelfItem,'position'|'evidence'>}];
    });
    const rows=found.filter((row,i)=>found.findIndex(candidate=>candidate.snapshot.key===row.snapshot.key)===i).sort((a,b)=>byPosition(a.card,b.card));
    return {cardCount:rows.length,rows};
  }
  const cards=anchors(cal.itemCard,scoped(root,screen.source)).sort(byPosition);
  return {cardCount:cards.length,rows:cards.flatMap(card=>{
    const nodes=scoped(card,screen.source);
    const name=field(cal.itemName,nodes);
    if (!name) return [];
    const kind=field(cal.itemKind,nodes), spec=field(cal.itemSpec,nodes), options=field(cal.itemOptions,nodes), id=field(cal.itemId,nodes);
    const sales=field(cal.sales,nodes), salesRaw=sales?.raw.slice(0,120) ?? null;
    const label=packageLabel.test(name.raw) || (kind && ['套餐','组合套餐'].includes(kind.raw)) ? 'set' : kind?.raw==='单品' ? 'single':'unknown';
    const chosen=productOptions(options?.raw), sale=sales && sales.raw===salesRaw ? parseJdSalesLabel(sales.raw) : null;
    const key=digest([store.key,id && platformKey.test(id.raw) ? id.raw : normalize(name.raw),label,specKey(spec?.raw ?? ''),chosen?.map(specKey).sort()]);
    const excludedReason=label==='set' ? 'package_excluded' : label==='unknown' ? 'product_kind_unknown' : !spec || chosen===null ? 'product_spec_unknown' : null;
    const supply:Supply|undefined=excludedReason ? undefined : {store,item:{key,name:name.raw,kind:'single',spec:spec!.raw,options:chosen,parts:null}};
    return [{card,nodes,snapshot:{key,rawName:name.raw,kind:label,spec:spec?.raw ?? null,sales:sale,salesRaw,excludedReason,supply} satisfies Omit<JdShelfItem,'position'|'evidence'>,
      evidenceNodes:[name,kind,spec,options,sales].flatMap(v=>v ? [v.node] : [])}];
  })};
}

async function swipeMenu(screen:ReviewedScreen,root:UiNode,signal:AbortSignal) {
  if (!screen.device.swipe) throw new CollectionError('shelf_swipe_unavailable','blocked');
  const size=await screen.device.size();
  const left=Math.max(0,root.bounds.left),right=Math.min(size.width,root.bounds.left+root.bounds.width);
  const top=Math.max(0,root.bounds.top),bottom=Math.min(size.height,root.bounds.top+root.bounds.height);
  if (right-left<50 || bottom-top<120) throw new CollectionError('invalid_control_bounds');
  const x=Math.round(left+(right-left)*.75);
  const from={x,y:Math.round(top+(bottom-top)*.8)},to={x,y:Math.round(top+(bottom-top)*.28)};
  signal.throwIfAborted();
  await screen.device.swipe(from,to,signal);
  await wait(450,undefined,{signal});
}

function menuAt(screen:ReviewedScreen,cal:JdShelfCalibration,signal:AbortSignal,store?:Supply['store']) {
  return waitFor(screen,signal,nodes=>{
    const root=oneAnchor(cal.menu,nodes);
    return root && (!store || menuRows(screen,cal,root,store).cardCount>0) ? {root,nodes} : undefined;
  });
}

async function selectPilotCategory(screen:ReviewedScreen,signal:AbortSignal) {
  const selector=screen.source.selectors.category;
  if (!selector) return;
  const selectedText=selector.text.replace(/未选中$/,'已选中');
  const result=await waitFor(screen,signal,nodes=>{
    if (selectedText!==selector.text && nodes.some(n=>textOf(n)===selectedText && n.bounds.left<20))
      return {nodes,change:false};
    return screen.selector('category',nodes,false) ? {nodes,change:true} : undefined;
  });
  if (result.change) await screen.tap('category',result.nodes);
}

export async function returnToJdMenu(screen:ReviewedScreen,signal:AbortSignal):Promise<void> {
  const cal=screen.source.jdShelf;
  if (!cal) return;
  const cleanupSignal=AbortSignal.any([signal,AbortSignal.timeout(8_000)]);
  const nodes=await screen.nodes().catch(()=>[] as UiNode[]);
  // Only the open cart panel needs a back press; an empty-cart label on the menu bar does not.
  const panel=screen.source.selectors.cartPanel ? screen.cartNodes(nodes,false) : null;
  if (panel) {
    await screen.device.back();
    await wait(400,undefined,{signal:cleanupSignal});
  }
  try { await menuAt(screen,cal,cleanupSignal); return; } catch { /* try the category tab below */ }
  await selectPilotCategory(screen,cleanupSignal);
  await menuAt(screen,cal,cleanupSignal);
}

function pageOverlap(previous:string[],current:string[]) {
  for (let size=Math.min(previous.length,current.length);size>0;size--) {
    if (current.slice(0,size).every((key,i)=>previous[previous.length-size+i]===key)) return size;
  }
  return 0;
}

async function scanMenu(screen:ReviewedScreen,cal:JdShelfCalibration,store:Supply['store'],signal:AbortSignal,evidenceStore:EvidenceStore,budgetMs:number) {
  const rows=new Map<string,JdShelfItem>(), seenPages=new Set<string>();
  const timer=AbortSignal.timeout(budgetMs), scanSignal=AbortSignal.any([signal,timer]);
  let previous:string[]=[],unreadableCount=0,pageCount=0,ordered=Boolean(cal.salesOrder),continuous=true;
  let stopReason='scroll_limit', coverage:JdShelfResult['coverage']='partial';
  const pilotTarget=cal.pilot ? (cal.pilot.autoSingles ? Number.POSITIVE_INFINITY : Math.min(JD_SHELF_LIMIT,cal.pilot.singles?.length ?? 1)) : JD_SHELF_LIMIT;
  try {
    for(let scrolls=0;scrolls<=maximumScrolls;scrolls++) {
      scanSignal.throwIfAborted();
      const before=cal.pilot ? await screen.device.screenshot(scanSignal).catch(()=>undefined) : undefined;
      const {root,nodes}=await menuAt(screen,cal,scanSignal);
      const page=menuRows(screen,cal,root,store);
      if (!page.cardCount) throw new CollectionError('shelf_unreadable');
      const order=cal.salesOrder && oneAnchor(cal.salesOrder,nodes);
      const end=cal.end && oneAnchor(cal.end,scoped(root,screen.source));
      const keys=page.rows.map(row=>row.snapshot.key), fingerprint=digest([keys,page.cardCount,Boolean(end)]);
      if (seenPages.has(fingerprint)) { stopReason='shelf_repeat'; break; }
      seenPages.add(fingerprint);
      ordered &&= Boolean(order);
      const overlap=pageOverlap(previous,keys);
      if (pageCount>0 && overlap===0) continuous=false;
      const novel=page.rows.slice(overlap);
      const proofNodes=[...new Set([...novel.flatMap(v=>v.evidenceNodes),...(order ? [order] : []),...(end ? [end] : [])])];
      if (proofNodes.length) {
        const proof=await screen.capture(proofNodes,{before,signal:scanSignal});
        const evidence=await evidenceStore.save(randomUUID(),'jd_shelf',proof.image,
          JSON.stringify({page:pageCount+1,items:novel.map(v=>({name:v.snapshot.rawName,spec:v.snapshot.spec,sales:v.snapshot.salesRaw})),
            ...(order ? {salesOrder:textOf(order)} : {}),...(end ? {end:textOf(end)} : {})}),'live',proof.at);
        for (const v of novel) {
          const duplicate=rows.get(v.snapshot.key);
          if (duplicate) {
            duplicate.excludedReason='duplicate_product_identity';
            duplicate.supply=undefined;
            continue;
          }
          rows.set(v.snapshot.key,{...v.snapshot,position:rows.size+1,evidence});
        }
      }
      unreadableCount+=page.cardCount-page.rows.length;
      pageCount++;
      previous=keys;
      if (cal.pilot && rankJdShelfItems([...rows.values()],'partial').length>=pilotTarget) { stopReason='pilot_items_found';break; }
      if (ordered && continuous && unreadableCount===0 && rankJdShelfItems([...rows.values()],'sales_order').length>=5) {
        coverage='sales_order';stopReason='sales_order_top5';break;
      }
      if (end) {
        coverage=unreadableCount>0 || !continuous ? 'partial' : ordered ? 'sales_order':'complete';
        stopReason=unreadableCount>0 ? 'unreadable_cards' : !continuous ? 'shelf_coverage_gap' : 'shelf_end';break;
      }
      if (scrolls===maximumScrolls) break;
      await swipeMenu(screen,root,scanSignal);
    }
  } catch(e) {
    if (timer.aborted && !signal.aborted) stopReason='scan_timeout';
    else if (rows.size && e instanceof CollectionError && ['page_not_ready','screen_unreadable','page_changed_during_capture','evidence_capture_failed'].includes(e.code)) {
      stopReason=e.code;
    } else throw e;
  }
  signal.throwIfAborted();
  if (!rows.size) throw new CollectionError('shelf_unreadable');
  return {items:[...rows.values()],coverage,scannedCount:rows.size+unreadableCount,stopReason,pageCount,unreadableCount};
}

export async function findJdMenuItem(screen:ReviewedScreen,store:Supply['store'],target:Supply['item'],signal:AbortSignal):Promise<void> {
  console.error('[diag] findJdMenuItem enter, menuSearch=',!!screen.source.selectors.menuSearch,'piloted=',!!screen.source.jdShelf?.pilot);
  const cal=screen.source.jdShelf;
  if (!cal || target.kind!=='single' || !target.spec || target.options===null) throw new CollectionError('variant_controls_unverified','blocked');
  // 优先店内搜索：滚动解析整份菜单要 100 秒以上，搜索一次就能直接定位单品。
  if (cal.pilot && screen.source.selectors.menuSearch) {
    try {
      console.error('[diag] store-search: start');
      const entry=await screen.waitFor(['menuSearch'],{timeoutMs:6_000});
      await screen.tap('menuSearch',entry);
      await wait(800,undefined,{signal});
      await screen.device.search(target.name,signal,true);
      await wait(1_500,undefined,{signal});
      const results=await screen.nodes(true).catch(()=>[] as UiNode[]);
      // SKU 精准匹配：排除套餐/组合等变体，优先商品名与目标完全一致（“板烧鸡腿堡”不能选成“双层板烧鸡腿堡套餐”）。
      const targetKey=normalizeKey(target.name);
      const pool=results.filter(node=>{
        const label=normalizeKey(textOf(node));
        if (!(node.bounds.width>0&&node.bounds.height>0)) return false;
        if (/(套餐|三件套|四件套|双人餐|多人餐|组合|欢乐送|家庭餐)/.test(label)) return false;
        return label.includes(targetKey);
      });
      const exact=pool.find(node=>normalizeKey(textOf(node)).split(/[，,]/)[0]===targetKey);
      const hit=exact??pool.sort((a,b)=>b.bounds.top-a.bounds.top)[0];
      console.error('[diag] store-search: results',results.length,'pool',pool.length,'exact',!!exact,'hit',!!hit);
      if (hit) {
        await tapNode(screen,hit,signal);
        // 商品详情弹窗是原生渲染，u2 能读规格与加入购物车。
        await screen.device.setTreeMode?.('u2').catch((e)=>console.error('[diag] store-search: u2 switch failed',String(e).slice(0,100)));
        await wait(800,undefined,{signal});
        return;
      }
    } catch (e) { console.error('[diag] store-search failed',String(e).slice(0,140)); }
  }
  const seen=new Set<string>(), scanSignal=AbortSignal.any([signal,AbortSignal.timeout(35_000)]);
  if (cal.pilot && screen.source.selectors.category) await selectPilotCategory(screen,signal);
  const options=JSON.stringify(target.options.map(specKey).sort());
  const search=async(direction:'down'|'up')=>{
    seen.clear();
    for(let scrolls=0;scrolls<=6;scrolls++) {
      const {root}=await menuAt(screen,cal,scanSignal);
      // Exact target lookup does not depend on a sales label or shelf rank.
      if(cal.pilot) {
        const candidates=scoped(root,screen.source).filter(n=>{
          const name=textOf(n).split(/[，,]/)[0]?.trim()??'';
          return normalize(name)===normalize(target.name)&&!packageLabel.test(name)&&n.bounds.width>35&&n.bounds.height>8&&
            n.bounds.top+n.bounds.height<=root.bounds.top+root.bounds.height*.89;
        }).filter(n=>!n.children.some(c=>normalize(textOf(c).split(/[，,]/)[0]??'')===normalize(target.name)));
        if(candidates.length>1)throw new CollectionError('ambiguous_control','blocked');
        if(candidates.length===1){
          await tapNode(screen,candidates[0]!,scanSignal);
          // 商品详情弹窗是原生渲染，u2 能读规格与“加入购物车”；dump 在详情页会整次超时。
          await screen.device.setTreeMode?.('u2').catch(()=>undefined);
          await wait(600,undefined,{signal});
          return true;
        }
      }
      const {rows}=menuRows(screen,cal,root,store);
      const matching=rows.filter(v=>{
        if (v.snapshot.kind!=='single' || normalize(v.snapshot.rawName)!==normalize(target.name)) return false;
        if (v.snapshot.spec && specKey(v.snapshot.spec)!==specKey(target.spec)) return false;
        if (v.snapshot.supply?.item.options && JSON.stringify(v.snapshot.supply.item.options.map(specKey).sort())!==options) return false;
        return true;
      });
      if (matching.length>1) throw new CollectionError('ambiguous_control','blocked');
      if (matching.length===1) {
        if (cal.pilot) await tapNode(screen,matching[0]!.card,signal);
        else await screen.tap('item',matching[0]!.nodes);
        return true;
      }
      const fingerprint=digest(rows.map(v=>v.snapshot.key));
      if (seen.has(fingerprint) || scrolls===6 || (direction==='down' && cal.end && oneAnchor(cal.end,scoped(root,screen.source)))) break;
      seen.add(fingerprint);
      if (direction==='down') await swipeMenu(screen,root,scanSignal); else await swipeMenuDown(screen,root,scanSignal);
    }
    return false;
  };
  try {
    if (await search('down')) return;
    if (await search('up')) return;
  } catch(error) {
    if(scanSignal.aborted&&!signal.aborted)throw new CollectionError('jd_single_item_search_timeout');
    throw error;
  }
  throw new CollectionError('jd_single_item_not_found');
}

async function swipeMenuDown(screen:ReviewedScreen,root:UiNode,signal:AbortSignal) {
  if (!screen.device.swipe) throw new CollectionError('shelf_swipe_unavailable','blocked');
  const size=await screen.device.size();
  const left=Math.max(0,root.bounds.left),right=Math.min(size.width,root.bounds.left+root.bounds.width);
  const top=Math.max(0,root.bounds.top),bottom=Math.min(size.height,root.bounds.top+root.bounds.height);
  if (right-left<50 || bottom-top<120) throw new CollectionError('invalid_control_bounds');
  const x=Math.round(left+(right-left)*.75);
  signal.throwIfAborted();
  await screen.device.swipe({x,y:Math.round(top+(bottom-top)*.28)},{x,y:Math.round(top+(bottom-top)*.8)},signal);
  await wait(450,undefined,{signal});
}

async function findJdMenuItemByName(screen:ReviewedScreen,store:Supply['store'],name:string,signal:AbortSignal,preferred:'up'|'down'):Promise<void> {
  const cal=screen.source.jdShelf;
  if (!cal) throw new CollectionError('jd_shelf_not_configured','blocked');
  const seen=new Set<string>();
  for (const direction of [preferred,preferred==='up' ? 'down' : 'up'] as const) {
    seen.clear();
    for (let scrolls=0;scrolls<=maximumScrolls;scrolls++) {
      const {root}=await menuAt(screen,cal,signal);
      const {rows}=menuRows(screen,cal,root,store);
      const matching=rows.filter(v=>v.snapshot.kind==='single' && normalize(v.snapshot.rawName)===normalize(name));
      if (matching.length>1) throw new CollectionError('ambiguous_control','blocked');
      if (matching.length===1) {
        if (cal.pilot) await tapNode(screen,matching[0]!.card,signal);
        else await screen.tap('item',matching[0]!.nodes);
        return;
      }
      const fingerprint=digest(rows.map(v=>v.snapshot.key));
      if (seen.has(fingerprint) || scrolls===maximumScrolls || (direction==='down' && cal.end && oneAnchor(cal.end,scoped(root,screen.source)))) break;
      seen.add(fingerprint);
      if (direction==='down') await swipeMenu(screen,root,signal); else await swipeMenuDown(screen,root,signal);
    }
  }
  throw new CollectionError('jd_single_item_not_found');
}

async function readSelectedSpec(screen:ReviewedScreen,name:string,signal:AbortSignal) {
  const selector=screen.source.selectors.selectedSpec;
  const titleSelector=screen.source.selectors.itemDetail;
  if (!titleSelector) throw new CollectionError('variant_controls_unverified','blocked');
  const deadline=Date.now()+12_000;
  while (true) {
    signal.throwIfAborted();
    let nodes:UiNode[]=[];
    try { nodes=await screen.nodes(); }
    catch(e) { if (!(e instanceof CollectionError && e.code==='entry_mismatch')) throw e; }
    const title=screen.find({...titleSelector,text:titleSelector.text.replace('{item}',name)},nodes,false);
    const matches=nodes.filter(n=>(!selector.resource || resourceOf(n)===selector.resource) &&
      (!selector.className || n.attrs.class?.split('.').at(-1)===selector.className) && /已选/.test(textOf(n)));
    if (title && matches.length===1) {
      const spec=/^已选[：:]\s*([^，,]+)[，,]\s*1件$/.exec(textOf(matches[0]!))?.[1]?.trim();
      if (spec && validPublic(spec,100) && !packageLabel.test(spec)) return {nodes,title,selection:{node:matches[0]!,spec}};
    }
    if (title && !matches.length && screen.selector('add',nodes,false)) return {nodes,title,selection:null};
    if (Date.now()>=deadline) throw new CollectionError('control_missing');
    await wait(250,undefined,{signal});
  }
}

async function selectDirectSingle(screen:ReviewedScreen,cal:JdShelfCalibration,store:Supply['store'],signal:AbortSignal,evidenceStore:EvidenceStore):Promise<JdShelfSelectedItem> {
  if (screen.source.selectors.category) await selectPilotCategory(screen,signal);
  const attempted=new Set<string>();
  for (let page=0;page<3 && attempted.size<3;) {
    const {root}=await menuAt(screen,cal,signal,store);
    const cards=menuRows(screen,cal,root,store).rows.filter(row=>row.snapshot.kind!=='set' && !attempted.has(row.snapshot.rawName));
    const row=cards.find(candidate=>candidate.snapshot.rawName===cal.pilot?.singleName);
    if (!row) {
      if (++page<3) await swipeMenu(screen,root,signal);
      continue;
    }
    const name=row.snapshot.rawName;
    attempted.add(name);
    await tapNode(screen,row.card,signal);
    // 商品详情弹窗是原生渲染，u2 能读且快；门店菜单页是 WebView，需要 dump。
    await screen.device.setTreeMode?.('u2').catch(()=>undefined);
    await wait(800,undefined,{signal});
    const read=await readSelectedSpec(screen,name,signal);
    const selection=read.selection;
    let evidence:Evidence|undefined;
    if (selection) {
      const frame=await screen.capture([read.title,selection.node]);
      evidence=await evidenceStore.save(randomUUID(),'jd_direct_single',frame.image,JSON.stringify({name,spec:selection.spec}),'live',frame.at);
    }
    if (screen.selector('dismissItemDetail',read.nodes,false)) await screen.tap('dismissItemDetail',read.nodes);
    else await screen.device.back();
    // 退回门店菜单页（WebView），切回 dump。
    await screen.device.setTreeMode?.('dump').catch(()=>undefined);
    if (selection && evidence) {
      const {spec}=selection, key=digest([store.key,normalize(name),'single',specKey(spec),'[]']);
      return {key,rawName:name,kind:'single',spec,sales:null,salesRaw:null,position:1,evidence,excludedReason:null,
        supply:{store,item:{key,name,kind:'single',spec,options:[],parts:null}}};
    }
  }
  throw new CollectionError('jd_direct_single_unverified');
}

async function readTopItemSpecs(screen:ReviewedScreen,cal:JdShelfCalibration,store:Supply['store'],items:JdShelfItem[],signal:AbortSignal,evidenceStore:EvidenceStore,remainingMs:number):Promise<number> {
  // Read a few more than five by sales so one unreadable spec does not shrink the final list.
  const candidates=items.filter(item=>item.kind==='single' && !item.excludedReason && item.sales && item.sales.value>0)
    .sort((a,b)=>b.sales!.value-a.sales!.value || a.position-b.position).slice(0,JD_SHELF_LIMIT*2);
  if (!candidates.length || remainingMs<=0) return 0;
  const timeout=AbortSignal.timeout(Math.min(remainingMs,120_000));
  const specSignal=AbortSignal.any([signal,timeout]);
  const primary=candidates.slice(0,JD_SHELF_LIMIT).sort((a,b)=>b.position-a.position);
  const fallback=candidates.slice(JD_SHELF_LIMIT).sort((a,b)=>a.position-b.position);
  let position=items.length;
  let learned=0;
  for (const item of [...primary,...fallback]) {
    if (candidates.filter(row=>row.supply && !row.excludedReason).length>=JD_SHELF_LIMIT || specSignal.aborted) break;
    if (item.supply) continue;
    let opened=false;
    try {
      await findJdMenuItemByName(screen,store,item.rawName,specSignal,item.position<position ? 'up' : 'down');
      opened=true;
      position=item.position;
      const read=await readSelectedSpec(screen,item.rawName,specSignal);
      if (read.selection) {
        const {node,spec}=read.selection;
        const options:string[]=[];
        const key=digest([store.key,normalize(item.rawName),'single',specKey(spec),JSON.stringify(options)]);
        const frame=await screen.capture([read.title,node],{signal:specSignal});
        item.evidence=await evidenceStore.save(randomUUID(),'jd_spec',frame.image,JSON.stringify({name:item.rawName,spec}),'live',frame.at);
        item.spec=spec; item.key=key;
        item.supply={store,item:{key,name:item.rawName,kind:'single',spec,options,parts:null}};
        learned++;
      } else item.excludedReason='spec_not_displayed';
      if (screen.selector('dismissItemDetail',read.nodes,false)) await screen.tap('dismissItemDetail',read.nodes);
      else await screen.device.back();
      opened=false;
    } catch(e) {
      signal.throwIfAborted();
      if (!(e instanceof CollectionError) && !timeout.aborted) throw e;
      if (e instanceof CollectionError && e.status==='blocked') throw e;
      if (!item.supply) item.excludedReason='spec_unreadable';
      if (opened) {
        await screen.device.back();
        await menuAt(screen,cal,signal);
      }
    }
  }
  for (const item of candidates) if (!item.supply && !item.excludedReason) item.excludedReason='spec_unreadable';
  return learned;
}

export async function scanJdShelf(task:Task,attemptId:string,signal:AbortSignal,emit:StepSink|undefined,source:AndroidSource,
  model:Pick<ModelGateway,'status'|'json'|'locate'>,evidenceStore:EvidenceStore,connect:AndroidTransport=connectAndroid):Promise<AttemptResult> {
  const start=Date.now(),trace:AttemptResult['trace']=[];
  let device:Awaited<ReturnType<AndroidTransport>>|undefined, shelf:JdShelfResult|undefined, proof:Evidence|null=null;
  let status:AttemptResult['status']='failed',code:string|null=null,availability='unknown';
  const journal:StepSink=event=>{
    trace.push({phase:event.phase,at:new Date().toISOString(),note:event.errorCode ?? event.state});
    emit?.(event);
  };
  try {
    const input=await stage(journal,'source_check',async()=>{
      if (task.platform!=='jd' || task.data_mode!=='live' || source.platform!=='jd' || !task.shelf || !task.allowed_actions.includes('browse'))
        throw new CollectionError('invalid_jd_shelf_task','blocked');
      if (Date.parse(source.access.expiresAt)<=Date.now() || task.shelf.sourceRevision!==digest(source) || source.entry!==task.entry_point ||
        source.device!==task.device_ref || source.point!==task.delivery_point_id || source.account!==task.account_ref) throw new CollectionError('source_changed','blocked');
      if (!source.jdShelf) throw new CollectionError('jd_shelf_not_configured','blocked');
      return {value:task.shelf.input};
    });
    device=await stage(journal,'device_connect',async()=>({value:await connect(source,signal)}));
    const screen=new ReviewedScreen(device,source,{query:input.brand,store:input.storeName,address:input.businessAddress ?? ''},signal);
    const found=await openJdStore(screen,input,attemptId,signal,model,evidenceStore,journal,true);
    proof=found.evidence;
    if (source.jdShelf?.pilot?.directSingle) {
      const selected=await stage(journal,'direct_single',async()=>{
        const item=await selectDirectSingle(screen,source.jdShelf!,found.store,signal,evidenceStore);
        return {value:item,data:{item:item.rawName,spec:item.spec},evidenceIds:[item.evidence.id]};
      });
      shelf={store:found.store,district:found.district,evidence:found.evidence,coverage:'direct_single',scannedCount:1,
        stopReason:'pilot_direct_single',items:[selected],selected:[selected]};
      status='success';
    } else {
    const scan=await stage(journal,'shelf_scan',async()=>{
      if (source.jdShelf?.pilot && !source.jdShelf.pilot.autoSingles) await selectPilotCategory(screen,signal);
      const unavailable=screen.unavailable(found.nodes);
      if (unavailable && ['closed','out_of_range'].includes(unavailable.status)) {
        const frame=await screen.capture([unavailable.node]);
        proof=await evidenceStore.save(randomUUID(),'availability',frame.image,textOf(unavailable.node),'live',frame.at);
        throw new CollectionError(unavailable.status,'unavailable',unavailable.status);
      }
      const budgetMs=source.jdShelf?.pilot?.autoSingles ?
        Math.max(1,Math.min(scanTimeoutMs,task.timeout_seconds*1000-(Date.now()-start)-95_000)) : scanTimeoutMs;
      const data=await scanMenu(screen,source.jdShelf!,found.store,signal,evidenceStore,budgetMs);
      return {value:data,data:{coverage:data.coverage,scannedCount:data.scannedCount,pageCount:data.pageCount,
        unreadableCount:data.unreadableCount,stopReason:data.stopReason},evidenceIds:[...new Set(data.items.flatMap(v=>v.evidence ? [v.evidence.id]:[]))]};
    });
    if (source.jdShelf?.pilot?.autoSingles) {
      await stage(journal,'spec_scan',async()=>{
        const remaining=task.timeout_seconds*1000-(Date.now()-start)-30_000;
        const learned=await readTopItemSpecs(screen,source.jdShelf!,found.store,scan.items,signal,evidenceStore,remaining);
        return {value:learned,data:{learned},evidenceIds:[...new Set(scan.items.flatMap(item=>item.evidence ? [item.evidence.id] : []))]};
      });
    }
    const selected=await stage(journal,'hot_rank',async()=>{
      const window=jdShelfSalesWindow(scan.items);
      for (const item of scan.items.filter(item=>!item.excludedReason)) {
        if (item.sales?.value===0) item.excludedReason='sales_zero';
        else if (!item.supply) item.excludedReason='product_spec_unknown';
        else if (scan.coverage!=='sales_order') {
          if (!item.sales) item.excludedReason=item.salesRaw ? 'sales_unreadable' : 'sales_missing';
          else if (item.sales.window!==window) item.excludedReason='sales_window_mismatch';
        }
      }
      const items=rankJdShelfItems(scan.items,scan.coverage,5);
      return {value:items,data:{selectedCount:items.length,items:scan.items.map(v=>({name:v.rawName,spec:v.spec,sales:v.sales,
        salesRaw:v.salesRaw,position:v.position,excludedReason:v.excludedReason,rank:items.findIndex(item=>item.key===v.key)+1 || null}))}};
    });
    shelf={store:found.store,district:found.district,evidence:found.evidence,coverage:scan.coverage,scannedCount:scan.scannedCount,stopReason:scan.stopReason,items:scan.items,selected};
    status=shelf.coverage==='partial' || selected.length<5 ? 'partial' : 'success';
    if (!selected.length) code='shelf_no_rankable_items';
    }
  } catch (e) {
    status=e instanceof CollectionError ? e.status : 'failed';
    availability=e instanceof CollectionError ? e.availability : 'unknown';
    code=e instanceof CollectionError ? e.code : signal.aborted ? 'window_missed' : 'android_collection_failed';
  } finally { await device?.close().catch(()=>undefined); }
  return {status,error_code:code,availability,observation:null,trace,evidence:proof,started_at:new Date(start).toISOString(),
    finished_at:new Date().toISOString(),cleanup:'untouched',cost:{model_yuan:null,execution_ms:Date.now()-start},...(shelf ? {shelf} : {})};
}
