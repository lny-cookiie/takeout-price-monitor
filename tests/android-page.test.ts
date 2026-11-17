import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { UiNode, UITreeSnapshot } from '@midscene/core';
import { cropBoxes } from '../src/adapters/android-page.js';
import { ReviewedScreen } from '../src/adapters/android-collector.js';
import { menuRows, pilotStoreHeader, returnToJdMenu } from '../src/adapters/jd-shelf-collector.js';
import type { AndroidSource, JdShelfCalibration, Selector } from '../src/adapters/android-source.js';
import type { AndroidSession } from '../src/adapters/android-transport.js';
import {requireAndroidForeground} from '../src/adapters/android-transport.js';

const pkg='test.market.app';
const sel=(text:string,resource:string):Selector=>({text,resource});
const source:AndroidSource={
  platform:'jd',entry:'test-entry',package:pkg,appVersion:'1',device:'phone1',account:'account-1',point:'point-1',
  access:{reviewedBy:'test',reference:'local only',expiresAt:'2099-01-01T00:00:00Z',allowedUse:'competition_monitoring'},
  selectors:{
    home:sel('外卖','home'),search:sel('搜索','search'),searchInput:sel('输入','searchInput'),result:sel('结果','result'),
    store:sel('门店','store'),address:sel('地址','address'),item:sel('商品','item'),selectedSpec:sel('规格','spec'),
    add:sel('加入','add'),cartEmpty:sel('购物车为空','empty'),cartLine:sel('商品 规格','line'),quantity:sel('×{quantity}','quantity'),
    checkout:sel('去结算','checkout'),checkoutStage:sel('确认订单','stage'),delivery:sel('配送','delivery'),
    point:sel('固定点位','point'),remove:sel('减少','remove')
  },
  fields:{payable:{resource:'payable',prefix:''}},
  subtotalBasis:'unknown',feesSeparate:null
};

const node=(text:string,bounds:UiNode['bounds'],resource='x'):UiNode=>({type:'text',attrs:{package:pkg,class:'android.widget.TextView','resource-id':resource,text},bounds,children:[]});
const snapshot=(children:UiNode[]):UITreeSnapshot=>({platform:'android',capturedAt:Date.now(),root:{type:'root',attrs:{package:pkg},bounds:{left:0,top:0,width:373,height:843},children}});
const device=(tree:()=>Promise<UITreeSnapshot>,png:Buffer):AndroidSession=>({
  getUITree:tree,
  async size(){return {width:373,height:843};},
  async launch(){},
  async tap(){},
  async search(){},
  async back(){},
  async screenshot(){return png;},
  async close(){}
});
const image=()=>sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1260" height="2844"><rect width="1260" height="2844" fill="white"/><rect width="1260" height="900" fill="gray"/></svg>')).png().toBuffer();

test('输入前检查实际前台；其他应用立即停止，切页短暂无焦点可等待一次',async()=>{
  const signal=AbortSignal.timeout(3000),target='test.market.app';
  await requireAndroidForeground(async()=>`mCurrentFocus=Window{abc u0 ${target}/.MainActivity}`,target,signal);
  await assert.rejects(()=>requireAndroidForeground(async()=>'mCurrentFocus=Window{abc u0 other.app/.MainActivity}',target,signal),(e:unknown)=>(e as {code:string}).code==='target_app_not_foreground');
  let reads=0;await requireAndroidForeground(async()=>++reads===1?'mCurrentFocus=null':`mCurrentFocus=Window{abc u0 ${target}/.MainActivity}`,target,signal);assert.equal(reads,2);
  await assert.rejects(()=>requireAndroidForeground(async()=>'mCurrentFocus=null',target,signal),(e:unknown)=>(e as {code:string}).code==='foreground_state_unknown');
});

test('其他应用的验证码不能被归为京东访问受限；目标应用验证仍会停止',async()=>{
  const verify=node('请完成验证',{left:20,top:100,width:200,height:40});
  const target=snapshot([verify]);
  const screen=new ReviewedScreen(device(async()=>target,Buffer.alloc(0)),source,{},AbortSignal.timeout(5_000));
  await assert.rejects(()=>screen.nodes(),(error:unknown)=>(error as {code:string}).code==='captcha_required');
  const other=snapshot([{...verify,attrs:{...verify.attrs,package:'other.app'}}]);other.root.attrs.package='other.app';
  const diagnostics:unknown[]=[];
  const foreign=new ReviewedScreen(device(async()=>other,Buffer.alloc(0)),source,{},AbortSignal.timeout(5_000),s=>diagnostics.push(s));
  await assert.rejects(()=>foreign.nodes(),(error:unknown)=>(error as {code:string}).code==='entry_mismatch');
  assert.match(JSON.stringify(diagnostics),/other.app/);assert.doesNotMatch(JSON.stringify(diagnostics),/请完成验证/);
});

test('cropBoxes clamps the 373.33 logical width instead of failing',()=>{
  const n=node('¥26.50',{left:0,top:100,width:373.33,height:20},'price');
  const r=cropBoxes(n,{width:373,height:843},{width:1260,height:2844});
  assert.equal(r.skipped,null);
  assert.equal(r.boxes.length,1);
  assert.ok(r.boxes[0]!.left>=0 && r.boxes[0]!.left+r.boxes[0]!.width<=1260);
  assert.ok(r.boxes[0]!.top>=0 && r.boxes[0]!.top+r.boxes[0]!.height<=2844);
});

test('cropBoxes splits a tall node and redacts phone numbers',()=>{
  const tall=node('门店信息',{left:0,top:100,width:373,height:300},'tall');
  const split=cropBoxes(tall,{width:373,height:843},{width:1260,height:2844});
  assert.equal(split.skipped,null);
  assert.ok(split.boxes.length>1);
  assert.ok(split.boxes.every(b=>b.height<=Math.floor(2844*.22)+1));
  const phone=node('联系电话 13800138000',{left:0,top:100,width:373,height:30},'phone');
  const redacted=cropBoxes(phone,{width:373,height:843},{width:1260,height:2844});
  assert.equal(redacted.skipped,null);
  assert.match(redacted.text,/\*\*\*/);
  assert.doesNotMatch(redacted.text,/13800138000/);
  assert.equal(redacted.redactions.length,1);
  assert.ok(redacted.redactions[0]!.width>0 && redacted.redactions[0]!.height>0);
});

test('cropBoxes skips a node that is outside the frame',()=>{
  const n=node('离屏',{left:-20,top:100,width:5,height:20},'offscreen');
  const r=cropBoxes(n,{width:373,height:843},{width:1260,height:2844});
  assert.equal(r.skipped,'out_of_bounds');
  assert.equal(r.boxes.length,0);
});

test('capture tolerates a 1 pixel rounding difference at 373.33',async()=>{
  const n=node('¥26.50',{left:0,top:100,width:373.33,height:20},'price');
  const png=await image();
  const screen=new ReviewedScreen(device(async()=>snapshot([n]),png),source,{},AbortSignal.timeout(5_000));
  const frame=await screen.capture([n]);
  assert.equal(frame.locations.length,1);
  assert.ok(frame.image.length>0);
});

test('stable shelf pixels reuse the tree and changed pixels require a fresh tree',async()=>{
  const row=node('麦辣鸡翅，已售48',{left:40,top:100,width:150,height:28},'row');
  const png=await image();
  let treeReads=0;
  const signal=AbortSignal.timeout(5_000);
  const screen=new ReviewedScreen(device(async()=>{treeReads++;return snapshot([row]);},png),source,{},signal);
  await screen.capture([row],{before:png,signal});
  assert.equal(treeReads,0);
  const changed=await sharp(png).negate().png().toBuffer();
  await screen.capture([row],{before:changed,signal});
  assert.equal(treeReads,1);
});

test('menuRows classifies every configured pilot single',()=>{
  const names=['板烧鸡腿堡','麦辣鸡腿堡','双层吉士堡','薯条','可乐'];
  const children=names.map((name,i)=>node(`${name}，已售${10-i}`,{left:20,top:100+i*80,width:300,height:40},`item-${i}`));
  const root:UiNode={type:'root',attrs:{package:pkg},bounds:{left:0,top:0,width:400,height:760},children};
  const locator={resource:'anchor'}, field={prefix:'x'};
  const cal:JdShelfCalibration={searchResults:locator,resultCard:locator,resultName:field,identity:locator,storeName:field,city:field,address:field,
    menu:locator,itemCard:locator,itemName:field,
    pilot:{storeId:'a'.repeat(64),name:'门店',address:'地址',reference:'ref',queryResource:'q',resultLabel:'r',singleName:names[0]!,singleSpec:'1人份',
      singles:names.map((name,i)=>({name,spec:i===0?'1人份':'标准份',options:[]}))}};
  const screen=new ReviewedScreen({} as AndroidSession,source,{},AbortSignal.timeout(1_000));
  const page=menuRows(screen,cal,root,{key:'store',name:'门店',brand:'品牌',city:'市',address:'地址'});
  assert.equal(page.rows.length,5);
  assert.equal(page.rows.filter(row=>row.snapshot.kind==='single' && row.snapshot.supply).length,5);
  assert.deepEqual(page.rows.map(row=>row.snapshot.spec),['1人份','标准份','标准份','标准份','标准份']);
});

test('menuRows auto mode classifies non-package cards as singles waiting for specs',()=>{
  const names=['板烧鸡腿堡','麦辣鸡腿堡','双层吉士堡','薯条','可乐'];
  const children=names.map((name,i)=>node(`${name}，已售${10-i}`,{left:20,top:100+i*80,width:300,height:40},`item-${i}`));
  const root:UiNode={type:'root',attrs:{package:pkg},bounds:{left:0,top:0,width:400,height:760},children};
  const locator={resource:'anchor'}, field={prefix:'x'};
  const cal:JdShelfCalibration={searchResults:locator,resultCard:locator,resultName:field,identity:locator,storeName:field,city:field,address:field,
    menu:locator,itemCard:locator,itemName:field,
    pilot:{storeId:'a'.repeat(64),name:'门店',address:'地址',reference:'ref',queryResource:'q',resultLabel:'r',singleName:names[0]!,singleSpec:'1人份',autoSingles:true}};
  const screen=new ReviewedScreen({} as AndroidSession,source,{},AbortSignal.timeout(1_000));
  const page=menuRows(screen,cal,root,{key:'store',name:'门店',brand:'品牌',city:'市',address:'地址'});
  assert.equal(page.rows.length,5);
  assert.equal(page.rows.filter(row=>row.snapshot.kind==='single').length,5);
  assert.equal(page.rows.filter(row=>row.snapshot.spec===null).length,4);
});

test('returnToJdMenu closes an open cart panel and stops on the menu',async()=>{
  const locator={resource:'anchor'}, field={prefix:''};
  const cal:JdShelfCalibration={searchResults:locator,resultCard:locator,resultName:field,identity:locator,storeName:field,city:field,address:field,
    menu:{resource:'menu'},itemCard:locator,itemName:field};
  const panel=node('全选',{left:0,top:700,width:373,height:100},'panel');
  const menu=node('菜单',{left:0,top:100,width:373,height:600},'menu');
  const cartTree=snapshot([panel]), menuTree=snapshot([menu]);
  let page:'cart'|'menu'='cart', backs=0;
  const png=await image();
  const session=device(async()=>page==='cart' ? cartTree : menuTree,png);
  session.back=async()=>{backs++;page='menu';};
  const src:AndroidSource={...source,selectors:{...source.selectors,cartPanel:sel('全选','panel')},jdShelf:cal};
  const screen=new ReviewedScreen(session,src,{},AbortSignal.timeout(5_000));
  await returnToJdMenu(screen,AbortSignal.timeout(5_000));
  assert.equal(backs,1);
  assert.equal(page,'menu');
  await returnToJdMenu(screen,AbortSignal.timeout(5_000));
  assert.equal(backs,1);
});

test('waitFor treats a foreign first tree as a transition',async()=>{
  const home=node('外卖',{left:0,top:0,width:120,height:40},'home');
  const foreignHome={...home,attrs:{...home.attrs,package:'com.other.app'}} as UiNode;
  const foreignTree:UITreeSnapshot={platform:'android',capturedAt:Date.now(),root:{type:'root',attrs:{package:'com.other.app'},bounds:{left:0,top:0,width:373,height:843},children:[foreignHome]}};
  let calls=0;
  const png=await image();
  const screen=new ReviewedScreen(device(async()=>{
    calls++;
    return calls===1 ? foreignTree : snapshot([home]);
  },png),source,{},AbortSignal.timeout(5_000));
  const nodes=await screen.waitFor(['home']);
  assert.equal(calls,2);
  assert.ok(nodes.some(n=>n.attrs['resource-id']==='home'));
});

test('页面读取恢复瞬时失败，持续失败在有限重试后停止',async()=>{
  const home=node('外卖',{left:0,top:0,width:120,height:40},'home');
  const png=await image();
  let calls=0;
  const screen=new ReviewedScreen(device(async()=>{
    if (++calls===1) throw new Error('Android hierarchy unavailable');
    return snapshot([home]);
  },png),source,{},AbortSignal.timeout(5_000));
  const nodes=await screen.waitFor(['home'],{onLaunch:true});
  assert.ok(nodes.some(n=>n.attrs['resource-id']==='home'));
  assert.equal(calls,2);
  calls=0;
  await screen.waitFor(['home']);
  assert.equal(calls,2);
  let failures=0;
  const broken=new ReviewedScreen(device(async()=>{failures++;throw new Error('Android hierarchy unavailable');},png),source,{},AbortSignal.timeout(8_000));
  await assert.rejects(broken.waitFor(['home']),{code:'screen_unreadable'});
  assert.equal(failures,3);
});

test('pilot store header follows the live card anchor without allowing another row',()=>{
  const viewport={width:373,height:843};
  const anchor=node('好评榜',{left:179.26,top:212.44,width:130.07,height:15.11},'anchor');
  const header=pilotStoreHeader(anchor,viewport);
  assert.ok(header && header.x>200 && header.x<220 && header.y>180 && header.y<190);
  assert.equal(pilotStoreHeader({...anchor,bounds:{...anchor.bounds,top:420}},viewport),undefined);
});
