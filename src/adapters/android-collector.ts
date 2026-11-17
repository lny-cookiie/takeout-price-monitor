import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { connectAndroid, type AndroidSession, type AndroidTransport } from './android-transport.js';
import type { UiNode } from '@midscene/core';
import sharp from 'sharp';
import { type AndroidSource, type AndroidSources, type Field, type Selector } from './android-source.js';
import { CollectionError, parseCny, type AttemptResult, type Collector, type Evidence, type MoneyComponent, type Observation, type Platform, type StepUpdate, type StepSink, type Task } from '../domain/contracts.js';
import { breakdownKeys, digest, itemGate, normalize, nullable, object, storeGate, string, validator, type Candidate, type MarketRead, type QuoteDetails, type Reading } from '../domain/competition.js';
import type { EvidenceStore } from '../infra/evidence.js';
import type { ModelGateway } from '../infra/model.js';
import { cropBoxes, flatten, resourceOf, textOf } from './android-page.js';
import { captureCheckout, verifyCheckout, compactEvidence } from './checkout-reading.js';
import { captureVisualCheckout } from './visual-checkout.js';
import { privacyBandMask } from './checkout-privacy.js';
import {PAGE_ONTOLOGY_VERSION,mapVersion,executionPages} from '../domain/page-ontology.js';
export { resourceOf, textOf } from './android-page.js';

const forbidden = /提交订单|确认支付|立即支付|去支付|支付订单|领取|开通会员|购买会员|去登录|同意并/;
const restricted = /请完成.{0,5}验证|验证码|滑动验证|人机验证/;
const priceCheck = validator<{payable: string | null}>(object({payable:nullable(string(50))}),'报价');
const menuPriceCheck = validator<{current: string | null}>(object({current:nullable(string(50))}),'商品现价');
type JdNavigation=Pick<typeof import('./jd-shelf-collector.js'),'openJdStore'|'findJdMenuItem'|'returnToJdMenu'>;

function moneyReading(raw:string|null|undefined):number|null {
  if (!raw) return null;
  try { return parseCny(raw); } catch { return null; }
}

export class ReviewedScreen {
  currentStoreTitle:string|null=null;
  private cachedNodes:UiNode[]|null=null;
  private cachedAt=0;
  readonly metrics={treeReads:0,treeMs:0,screenshots:0,screenshotMs:0,waitMs:0,retries:0,cleanupMs:0,cacheHits:0};
  constructor(readonly device: AndroidSession, readonly source: AndroidSource, private vars: Record<string,string>, private signal: AbortSignal,private onDiagnostic?:StepSink) {
    const mutations=new Set(['tap','launch','search','swipe','back']);
    this.device=new Proxy(device,{get:(target,key)=>{const value=Reflect.get(target,key);if(typeof value!=='function')return value;
      if(mutations.has(String(key)))return (...args:unknown[])=>{this.cachedNodes=null;this.currentStoreTitle=null;return Reflect.apply(value,target,args);};
      return value.bind(target);
    }});
  }
  useSignal(signal:AbortSignal){this.signal=signal;}
  async nodes(fresh=false) {
    this.signal.throwIfAborted();
    if(!fresh&&this.cachedNodes&&Date.now()-this.cachedAt<500){this.metrics.cacheHits++;return this.cachedNodes;}
    const start=Date.now();this.metrics.treeReads++;
    let tree;
    for(let attempt=1;;attempt++){
      try{tree=await this.device.getUITree();break;}
      catch{
        // 大促页面动画/详情页加载期间 dump 会整次超时；等页面稳定后重读，不要把「还没就绪」当成读屏不可用。
        if(attempt>=3){this.metrics.treeMs+=Date.now()-start;throw new CollectionError('screen_unreadable');}
        this.metrics.retries++;
        await wait(1_500,undefined,{signal:this.signal});
      }
    }
    this.metrics.treeMs+=Date.now()-start;
    this.signal.throwIfAborted();
    const nodes = flatten(tree.root);
    const own = nodes.filter(n=>n.attrs.package===this.source.package && n.bounds.width>0 && n.bounds.height>0);
    if (!own.length || (tree.root.attrs.package && tree.root.attrs.package!==this.source.package)) {
      const rootPackage=tree.root.attrs.package;
      this.onDiagnostic?.({phase:'page_context',state:'blocked',errorCode:'entry_mismatch',data:{rootPackage:rootPackage&&/^[a-zA-Z][\w.]{0,150}$/.test(rootPackage)?rootPackage:'unknown',ownNodeCount:own.length}});
      throw new CollectionError('entry_mismatch');
    }
    if (own.some(n=>restricted.test(textOf(n)))) throw new CollectionError('captcha_required','blocked');
    if (own.some(n=>/访问受限|异常访问|拒绝访问/.test(textOf(n)))) throw new CollectionError('access_restricted','blocked');
    if (own.some(n=>/操作过于频繁|请求过于频繁/.test(textOf(n)))) throw new CollectionError('rate_limited','blocked');
    if (nodes.some(n=>n.attrs.package && n.attrs.package!==this.source.package && n.attrs['clickable']==='true' &&
      !/inputmethod|keyboard|systemui/i.test(n.attrs.package))) throw new CollectionError('foreign_window');
    const identity=this.source.jdShelf?.menuIdentity;
    const titles=identity?nodes.filter(n=>n.attrs.package===this.source.package&&resourceOf(n)===identity.resource).map(textOf).filter(Boolean):[];
    this.currentStoreTitle=titles.length===1?titles[0]!:null;
    this.cachedNodes=own;this.cachedAt=Date.now();
    return own;
  }
  async waitFor(keys: (keyof AndroidSource['selectors'])[], options: {onLaunch?: boolean; availability?: boolean; inCart?: boolean;timeoutMs?:number} = {}) {
    const until=Date.now()+(options.timeoutMs??(this.source.jdShelf?.pilot ? 20_000 : 12_000));
    let launchReadRetried=false;
    let firstRead=true;
    for (;;) {
      this.signal.throwIfAborted();
      let nodes: UiNode[] = [];
      try { nodes=await this.nodes(firstRead); firstRead=false; }
      catch(e) {
        if (!(e instanceof CollectionError)) throw e;
        if (e.code==='screen_unreadable' && options.onLaunch && !launchReadRetried && Date.now()<until) {
          launchReadRetried=true;
          this.metrics.retries++;
        } else if (e.code!=='entry_mismatch') throw e;
      }
      const scope=options.inCart ? this.cartNodes(nodes,false) : nodes;
      if ((scope && keys.every(k=>!!this.selector(k,scope,false))) || (options.availability && this.unavailable(nodes))) return nodes;
      if (Date.now()>=until) throw new CollectionError('page_not_ready');
      await wait(250,undefined,{signal:this.signal});
      this.metrics.waitMs+=250;
    }
  }
  selector(key: keyof AndroidSource['selectors'], nodes: UiNode[], required = true) {
    const selector = this.source.selectors[key];
    if (!selector) {
      if (required) throw new CollectionError('selector_missing');
      return null;
    }
    return this.find(selector,nodes,required);
  }
  find(s: Selector, nodes: UiNode[], required: boolean) {
    const expected = s.text.replace(/\{(\w+)\}/g,(_,key: string)=>this.vars[key] ?? '');
    const matches = nodes.filter(n=>{
      const label=textOf(n);
      const sameLabel=s.textHash ? !!label && digest(label)===s.textHash :
        label===expected || (s.textPrefix && label.startsWith(expected)) || (s.withDescription && (label.startsWith(expected+'，') || label.startsWith(expected+',')));
      const className=n.attrs.class?.split('.').at(-1);
      return sameLabel && (!s.resource || resourceOf(n)===s.resource) && (!s.className || className===s.className);
    });
    if (matches.length===1) return matches[0]!;
    if (!required && matches.length===0) return null;
    throw new CollectionError(matches.length>1 ? 'ambiguous_control' : 'control_missing');
  }
  cartNodes(nodes:UiNode[]):UiNode[];
  cartNodes(nodes:UiNode[],required:false):UiNode[]|null;
  cartNodes(nodes:UiNode[],required=true) {
    if (!this.source.selectors.cartPanel) return nodes;
    let panel=this.selector('cartPanel',nodes,false);
    const configured=this.source.selectors.cartPanel;
    if(!panel&&configured?.textPrefix&&configured.text==='复选框，已选中，全选')panel=this.find({...configured,text:'复选框，未选中，全选'},nodes,false);
    if(!panel&&this.source.selectors.cartCount&&this.selector('cartCount',nodes,false)){
      const line=this.selector('cartLine',nodes,false),remove=this.selector('remove',nodes,false);
      if(line&&remove){const scopes=nodes.filter(n=>{const inside=flatten(n);return inside.includes(line)&&inside.includes(remove);})
        .sort((a,b)=>a.bounds.width*a.bounds.height-b.bounds.width*b.bounds.height);
        for(const candidate of scopes){try{if(this.selector('quantity',flatten(candidate),false)){panel=candidate;break;}}catch(error){if(!(error instanceof CollectionError&&error.code==='ambiguous_control'))throw error;}}
      }
    }
    if(!panel&&required)throw new CollectionError('control_missing');
    return panel ? flatten(panel).filter(n=>n.attrs.package===this.source.package && n.bounds.width>0 && n.bounds.height>0) : null;
  }
  field(s: Field | undefined, nodes: UiNode[]) {
    if (!s) return null;
    const matches = nodes.filter(n=>(!s.resource || resourceOf(n)===s.resource) && (!s.className || n.attrs.class?.split('.').at(-1)===s.className) &&
      textOf(n).startsWith(s.prefix) && textOf(n).slice(s.prefix.length).trim());
    if (matches.length!==1) return null;
    return {node:matches[0]!,raw:textOf(matches[0]!).slice(s.prefix.length).trim()};
  }
  unavailable(nodes: UiNode[]) {
    const signals = [['soldOut','sold_out'],['closed','closed'],['outOfRange','out_of_range'],['minimum','minimum_not_met']] as const;
    for (const [key,status] of signals) {
      const node = this.selector(key,nodes,false);
      if (node) return {node,status};
    }
    return null;
  }
  async tap(key: keyof AndroidSource['selectors'], nodes: UiNode[]) {
    const selected = this.selector(key,nodes)!;
    if ((!resourceOf(selected) && !this.source.selectors[key]?.className) || forbidden.test(textOf(selected)) || selected.attrs.enabled==='false')
      throw new CollectionError('action_not_allowed','blocked');
    const {left,top,width,height} = selected.bounds;
    const size = await this.device.size();
    const x = left+width/2,y = top+height/2;
    if (!(x>0 && x<size.width && y>0 && y<size.height)) throw new CollectionError('invalid_control_bounds');
    this.signal.throwIfAborted();
    await this.device.tap(x,y);
    await wait(350,undefined,{signal:this.signal});
  }
  async couponCheckout(nodes:UiNode[]) {
    const selected=this.find({text:'领券结算，按钮',className:'TextView'},nodes,true)!;
    const {left,top,width,height}=selected.bounds,size=await this.device.size();
    if(selected.attrs.enabled==='false'||width<=0||height<=0||left<0||top<0||left+width>size.width||top+height>size.height)throw new CollectionError('invalid_control_bounds');
    this.signal.throwIfAborted();await this.device.tap(left+width/2,top+height/2);
    await wait(350,undefined,{signal:this.signal});
  }
  async capture(nodes: UiNode[], options?:{before?:Buffer;signal:AbortSignal;privacyTopRatio?:number}) {
    const signal=options ? AbortSignal.any([this.signal,options.signal]) : this.signal;
    signal.throwIfAborted();
    if (!nodes.length) throw new CollectionError('evidence_unavailable');
    // Use standard screencap. A protected/blank frame is never retried through another capture mechanism.
    let viewport = await this.device.size();
    const before=options?.before;
    const beforeSize=before ? await sharp(before).metadata() : undefined;
    for (let attempt=0; attempt<2; attempt++) {
      const started=Date.now();this.metrics.screenshots++;
      const png = await this.device.screenshot(signal).finally(()=>{this.metrics.screenshotMs+=Date.now()-started;});
      const at = new Date().toISOString();
      const meta = await sharp(png).metadata();
      const width = meta.width ?? 0, height = meta.height ?? 0;
      if (!width || !height) throw new CollectionError('screen_geometry_changed');
      if (Math.abs(width/height-viewport.width/viewport.height)>0.02) {
        viewport = await this.device.size();
        if (Math.abs(width/height-viewport.width/viewport.height)>0.02) throw new CollectionError('screen_geometry_changed');
      }
      const thumbnail = await sharp(png).resize(64,64).toBuffer();
      const stats = await sharp(thumbnail).stats();
      if (stats.channels.slice(0,3).every(c=>c.stdev<2)) {
        if (attempt===0) { await wait(200,undefined,{signal}); continue; }
        throw new CollectionError('blank_screen');
      }
      const paired=attempt===0 && before && beforeSize?.width===width && beforeSize.height===height;
      let refreshed: UiNode[];
      try { refreshed = paired ? nodes : await this.nodes(true); }
      catch(e) {
        if (attempt===0 && e instanceof CollectionError && e.code==='entry_mismatch') { await wait(300,undefined,{signal}); continue; }
        throw e;
      }
      signal.throwIfAborted();
      const layers: Array<{input:Buffer;left:number;top:number}> = [];
      const masks: Array<{input:Buffer;left:number;top:number}> = [];
      const locations: Array<{left:number;top:number;width:number;height:number}> = [];
      let missed = 0;
      for (const node of nodes) {
        const match = refreshed
          .filter(n=>resourceOf(n)===resourceOf(node) && textOf(n)===textOf(node) &&
            (['left','top','width','height'] as const).every(key=>Math.abs(n.bounds[key]-node.bounds[key])<=2))
          .sort((a,b)=>Math.abs(a.bounds.top-node.bounds.top)+Math.abs(a.bounds.left-node.bounds.left))[0];
        if (!match) { missed++; continue; }
        const crop = cropBoxes(match,viewport,{width,height});
        if (!crop.boxes.length || !crop.location) { missed++; continue; }
        const bands=await Promise.all(crop.boxes.map(async box=>({box,input:await sharp(png).extract(box).png().toBuffer()})));
        if (paired && !(await Promise.all(bands.map(async ({box,input})=>input.equals(await sharp(before).extract(box).png().toBuffer())))).every(Boolean)) {
          missed++;
          continue;
        }
        for (const {box,input} of bands) layers.push({input,left:box.left,top:box.top});
        for (const box of crop.redactions)
          masks.push({input:await sharp({create:{width:box.width,height:box.height,channels:3,background:'#121719'}}).png().toBuffer(),left:box.left,top:box.top});
        locations.push(crop.location);
      }
      if (missed && attempt===0) { await wait(200,undefined,{signal}); continue; }
      if (!locations.length) throw new CollectionError('evidence_capture_failed');
      if (missed) throw new CollectionError('page_changed_during_capture');
      if(options?.privacyTopRatio){
        // 优先按配送点位锚点计算顶部遮罩带（跟随内容位置），找不到锚点时回退固定比例（跨机型 P0-4）。
        let pointNode:UiNode|null=null;
        try{pointNode=this.source.selectors.point ? this.selector('point',refreshed,false) : null;}catch{pointNode=null;}
        const band=pointNode ? privacyBandMask(pointNode.bounds,viewport,{width,height}) : null;
        if(band)masks.push({input:await sharp({create:{width:band.width,height:band.height,channels:3,background:'#121719'}}).png().toBuffer(),left:band.left,top:band.top});
        else{const privateHeight=Math.ceil(height*options.privacyTopRatio);masks.push({input:await sharp({create:{width,height:privateHeight,channels:3,background:'#121719'}}).png().toBuffer(),left:0,top:0});}
      }
      const image = await sharp({create:{width,height,channels:3,background:'#121719'}}).composite([...layers,...masks]).png().toBuffer();
      return {image,locations,at};
    }
    throw new CollectionError('evidence_capture_failed');
  }
}

export async function findDeviceControl(source:AndroidSource,text:string) {
  const signal=AbortSignal.timeout(25_000);
  const device=await connectAndroid(source,signal);
  try {
    const nodes=await new ReviewedScreen(device,source,{},signal).nodes();
    return nodes.filter(node=>textOf(node)===text.trim()).slice(0,10).map(node=>({resource:resourceOf(node) || null,enabled:node.attrs.enabled!=='false'}));
  } finally { await device.close(); }
}

export async function discoverCandidate(source: AndroidSource, evidenceStore: EvidenceStore): Promise<Candidate> {
  const signal = AbortSignal.timeout(50_000);
  const device = await connectAndroid(source,signal);
  try {
    const screen = new ReviewedScreen(device,source,{},signal);
    const nodes = await screen.nodes();
    const fields = ['catalogStore','catalogBrand','catalogCity','catalogAddress','catalogItem','catalogSpec','catalogOptions','catalogKind'] as const;
    const data = fields.map(k=>screen.field(source.fields[k],nodes));
    const [store,brand,city,address,item,spec,options,kind] = data;
    if (!store || !item) throw new Error('当前页面未显示配置中的门店和商品。请在已登记的入口打开商品详情。');
    const frame = await screen.capture(data.flatMap(d=>d?.node ?? []));
    const reference = randomUUID();
    const proof = await evidenceStore.save(reference,'catalog',frame.image,JSON.stringify(Object.fromEntries(fields.map((k,i)=>[k,data[i]?.raw ?? null]))),'live',frame.at);
    return {platform:source.platform,entry:source.entry,reference,evidence:proof,
      supply:{store:{key:digest([source.entry,store.raw,address?.raw]),name:store.raw,brand:brand?.raw ?? '',city:city?.raw ?? '',address:address?.raw ?? ''},
        item:{key:digest([source.entry,store.raw,item.raw,spec?.raw]),name:item.raw,spec:spec?.raw ?? '',kind:kind?.raw==='套餐'?'set':'single',
          options:options?.raw==='无' ? [] : options?.raw.split('、') ?? null,parts:null}}};
  } finally { await device.close(); }
}

export function androidCollector(platform: Platform, sources: AndroidSources, model: Pick<ModelGateway,'status'|'json'|'locate'>, evidenceStore: EvidenceStore, cost: (id: string) => number | null, connect = connectAndroid as AndroidTransport, isCurrent: (t:Task) => boolean = () => true, jd?:JdNavigation): Collector {
  return {
    platform,mode:'live',async close() {},
    async collect(task,attemptId,signal,_attemptNumber,emit) {
      const start = Date.now(), started_at = new Date(start).toISOString();
      const trace: AttemptResult['trace'] = [];
      const note = (phase: string, text: string) => trace.push({phase,at:new Date().toISOString(),note:text});
      let active:string|null=null;
      const stepStart=(phase:string)=>{ active=phase; emit?.({phase,state:'started',data:{pageState:executionPages[phase]??null,pageMapVersion:pageMap?.mapVersion??null}}); };
      const stepEnd=(result:Omit<StepUpdate,'phase'>={state:'succeeded'})=>{
        if (!active) return;
        const phase=active;
        active=null;
        emit?.({phase,...result});
      };
      const source = sources.get(platform);
      const pageMap=source?{ontologyVersion:PAGE_ONTOLOGY_VERSION,mapVersion:mapVersion(source),appVersion:source.appVersion}:undefined;
      let context = task.live;
      let resolvedLive:AttemptResult['resolvedLive'], quoteReadyAt:string|undefined, metrics:AttemptResult['timings'];
      let menuJob:Promise<void>|undefined,checkoutJob:Promise<void>|undefined;
      let observation: Observation | null = null, evidence: Evidence | null = null, market: MarketRead | undefined;
      let cleanup: AttemptResult['cleanup'] = 'untouched', status: AttemptResult['status'] = 'failed', error_code: string | null = null, availability = 'unknown';
      let cartBadgeBefore: string | null = null;
      let buyNowTap: { x: number; y: number } | null = null;
      let device: AndroidSession | undefined, menuPriceReason:string|null|undefined;
      let storeFreightFen:number|null=null;
      try {
        stepStart('source_check');
        note('source','核对来源使用范围及设备配置。');
        if (!source || !sources.permitted(platform)) throw new CollectionError('live_source_not_ready','blocked');
        if (source.jdShelf?.pilot && source.jdShelf.pilot.storeId!==task.jdOrigin?.savedStoreId) throw new CollectionError('jd_pilot_store_scope','blocked');
        if (!context || context.sourceRevision!==digest(source) || task.entry_point!==source.entry || task.account_ref!==source.account || task.device_ref!==source.device)
          throw new CollectionError('source_changed','blocked');
        const m = context.mapping, eligibility = context.profile.eligibility[platform];
        if (!task.specified && (!m || m.status!=='verified' || m.targetRevision!==context.target.revision || m.candidate.entry!==source.entry || m.candidate.platform!==platform ||
            storeGate(context.target.supply,m.candidate.supply) || itemGate(context.target.supply,m.candidate.supply))) throw new CollectionError('mapping_unverified','blocked');
        if (!isCurrent(task)) throw new CollectionError('mapping_changed','blocked');
        if (source.point!==context.profile.point || !eligibility?.evidence || eligibility.accountRef!==source.account) throw new CollectionError('profile_unverified','blocked');
        if (!['browse','select_variant','modify_owned_test_cart','read_checkout'].every(action=>task.allowed_actions.includes(action))) throw new CollectionError('action_not_allowed','blocked');
        if (!model.status.configured) throw new CollectionError('model_not_configured','blocked');
        if (task.jdOrigin && !jd) throw new CollectionError('jd_shelf_not_configured','blocked');
        stepEnd();
        let {store,item} = task.specified ? context.target.supply : m!.candidate.supply;
        stepStart('device_connect');
        device = await connect(source,signal);
        signal.throwIfAborted();
        // 采集从首页/外卖频道等原生页面开始，用 u2 即时快照；读到 WebView 页面会自动回落到 dump。
        await device.setTreeMode?.('u2').catch(()=>undefined);
        // 手机可能停在门店页/详情页/结算页，复用这些状态会让后续步骤错乱；每次采集强制重启到首页。
        if (!task.jdOrigin) {
          await device.launch(true);
          await wait(1_200,undefined,{signal});
        }
        stepEnd();
        const query=task.jdOrigin?.brand ?? (source.searchBy==='brand' ? store.brand : store.name);
        const vars = {query,store:store.name,address:store.address,item:item.name,spec:item.spec,quantity:'1',
          options:item.options?.join('、') ?? '', composition:item.parts?.map(p=>p.name+' '+p.spec+' × '+p.quantity).join('、') ?? ''};
        if ((vars.options && !source.selectors.options?.text.includes('{options}')) || (item.kind==='set' && !source.selectors.composition?.text.includes('{composition}')))
          throw new CollectionError('variant_controls_unverified','blocked');
        if (context.quantity>1 && !source.selectors.increase) throw new CollectionError('quantity_control_unverified','blocked');
        const screen = new ReviewedScreen(device,source,vars,signal,emit);
        device=screen.device;
        metrics=screen.metrics;
        const snap = (s: ReviewedScreen) => s.nodes();
        const unavailability = async (current: UiNode[]) => {
          const unavailable = screen.unavailable(current);
          if (!unavailable) return;
          const frame = await screen.capture([unavailable.node]);
          evidence = await evidenceStore.save(randomUUID(),'availability',frame.image,textOf(unavailable.node),'live',frame.at);
          throw new CollectionError(unavailable.status,'unavailable',unavailable.status);
        };
        let nodes:UiNode[], shopProof:Evidence;
        if (task.jdOrigin && jd) {
          const verified=await jd.openJdStore(screen,task.jdOrigin,attemptId,signal,model,evidenceStore,emit,true);
          if (!task.specified && digest(verified.store)!==digest(store)) throw new CollectionError('store_identity_changed','blocked');
          if(task.specified){store=verified.store;vars.store=store.name;vars.address=store.address;}
          nodes=verified.nodes;
          shopProof=verified.evidence;
          // 门店页最底部的“满¥30运费¥3”就是配送费（与打包费合并显示），先记下来，结算页没有独立行时用它。
          const pageNodes=await screen.nodes(true).catch(()=>[] as UiNode[]);
          const freightNode=pageNodes.find(node=>/运费¥?\d+/.test(textOf(node)));
          const freightMatch=freightNode?/运费¥?(\d+(?:\.\d+)?)/.exec(textOf(freightNode)):null;
          storeFreightFen=freightMatch?Math.round(Number(freightMatch[1])*100):null;
          emit?.({phase:'freight_probe',state:'started',data:{nodes:pageNodes.length,found:!!freightNode,text:freightNode?textOf(freightNode).slice(0,24):null,fen:storeFreightFen}});
          await unavailability(nodes);
        } else {
          note('launch','等待指定外卖入口和点位。');
          await device.launch();
          for (const entry of ['channel','entryCategory'] as const) {
            if (source.selectors[entry]) await screen.tap(entry,await screen.waitFor([entry],{onLaunch:true}));
          }
          nodes=await screen.waitFor(['home',source.selectors.homePoint ? 'homePoint' : 'point'],{onLaunch:true});
          note('search','等待门店搜索结果。');
          await screen.tap('search',nodes);
          nodes=await screen.waitFor(['searchInput']);
          await screen.tap('searchInput',nodes);
          signal.throwIfAborted();
          await device.search(query,signal,!source.selectors.searchSubmit);
          if (source.selectors.searchSubmit) {
            nodes=await screen.waitFor(['searchValue','searchSubmit']);
            await screen.tap('searchSubmit',nodes);
          }
          nodes=await screen.waitFor(['result']);
          await screen.tap('result',nodes);
          nodes=await screen.waitFor(['store','address']);
          const shopNodes=[screen.selector('store',nodes)!,screen.selector('address',nodes)!];
          await unavailability(nodes);
          const shopFrame=await screen.capture(shopNodes);
          shopProof=await evidenceStore.save(randomUUID(),'store',shopFrame.image,shopNodes.map(textOf).join('\n'),'live',shopFrame.at);
        }
        note('store','核对门店名称及营业地址。');
        stepStart('sku_match');
        // 未确认购物车为空时停止，不能清除不属于本次任务的商品。
        // 门店核验可能曾切到商家资料页；加购前重新读取当前门店页面，不使用返回的旧快照。
        nodes=await screen.nodes(true);
        const emptyCart=screen.selector('cartEmpty',nodes,false);
        // 立即购买不经过购物车，不要求全车为空；加购路径必须先确认购物车归属。
        const buyNowIsolated=!!source.selectors.buyNow;
        const cartLabels=nodes.map(textOf).filter(value=>/^(门店购物车|购物车|暂无商品|共\d+件)/.test(value)).map(value=>value.slice(0,60)).slice(0,8);
        cartBadgeBefore=cartLabels.find(value=>/购物车|暂无商品/.test(value)) ?? null;
        emit?.({phase:'cart_preflight',state:emptyCart?'succeeded':buyNowIsolated?'skipped':'blocked',errorCode:emptyCart||buyNowIsolated?undefined:'cart_empty_unverified',data:{
          nodeCount:nodes.length,cartLabels,mode:buyNowIsolated?'buy_now_isolated':'cart_mutation'}});
        if (!emptyCart && !buyNowIsolated)
          throw new CollectionError('cart_not_owned','blocked');
        if (task.jdOrigin && jd) await jd.findJdMenuItem(screen,store,item,signal);
        else {
          if (source.selectors.category) {
            await screen.tap('category',await screen.waitFor(['category']));
            nodes=await screen.waitFor(['item']);
          }
          await screen.tap('item',nodes);
        }
        note('variant','核对商品规格、口味和套餐组成。');
        // 商品详情弹窗是原生渲染，u2 能读规格；dump 在详情页会整次超时。切不到 u2 就明确失败，不静默回落。
        console.error('[diag] sku_match: switching to u2');
        await screen.device.setTreeMode?.('u2');
        console.error('[diag] sku_match: u2 ready, waiting spec');
        // 京东存在“立即购买”流程：点商品会直接跳结算页（Taro 渲染的
        // SettlementFillOrderTaroActivity），规格面板根本不出现。
        // 此时再调 waitFor 会在内部 this.nodes() 上挂死——u2 读 Taro 页面不返回，
        // 连 waitFor 自己的超时判断都走不到，实测卡住十几分钟直到人工中止。
        // 所以先给读树加一层硬超时探测：确认已在结算页就跳过规格核对，直接往下走。
        const probeNodes = await Promise.race([
          screen.nodes(false).catch(()=>[] as UiNode[]),
          new Promise<UiNode[]>(resolve=>setTimeout(()=>resolve([]),8_000)),
        ]);
        const alreadyCheckout = !!(source.selectors.checkoutStage && screen.selector('checkoutStage',probeNodes,false));
        if (alreadyCheckout) {
          throw new CollectionError('variant_unverified','blocked');
        }
        try{
          if (alreadyCheckout) throw new CollectionError('page_not_ready');
          nodes=await screen.waitFor(source.selectors.spec ? ['spec'] : ['selectedSpec'],{availability:true,timeoutMs:task.specified?6_000:15_000});
        }
        catch(error){
          // 立即购买模式不依赖规格文字：详情页有“立即购买”按钮即可直接继续。
          if (alreadyCheckout) {
            // 已在结算页：保留探测到的节点，直接进入后续金额读取。
            note('variant','立即购买模式：跳过规格文字核对，直接去结算。');
          } else if (source.selectors.buyNow) {
            throw new CollectionError('variant_unverified','blocked');
          } else {
          const current=await screen.nodes();
          if(!task.specified||!jd||!(error instanceof CollectionError&&error.code==='page_not_ready')||!source.selectors.itemDetail||
            !screen.selector('itemDetail',current,false)||!screen.selector('add',current,false))throw error;
          // 规格不可见时返回并重新打开，不得在未核实规格时加购。
          await screen.device.back();
          await jd.findJdMenuItem(screen,store,item,signal);
          nodes=await screen.waitFor(source.selectors.spec ? ['spec'] : ['selectedSpec'],{availability:true,timeoutMs:6_000});
          emit?.({phase:'item_open_retry',state:'succeeded',data:{reason:'重新打开商品后核对规格'}});
          }
        }
        await unavailability(nodes);
        if (source.selectors.spec && !source.selectors.buyNow) {
          await screen.tap('spec',nodes);
          nodes=await screen.waitFor(['selectedSpec'],{availability:true});
          await unavailability(nodes);
        }
        const selected = screen.selector('selectedSpec',nodes)!;
        if(task.specified){const quantity=/[，,]\s*(\d+)件$/.exec(textOf(selected));if(quantity&&Number(quantity[1])!==1)throw new CollectionError('variant_quantity_mismatch');}
        const extra = [vars.options ? screen.selector('options',nodes)! : null,item.kind==='set' ? screen.selector('composition',nodes)! : null].filter(n=>n!==null);
        const itemNode = screen.selector(source.selectors.itemDetail ? 'itemDetail' : 'item',nodes)!;
        const displayFields = [screen.field(source.fields.current,nodes),screen.field(source.fields.reference,nodes)];
        stepEnd({state:'succeeded',data:{item:item.name,spec:item.spec,quantity:context.quantity}});
        stepStart('menu_price');
        const optionFrame = await screen.capture([itemNode,selected,...extra,...displayFields.flatMap(f=>f?.node ?? [])]);
        const optionProof = await evidenceStore.save(randomUUID(),'menu',optionFrame.image,task.specified?JSON.stringify({item:item.name,spec:item.spec,fields:displayFields.map(f=>f?.raw??null),regions:optionFrame.locations}):[item.name,item.spec,...displayFields.flatMap(f=>f?.raw ?? [])].join('\n'),'live',optionFrame.at);
        if(task.specified) {
          const supply={store,item},target={...context.target,supply,revision:digest(supply)};
          const judgment={relation:'exact' as const,reason:'本次页面已核对门店、指定商品及规格',missing:[]};
          context={...context,target,mapping:{id:randomUUID(),targetId:target.id,targetRevision:target.revision,
            candidate:{platform,entry:source.entry,supply,reference:optionProof.id,evidence:optionProof},store:judgment,item:judgment,status:'verified',proposedAt:optionProof.captured_at,reviewedAt:optionProof.captured_at}};
          resolvedLive=context;
        }
        market = {prices:displayFields.flatMap((f,i) => {
          if (!f) return [];
          const qualifier = /起/.test(f.raw) ? 'from' : /[~～至]/.test(f.raw) ? 'range' : 'exact';
          let fen: number | null = null;
          if (qualifier==='exact') { try { fen=parseCny(f.raw); } catch { /* Retain the unparsed source value. */ } }
          return [{kind:i===0 ? 'display_current' : 'display_reference',qualifier:fen===null && qualifier==='exact' ? 'unknown' : qualifier,raw:f.raw,fen,evidence:optionProof}];
        })};
        const verifyMenu=async()=>{
        if (task.jdOrigin) {
          const current=market!.prices.find(price=>price.kind==='display_current');
          let modelFen:number|null=null;
          const structuralFen=current?.fen ?? null;
          menuPriceReason=!current ? 'menu_price_not_visible' : structuralFen===null ? 'menu_price_not_exact' : null;
          if (current && structuralFen!==null) {
            try {
              const reading=await model.json(attemptId,'jd_menu_read','读取该单品规格的商品现价原文。不要读取划线价、起价、配送费或优惠金额。只返回 { "current": "金额原文" }，看不到确切金额时返回 null。',
                {field:source.fields.current?.prefix ?? ''},menuPriceCheck,{image:task.specified?await compactEvidence([optionFrame]):optionFrame.image,signal,evidenceIds:[optionProof.id]});
              modelFen=moneyReading(reading.current);
              if (modelFen!==structuralFen) menuPriceReason='menu_amount_evidence_mismatch';
            } catch {
              signal.throwIfAborted();
              menuPriceReason='menu_model_read_failed';
            }
            if (menuPriceReason) {
              current.fen=null;
              current.qualifier='unknown';
            }
          }
          const event={state:menuPriceReason ? structuralFen===null ? 'skipped' as const : 'failed' as const : 'succeeded' as const,errorCode:menuPriceReason ?? undefined,
            data:{structuralFen,modelFen,menuPriceReason},evidenceIds:[optionProof.id]};
          if(task.specified)emit?.({phase:'menu_model',...event});else stepEnd(event);
        } else stepEnd();
        };
        if(task.specified){stepEnd({state:'succeeded',evidenceIds:[optionProof.id]});emit?.({phase:'menu_model',state:'started'});menuJob=verifyMenu().catch(()=>{menuPriceReason='menu_model_read_failed';const current=market?.prices.find(p=>p.kind==='display_current');if(current){current.fen=null;current.qualifier='unknown';}emit?.({phase:'menu_model',state:'failed',errorCode:menuPriceReason});});}
        else await verifyMenu();
        screen.selector('selectedSpec',nodes);
        if (vars.options) screen.selector('options',nodes);
        if (item.kind==='set') screen.selector('composition',nodes);
        const ownedCart = (n:UiNode[],atCheckout=false) => {
          const scope=atCheckout ? n : screen.cartNodes(n);
          const lineKey=atCheckout && source.selectors.checkoutLine ? 'checkoutLine' : 'cartLine';
          const quantityKey=atCheckout && source.selectors.checkoutQuantity ? 'checkoutQuantity' : 'quantity';
          const resource=source.selectors[lineKey]!.resource;
          if ((resource && scope.filter(node=>resourceOf(node)===resource).length!==1) ||
              (!atCheckout && source.selectors.cartCount && !screen.selector('cartCount',n,false)))
            throw new CollectionError('cart_not_owned','blocked');
          const base=[screen.selector(lineKey,scope)!,screen.selector(quantityKey,scope)!];
          if (atCheckout && source.selectors.checkoutSpec) base.push(screen.selector('checkoutSpec',scope)!);
          return base;
        };
        const restore = async (fromCheckout: boolean) => {
          // Restore only the verified line created by this attempt. Leave any ambiguous cart for the operator.
          const restoreSignal=AbortSignal.timeout(25_000);
          screen.useSignal(restoreSignal);
          vars.quantity=String(context!.quantity);
          const returned=await screen.nodes();
          if (fromCheckout && screen.selector('checkoutStage',returned,false)) {
            // Read-only scrolling may hide the checkout item. Ownership is checked again before any cart removal.
            await device!.back();
          }
          const deadline=Date.now()+20_000;
          let cart=fromCheckout ? await screen.nodes() : returned;
          let opened=false;
          while (!screen.selector('cartEmpty',cart,false)) {
            const panel=screen.cartNodes(cart,false);
            if (panel && screen.selector('cartLine',panel,false) && screen.selector('quantity',panel,false)) break;
            if (screen.selector('dismissItemDetail',cart,false)) {
              screen.selector('itemDetail',cart);
              await screen.tap('dismissItemDetail',cart);
            } else if (!opened && !panel && screen.selector('cart',cart,false)) {
              await screen.tap('cart',cart);
              opened=true;
            } else await wait(250,undefined,{signal:restoreSignal});
            if (Date.now()>=deadline) throw new CollectionError('cart_restore_surface_unverified');
            cart=await screen.nodes();
          }
          for (let i=screen.selector('cartEmpty',cart,false) ? 0 : context!.quantity;i>0;i--) {
            vars.quantity=String(i);
            ownedCart(cart);
            await screen.tap('remove',screen.cartNodes(cart));
            vars.quantity=String(i-1);
            cart=await screen.waitFor(i===1 ? ['cartEmpty'] : ['cartLine','quantity'],{inCart:i>1});
          }
          const empty=screen.selector('cartEmpty',cart)!;
          cleanup = 'restored';
          let emptyProof:Evidence|undefined;
          if (task.jdOrigin) {
            try {
              const frame=await screen.capture([empty]);
              emptyProof=await evidenceStore.save(randomUUID(),'cart_restored',frame.image,textOf(empty),'live',frame.at);
            } catch { note('cleanup','已读取空购物车标识，截图未保存。'); }
          }
          if (task.jdOrigin && jd?.returnToJdMenu) {
            try { await jd.returnToJdMenu(screen, restoreSignal); }
            catch { if (!signal.aborted) note('cleanup','购物车已清空，但未确认回到门店菜单。'); }
          }
          return emptyProof;
        };
        let inCheckout = false, visualCheckout = false;
        let cartProof:Evidence|undefined;
        const cartCount=(label:string|null|undefined):number|null=>{
          if(!label)return null;
          if(/暂无商品/.test(label))return 0;
          const match=/(\d+)\s*件商品/.exec(label);
          return match?Number(match[1]):null;
        };
        try {
          note('cart','核对专用购物车与商品份数。');
          stepStart('cart');
          cleanup = 'quarantined';
          emit?.({phase:'cart_add_intent',state:'started',data:{item:item.name,spec:item.spec,quantity:1}});
          const buyNowNode=source.selectors.buyNow ? screen.selector('buyNow',nodes,false) : null;
          if (buyNowNode) {
            // 立即购买直达结算页，不经过购物车；本次操作不改动购物车，恢复阶段只退出结算页。
            const buyNowCenter={x:buyNowNode.bounds.left+buyNowNode.bounds.width/2,y:buyNowNode.bounds.top+buyNowNode.bounds.height/2};
            buyNowTap=buyNowCenter;
            await screen.tap('buyNow',nodes);
            emit?.({phase:'cart_add_intent',state:'succeeded',data:{mode:'buy_now'}});
            cleanup='untouched';
            inCheckout=true;
            await wait(1_200,undefined,{signal});
            // 自绘结算页读屏没有文字：页面节点文字数为零就说明已经进入自绘结算页，直接走视觉读取。
            let tappedNodes: UiNode[] = [];
            try { tappedNodes=await screen.nodes(true); } catch { /* 页面切换瞬间读不到树也按自绘页处理。 */ }
            const textNodes=tappedNodes.filter(node=>textOf(node).trim()).length;
            if (!textNodes) { visualCheckout=true; nodes=[]; }
            else {
              try {
                nodes=await screen.waitFor(['checkoutStage','point','delivery'],{timeoutMs:12_000});
              } catch (error) {
                if (!(error instanceof CollectionError) || !['page_not_ready','entry_mismatch','screen_unreadable','control_missing','selector_missing'].includes(error.code)) throw error;
                visualCheckout=true;
                nodes=[];
              }
            }
            if (visualCheckout) emit?.({phase:'checkout_visual',state:'started',data:{reason:textNodes?'selector_unavailable':'taro_page'}});
            stepEnd({state:'succeeded',data:{mode:'buy_now',visualCheckout}});
          } else {
          await screen.tap('add',nodes);
          if (source.selectors.dismissItemDetail) {
            const afterAdd=await screen.nodes();
            emit?.({phase:'cart_surface',state:'succeeded',data:{itemDetail:!!(source.selectors.itemDetail&&screen.selector('itemDetail',afterAdd,false)),selectedSpec:!!screen.selector('selectedSpec',afterAdd,false),cartVisible:!!screen.selector('cart',afterAdd,false),detailDismiss:!!screen.selector('dismissItemDetail',afterAdd,false)}});
            if (screen.selector('dismissItemDetail',afterAdd,false)) await screen.tap('dismissItemDetail',afterAdd);
            else if(source.selectors.itemDetail&&screen.selector('itemDetail',afterAdd,false)&&screen.selector('add',afterAdd,false))await device.back();
            // 点“关闭弹层”偶尔不生效，页面仍在详情页；用返回键兜底一次，避免等购物车控件超时。
            await wait(600,undefined,{signal});
            const left=await screen.nodes().catch(()=>[] as UiNode[]);
            if (screen.selector('itemDetail',left,false)) { await device.back(); await wait(600,undefined,{signal}); }
          }
          nodes=source.selectors.cart ? await screen.waitFor(['cart']) : await screen.waitFor(['cartLine','quantity'],{inCart:true});
          if (source.selectors.cart) {
            await screen.tap('cart',nodes);
            nodes=await screen.waitFor(['cartLine','quantity'],{inCart:true});
          }
          for (let i=1;i<context.quantity;i++) {
            ownedCart(nodes);
            await screen.tap('increase',screen.cartNodes(nodes));
            vars.quantity=String(i+1);
            nodes=await screen.waitFor(['cartLine','quantity'],{inCart:true});
          }
          const [cartLine,quantityNode] = ownedCart(nodes) as [UiNode,UiNode];
          emit?.({phase:'cart_add_intent',state:'succeeded',data:{quantity:context.quantity}});
          const cartFrame = await screen.capture([cartLine,quantityNode]);
          cartProof = await evidenceStore.save(randomUUID(),'cart',cartFrame.image,[cartLine,quantityNode].map(textOf).join('\n'),'live',cartFrame.at);
          stepEnd({state:'succeeded',data:{quantity:context.quantity},evidenceIds:cartProof?[cartProof.id]:[]});
          }
          stepStart('checkout');
          if (!visualCheckout) await unavailability(nodes);
          note('checkout','定位结算入口并核对报价。');
          const buyNowMode=!!source.selectors.buyNow;
          let couponEntry:UiNode|null=null, couponAllowed=false;
          if (visualCheckout) {
            // 已在自绘结算页：跳过控件等待，直接进入截图视觉读取。
          } else if (buyNowMode) {
            // 立即购买已直达结算页：跳过“去结算”入口，直接等结算页字段。
            nodes=await screen.waitFor(['checkoutStage','point','delivery'],{timeoutMs:30_000});
            inCheckout=true;
          } else {
          const couponNode=!screen.selector('checkout',nodes,false)&&screen.find({text:'领券结算，按钮',className:'TextView'},nodes,false);
          couponEntry=couponNode||null;
          couponAllowed=!!(task.specified?.source==='trial'&&task.specified.couponCheckoutConsent&&context.couponPolicy==='claim_on_checkout');
          if(!screen.selector('checkout',nodes,false)&&!(couponEntry&&couponAllowed)) {
            const controls=nodes.filter(n=>/结算|起送|还差|去预约|休息中/.test(textOf(n))&&textOf(n).length<100);
            const frame=controls.length?await screen.capture(controls):null;
            const proof=frame?await evidenceStore.save(randomUUID(),'cart_checkout_control',frame.image,controls.map(textOf).join('\n'),'live',frame.at):null;
            stepEnd({state:'failed',errorCode:'checkout_control_missing',data:{controls:controls.map(textOf)},evidenceIds:proof?[proof.id]:[]});
            throw new CollectionError(couponEntry?'coupon_claim_required':'checkout_control_missing',couponEntry?'blocked':'failed');
          }
          if (!source.jdShelf?.pilot && !couponEntry) {
            const control = screen.selector('checkout',nodes)!;
            const controlFrame = await screen.capture([control]);
            const [x,y] = await model.locate(attemptId,controlFrame.image,textOf(control),signal,cartProof?[cartProof.id]:[]);
            const rect = controlFrame.locations[0]!;
            if (!(x>=rect.left && x<=rect.left+rect.width && y>=rect.top && y<=rect.top+rect.height)) throw new CollectionError('model_location_mismatch');
            nodes = await snap(screen);
            const current = screen.selector('checkout',nodes)!;
            const moved = Math.abs(current.bounds.left-control.bounds.left)+Math.abs(current.bounds.top-control.bounds.top)+
              Math.abs(current.bounds.width-control.bounds.width)+Math.abs(current.bounds.height-control.bounds.height);
            if (moved>4) throw new CollectionError('checkout_control_moved');
          }
          inCheckout = true;
          if(couponEntry&&couponAllowed){emit?.({phase:'coupon_checkout',state:'started',data:{policy:context.couponPolicy,reference:task.specified!.couponCheckoutConsent!.reference}});await screen.couponCheckout(nodes);}
          else await screen.tap('checkout',nodes);
          }
          let stage: UiNode | null = null;
          if (!visualCheckout) {
            nodes=await screen.waitFor(['checkoutStage','point','delivery',source.selectors.checkoutLine ? 'checkoutLine' : 'cartLine',
              source.selectors.checkoutQuantity ? 'checkoutQuantity' : 'quantity']);
            stage = screen.selector('checkoutStage',nodes)!;
            // 诊断：导出结算页完整节点清单，用于定位商品金额/配送费/打包费等字段节点。
            try {
              const {writeFile}=await import('node:fs/promises');
              const rows=nodes.map(n=>`${(n.attrs.class??'').split('.').at(-1)}|${n.attrs['resource-id']??''}|${textOf(n)}`);
              await writeFile(`.runtime/checkout-tree-${Date.now()}.txt`,rows.join('\n'));
            } catch {}
            screen.selector('point',nodes);
            screen.selector('delivery',nodes);
            await unavailability(nodes);
          }
          const checkoutItems=visualCheckout ? [] as UiNode[] : ownedCart(nodes,true);
          if(couponEntry&&couponAllowed)emit?.({phase:'coupon_checkout',state:'succeeded',data:{policy:context.couponPolicy,action:'已点击领券结算，实际抵扣以结算证据为准'}});
          if(task.specified) {
            const finalize=async (read: Awaited<ReturnType<typeof verifyCheckout>>, proofs: Evidence[])=>{
              evidence=read.evidence;
              stepEnd({state:'succeeded',data:{pageCount:proofs.length,mode:visualCheckout?'visual':'structural'},evidenceIds:proofs.map(p=>p.id)});
              const frozen=context!;
              const component=(value:{fen:number;raw:string}|null):MoneyComponent=>value?{amount_fen:value.fen,raw_value:value.raw,basis:'separately_displayed',included_in:'checkout_payable'}:
                {amount_fen:null,raw_value:null,basis:'unknown',included_in:null};
              // 门店页底部的“运费”与打包费在京东外卖合并展示；结算页没有独立行时用门店页读到的运费补上。
              const deliveryValue=read.components.delivery;
              const packagingValue=read.components.packaging;
              const complete=deliveryValue!==null&&packagingValue!==null;
              observation={observation_id:randomUUID(),source_id:task.source_id,tenant_id:task.tenant_id,slot_id:task.slot_id,attempt_id:attemptId,platform,
                store_id:task.store_id,basket_id:task.basket_id,scenario_id:task.scenario_id,price_kind:'checkout_payable',price_scope:'basket',currency:'CNY',
                amount_fen:read.total,raw_value:read.raw,components:{delivery_fee:component(deliveryValue),packaging_fee:component(packagingValue)},
                missing_reasons:{...(deliveryValue===null?{delivery_fee:'not_verified'}:{}),...(packagingValue===null?{packaging_fee:'not_verified'}:{})},
                observed_at:read.evidence.captured_at,collected_at:new Date().toISOString(),value_origin:'observed',quote_valid:true,detail_complete:complete,
                basket_items:[{product_id:frozen.target.id,name:item.name,variant:item.spec,quantity:1}],account_ref:task.account_ref,delivery_point_id:task.delivery_point_id,
                entry_point:task.entry_point,evidence_refs:[read.evidence],contract_version:task.contract_version,collector_version:'android-0.4.0',
                details:{components:read.components,subtotalBasis:read.basis,feesSeparate:read.feesSeparate,eta:read.eta,coupons:read.coupons,couponCandidates:read.couponCandidates,
                  missing:read.missing,reconciled:read.reconciled,contextEvidence:cartProof!,storeEvidence:shopProof,itemEvidence:optionProof,fieldResults:read.fieldResults,supplementaryEvidence:read.supplementaryEvidence}};
              await menuJob;
              quoteReadyAt=new Date().toISOString();status=complete?'success':'partial';availability='available';
              emit?.({phase:'model_verify',state:'succeeded',data:{checkoutFen:read.total,verifiedFields:Object.values(read.fieldResults??{}).filter(f=>f.status==='verified').length},evidenceIds:proofs.map(p=>p.id)});
            };
            const failVerify=(error:unknown)=>{observation=null;status='failed';error_code=error instanceof CollectionError?error.code:/^model_[a-z_0-9]+$/.test((error as Error).message)?(error as Error).message:'checkout_model_failed';emit?.({phase:'model_verify',state:'failed',errorCode:error_code});};
            if(visualCheckout){
              emit?.({phase:'model_verify',state:'started',data:{mode:'visual'}});
              const visualRead=async()=>{
                try { return await captureVisualCheckout(screen,model,evidenceStore,attemptId,signal,[shopProof.id,optionProof.id,cartProof?.id??""],{itemName:item.name,quantity:context!.quantity}); }
                catch(error){
                  // 点了立即购买但页面还停在商品详情：重按一次再读，仍不是结算页就如实失败。
                  if(error instanceof CollectionError && error.code==='not_on_checkout_screen' && buyNowTap){
                    await screen.device.tap(buyNowTap.x,buyNowTap.y);
                    await wait(1_800,undefined,{signal});
                    return captureVisualCheckout(screen,model,evidenceStore,attemptId,signal,[shopProof.id,optionProof.id,cartProof?.id??""],{itemName:item.name,quantity:context!.quantity});
                  }
                  throw error;
                }
              };
              checkoutJob=visualRead().then(read=>finalize(read,[read.evidence])).catch(failVerify);
            }else{
              const captured=await captureCheckout(screen,nodes,checkoutItems,evidenceStore,signal,[shopProof.id,optionProof.id,cartProof?.id??""]);
              // 结算页费用明细可能在首屏下方：滚动一次读取运费/打包费（用户确认结算页有运费显示）。
              try {
                const viewport=await screen.device.size();
                await screen.device.swipe?.({x:viewport.width/2,y:viewport.height*.78},{x:viewport.width/2,y:viewport.height*.32},signal);
                await wait(700,undefined,{signal});
                const feeNodes=await screen.nodes(true).catch(()=>[] as UiNode[]);
                const feeNode=feeNodes.find(node=>/(运费|配送费|打包费)¥?\d/.test(textOf(node)));
                const feeMatch=feeNode?/(?:运费|配送费|打包费)¥?(\d+(?:\.\d+)?)/.exec(textOf(feeNode)):null;
                if (feeMatch) storeFreightFen=Math.round(Number(feeMatch[1])*100);
                emit?.({phase:'fee_probe',state:'started',data:{found:!!feeNode,text:feeNode?textOf(feeNode).slice(0,24):null,fen:storeFreightFen}});
              } catch {}
              evidence=captured.proofs[0]!;
              emit?.({phase:'model_verify',state:'started'});
              checkoutJob=verifyCheckout(captured,model,attemptId,signal,source.subtotalBasis,source.feesSeparate).then(read=>finalize(read,captured.proofs)).catch(failVerify);
            }
          } else {
          const fields = Object.fromEntries(Object.entries(source.fields).filter(([k])=>!k.startsWith('catalog') && !k.startsWith('coupon')).map(([k,v])=>[k,screen.field(v,nodes)]));
          const couponRows = source.couponRowResource ? nodes.filter(n=>resourceOf(n)===source.couponRowResource).slice(0,10).map(flatten) : [nodes];
          const couponFields = Object.entries(source.fields).filter(([k])=>k.startsWith('coupon'));
          const couponData = couponRows.map(row=>Object.fromEntries(couponFields.map(([k,v])=>[k,screen.field(v,row)]))).filter(row=>row.couponName);
          const payable = fields.payable;
          if (!payable) throw new CollectionError('checkout_amount_missing');
          const frame = await screen.capture([stage!,...checkoutItems,...Object.entries(fields).flatMap(([k,v])=>v && k!=='current' && k!=='reference' ? [v.node] : []),
            ...couponData.flatMap(row=>Object.values(row).flatMap(v=>v?.node ?? []))]);
          evidence = await evidenceStore.save(randomUUID(),'checkout',frame.image,
            JSON.stringify({fields:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v?.raw ?? null])),coupons:couponData.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v?.raw ?? null]))),contextProof:[shopProof.id,optionProof.id,cartProof?.id??""]}),'live',frame.at);
          stepEnd({state:'succeeded',evidenceIds:[evidence.id]});
          stepStart('model_verify');
          const result = await model.json(attemptId,'checkout_read','读取截图中结算应付金额的原文，只返回 { "payable": "金额原文" }，未显示则为 null。',{field:source.fields.payable.prefix},priceCheck,{image:frame.image,signal,evidenceIds:[evidence.id]});
          const total = parseCny(payable.raw);
          const modelFen=moneyReading(result.payable);
          if (modelFen!==total) {
            stepEnd({state:'failed',errorCode:'amount_evidence_mismatch',data:{structuralFen:total,modelFen},evidenceIds:[evidence.id]});
            throw new CollectionError('amount_evidence_mismatch');
          }
          const toReading = (raw: string | undefined, subtract = false): Reading | null => {
            if (!raw) return null;
            try { return {raw,fen:parseCny(subtract ? raw.replace(/^[−-]\s*/,'') : raw),evidence:evidence!}; }
            catch { return null; }
          };
          const components = Object.fromEntries(breakdownKeys.map(k=>[k,toReading(fields[k]?.raw,k==='discount')])) as QuoteDetails['components'];
          // 结算页没有独立运费/打包费行（或未展开）时，用门店页或滚动读到的运费补上（用户确认运费即打包费）。
          if (storeFreightFen!==null) {
            const freightReading={raw:(storeFreightFen/100).toFixed(2),fen:storeFreightFen,evidence:evidence!};
            if (!components.delivery) components.delivery=freightReading;
            if (!components.packaging) components.packaging=freightReading;
          }
          const missing: Record<string,string> = {};
          for (const k of breakdownKeys) if (!components[k]) missing[k]=fields[k] ? '金额口径不明确' : '结算页未显示或尚未配置';
          const known = Object.values(components).every(v=>v!==null) && source.feesSeparate===true && source.subtotalBasis!=='unknown';
          if (known && components.subtotal!.fen+components.packaging!.fen+components.delivery!.fen+components.other!.fen-
              (source.subtotalBasis==='before_discount' ? components.discount!.fen : 0)!==total) throw new CollectionError('amount_breakdown_mismatch');
          const eta = fields.eta?.raw ? {raw:fields.eta.raw,evidence} : null;
          if (!eta) missing.eta='页面未显示或尚未配置';
          const coupons = couponData.map(row=>({
            label:row.couponName!.raw,rule:row.couponRule?.raw ?? null,threshold:row.couponThreshold?.raw ?? null,basis:row.couponBasis?.raw ?? null,
            scope:row.couponScope?.raw ?? null,validTime:row.couponTime?.raw ?? null,memberCondition:row.couponMember?.raw ?? null,stacking:row.couponStacking?.raw ?? null,
            eligible:row.couponEligible?.raw==='可用' ? true : row.couponEligible?.raw==='不可用' ? false : null,applied:toReading(row.couponApplied?.raw,true)
          }));
          if (!coupons.length) missing.coupons='未读取到可核对的券明细';
          const costComponent = (value: Reading | null): MoneyComponent => value ? {amount_fen:value.fen,raw_value:value.raw,basis:'separately_displayed',included_in:'checkout_payable'} :
            {amount_fen:null,raw_value:null,basis:'unknown',included_in:null};
          const complete = components.delivery!==null && components.packaging!==null;
          observation = {
            observation_id:randomUUID(),source_id:task.source_id,tenant_id:task.tenant_id,slot_id:task.slot_id,attempt_id:attemptId,platform,
            store_id:task.store_id,basket_id:task.basket_id,scenario_id:task.scenario_id,price_kind:'checkout_payable',price_scope:'basket',currency:'CNY',
            amount_fen:total,raw_value:payable.raw,components:{delivery_fee:costComponent(components.delivery),packaging_fee:costComponent(components.packaging)},
            missing_reasons:{...(!components.delivery ? {delivery_fee:'not_visible'} : {}),...(!components.packaging ? {packaging_fee:'not_visible'} : {})},
            observed_at:frame.at,collected_at:new Date().toISOString(),value_origin:'observed',quote_valid:true,detail_complete:complete,
            basket_items:[{product_id:context.target.id,name:item.name,variant:item.spec,quantity:context.quantity}],account_ref:task.account_ref,
            delivery_point_id:task.delivery_point_id,entry_point:task.entry_point,evidence_refs:[evidence],contract_version:task.contract_version,collector_version:'android-0.2.0',
            details:{components,subtotalBasis:source.subtotalBasis,feesSeparate:source.feesSeparate,eta,coupons:coupons.length ? coupons : null,missing,reconciled:known,contextEvidence:cartProof!,storeEvidence:shopProof,itemEvidence:optionProof}
          };
          note('quote','已核对结算应付与页面证据。');
          status = complete ? 'success' : 'partial';
          availability = 'available';
          quoteReadyAt=new Date().toISOString();
          stepEnd({state:'succeeded',data:{checkoutFen:total,structuralFen:total,modelFen},evidenceIds:[evidence.id]});
          }
        } catch (error) {
          const code=error instanceof CollectionError ? error.code : signal.aborted ? 'window_missed' : 'android_collection_failed';
          stepEnd({state:error instanceof CollectionError && error.status==='blocked' ? 'blocked' : 'failed',errorCode:code,evidenceIds:evidence ? [evidence.id] : []});
          throw error;
        } finally {
          if (inCheckout || cleanup==='quarantined') {
            stepStart('restore');
            const restoreStarted=Date.now();
            try {
              if (cleanup==='untouched' && inCheckout) {
                // 立即购买不修改购物车：退出结算页即可，不做任何购物车操作；随后核对购物车徽标没有变化。
                await screen.device.back();
                await wait(500,undefined,{signal});
                let cartBadgeAfter: string | null = null;
                let cartCountAfter: number | null = null;
                try {
                  const after=await screen.nodes(true);
                  const size=await screen.device.size();
                  const badge=after.find(node=>/^\d{1,3}$/.test(textOf(node)) && node.bounds.top>size.height*0.85 && node.bounds.left<size.width*0.35);
                  if (badge) { cartBadgeAfter=textOf(badge); cartCountAfter=Number(textOf(badge)); }
                  else {
                    const label=after.map(textOf).find(value=>/购物车|暂无商品/.test(value));
                    cartBadgeAfter=label?.slice(0,60) ?? null;
                    cartCountAfter=cartCount(cartBadgeAfter);
                  }
                } catch { /* 读取失败时不冒充已核对，计数保持 null。 */ }
                const cartCountBefore=cartCount(cartBadgeBefore);
                if (cartCountBefore!==null && cartCountAfter!==null && cartCountBefore!==cartCountAfter)
                  throw new CollectionError('cart_changed_after_buy_now','blocked');
                stepEnd({state:'succeeded',data:{cleanup,mode:'leave_checkout_only',cartBadgeBefore,cartBadgeAfter,cartCountBefore,cartCountAfter}});
              } else {
                const emptyProof=await restore(inCheckout);
                stepEnd({state:'succeeded',data:{cleanup},evidenceIds:emptyProof?[emptyProof.id]:[]});
              }
            } catch (error) {
              stepEnd({state:'failed',errorCode:'cleanup_failed',data:{cleanup,reason:error instanceof CollectionError ? error.code : null}});
              note('cleanup','购物车状态需人工核对，已暂停对应设备及账号。');
            }
            screen.metrics.cleanupMs=Date.now()-restoreStarted;
          }
          await checkoutJob;
        }
      } catch (error) {
        status = error instanceof CollectionError ? error.status : 'failed';
        availability = error instanceof CollectionError ? error.availability : 'unknown';
        const knownCode = (error as Error).message;
        error_code = error instanceof CollectionError ? error.code : signal.aborted ? 'window_missed' : /^(model_[a-z_]+\d*|network_error)$/.test(knownCode) ? knownCode : 'android_collection_failed';
        observation = null;
        stepEnd({state:status==='blocked' ? 'blocked' : 'failed',errorCode:error_code,evidenceIds:evidence ? [evidence.id] : []});
        note('stop',error_code);
      } finally {
        await menuJob;
        await checkoutJob;
        if (device && source) await device.close();
      }
      return {status,error_code,availability,observation,evidence,market,menuPriceReason,resolvedLive,quoteReadyAt,pageMap,timings:metrics,trace,started_at,finished_at:new Date().toISOString(),cleanup,cost:{model_yuan:cost(attemptId),execution_ms:Date.now()-start}};
    }
  };
}
