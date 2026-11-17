import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { UiNode } from '@midscene/core';
import { AndroidSources, type AndroidSource } from '../src/adapters/android-source.js';
import { androidCollector, ReviewedScreen } from '../src/adapters/android-collector.js';
import { cropBoxes } from '../src/adapters/android-page.js';
import { prepareAndroidDisplay, type AndroidSession } from '../src/adapters/android-transport.js';
import { ModelGateway, type ModelAudit } from '../src/infra/model.js';
import { EvidenceStore } from '../src/infra/evidence.js';
import { CompetitionStore } from '../src/infra/competition-store.js';
import { SqliteStore } from '../src/infra/sqlite-store.js';
import { comparePair, comparisonRows } from '../src/application/comparison.js';
import { BUSINESS_VERSION, digest, itemGate, liveSources, storeGate, type Eligibility, type Mapping, type Supply, type Target } from '../src/domain/competition.js';
import { checkResult, TENANT, type AttemptResult, type Platform, type Slot, type Task } from '../src/domain/contracts.js';
import { createApplication } from '../src/http/app.js';
import { setTimeout as delay } from 'node:timers/promises';

const supply:Supply={store:{key:'0005',name:'测试咖啡店',brand:'测试品牌',city:'测试市',address:'测试路1号'},item:{key:'007',name:'拿铁',kind:'single',spec:'500ml',options:[],parts:null}};
const eligibility:Eligibility={accountRef:'reviewed-account',platformCustomer:'existing',storeCustomer:'existing',memberSegment:'非会员',memberProduct:'',memberTier:'',benefits:[],evidence:'资格核对记录',storeEvidence:'本店的资格记录',storeKey:'0005'};
const target:Target={id:'item-1',revision:digest(supply),supply,reference:'样例'};
const same={relation:'exact' as const,reason:'证据支持地址和规格一致',missing:[]};
function task(platform:Platform,source?:AndroidSource):Task {
  const now=Date.now();
  const mapping:Mapping={id:'mapping-'+platform,targetId:target.id,targetRevision:target.revision,
    candidate:{platform,entry:'reviewed-entry',supply,reference:'核对记录'},store:same,item:same,status:'verified',proposedAt:new Date(now).toISOString(),reviewedAt:new Date(now).toISOString()};
  return {contract_version:BUSINESS_VERSION,tenant_id:TENANT,source_id:liveSources[platform],slot_id:'slot-'+platform,run_id:'run',comparison_group_id:'group',platform,
    store_id:supply.store.key,basket_id:target.id,scenario_id:'scenario',entry_point:'reviewed-entry',account_ref:eligibility.accountRef,device_ref:'phone1',
    delivery_point_id:'point-1',due_at:new Date(now-1000).toISOString(),deadline_at:new Date(now+240_000).toISOString(),data_mode:'live',fault:'none',
    max_attempts:2,timeout_seconds:240,requested_fields:['checkout_payable','delivery_fee','packaging_fee'],required_fields:['checkout_payable'],
    allowed_actions:['browse','select_variant','modify_owned_test_cart','read_checkout'],
    live:{target,mapping,profile:{id:'test',city:supply.store.city,name:'平台老客、非会员',point:'point-1',checkedAt:new Date(now-60_000).toISOString(),validUntil:new Date(now+600_000).toISOString(),eligibility:{[platform]:{...eligibility}}},
      planName:'测试',meal:'lunch',quantity:1,couponPolicy:'page_applied',sourceRevision:source?digest(source):null}};
}
test('熄屏时只发送唤醒指令，锁屏或状态不明时停止',async()=>{
  for (const showing of [false,true,null]) {
    const commands:string[]=[];
    let wakefulness='Asleep';
    const preparing=prepareAndroidDisplay(async args=>{
      const command=args.join(' ');
      commands.push(command);
      if (command==='dumpsys power') return `mWakefulness=${wakefulness}`;
      if (command==='input keyevent KEYCODE_WAKEUP') { wakefulness='Awake'; return ''; }
      assert.equal(command,'dumpsys window policy');
      return showing===null ? 'screenState=SCREEN_STATE_ON' : `KeyguardServiceDelegate\r\n  showing=${showing}\r\n  screenState=SCREEN_STATE_ON`;
    },new AbortController().signal);
    if (showing===false) await preparing;
    else await assert.rejects(preparing,{message:showing ? 'device_screen_locked':'device_lock_state_unknown'});
    assert.deepEqual(commands,['dumpsys power','input keyevent KEYCODE_WAKEUP','dumpsys power','dumpsys window policy']);
  }
});
test('真机任务中断后，排队中的同设备任务被标记为暂停，另一台设备仍可运行',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'takeout-resume-test-'));
  const path=join(dir,'recovery.sqlite');
  const slots=[task('jd'),task('meituan'),{...task('taobao_instant'),device_ref:'phone2'}];
  const now=new Date().toISOString();
  const store=new SqliteStore(path);
  try {
    store.createRun({id:'run',scenario:'competition',created_at:now,label:'中断测试',schedule_key:null},slots);
    const claim=store.claim('jd',now,'live');
    assert.ok(claim);
    store.recordStep(claim,{phase:'sku_match',state:'started'});
    store.recordStep(claim,{phase:'sku_match',state:'succeeded',data:{item:'拿铁',recipient:'不能入日志',note:'手机号 13800000000'}});
    store.recordStep(claim,{phase:'cart',state:'started'});
    assert.equal(store.claim('meituan',now,'live'),null);
  } finally {store.close();}
  const restarted=new SqliteStore(path);
  try {
    assert.equal(restarted.recoverInterrupted(),1);
    const view=restarted.snapshot('run');
    assert.equal(view.slots.find(s=>s.task.platform==='jd')?.state,'interrupted');
    const steps=[...restarted.attemptSteps('run').values()][0]!;
    assert.deepEqual(steps.map(s=>[s.phase,s.state]),[['sku_match','started'],['sku_match','succeeded'],['cart','started'],['cart','interrupted']]);
    assert.deepEqual(steps[1]?.data,{item:'拿铁',note:'手机号 [手机号已隐藏]'});
    const report=new CompetitionStore(restarted,await AndroidSources.load(join(dir,'no-sources.json'))).runDetails('run');
    assert.equal(report?.slots.find(s=>s.platform==='jd')?.attempts[0]?.steps.at(-1)?.state,'interrupted');
    const paused=view.slots.find(s=>s.task.platform==='meituan');
    assert.equal(paused?.state,'source_blocked');
    assert.equal(paused?.block_reason,'process_interrupted');
    assert.equal(paused?.attempts,0);
    assert.equal(restarted.claim('meituan',now,'live'),null);
    assert.ok(restarted.claim('taobao_instant',now,'live'));
  } finally {restarted.close();}
});
test('购物车需要人工确认时暂停同设备队列',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'takeout-cart-quarantine-'));
  const store=new SqliteStore(join(dir,'test.sqlite'));
  try {
    const now=new Date().toISOString();
    store.createRun({id:'run',scenario:'competition',created_at:now,label:'测试',schedule_key:null},[task('jd'),task('meituan')]);
    const claim=store.claim('jd',now,'live');assert.ok(claim);
    store.finish(claim,{status:'failed',error_code:'cleanup_failed',availability:'unknown',observation:null,trace:[],evidence:null,started_at:now,finished_at:now,cleanup:'needs_attention',cost:{model_yuan:null,execution_ms:0}},null);
    assert.equal(store.snapshot('run').slots.find(s=>s.task.platform==='meituan')?.state,'source_blocked');
    assert.throws(()=>store.confirmCartEmpty('slot-meituan'),/cart_confirmation_not_allowed/);
    store.confirmCartEmpty('slot-jd');
    assert.ok(store.snapshot('run').events.some(e=>e.code==='cart_empty_confirmed_by_user'));
    assert.throws(()=>store.confirmCartEmpty('slot-jd'),/cart_confirmation_not_allowed/);
  } finally {store.close();}
});
test('同品牌不同店、同地址不同品牌、容量及套餐组成差异均不能确认',()=>{
  const different=(mutate:(s:Supply)=>void)=>{const copy=structuredClone(supply);mutate(copy);return copy;};
  assert.ok(storeGate(supply,different(s=>s.store.address='测试路2号')));
  assert.ok(storeGate(supply,different(s=>s.store.brand='其他商家')));
  assert.equal(storeGate(supply,different(s=>s.store.address=''))?.relation,'unknown');
  assert.equal(itemGate(supply,different(s=>s.item.spec='0.5升')),null);
  assert.ok(itemGate(supply,different(s=>s.item.spec='700ml')));
  assert.equal(itemGate(supply,different(s=>s.item.options=null))?.relation,'unknown');
  const set=different(s=>{s.item.kind='set';s.item.parts=[{name:'咖啡',spec:'500ml',quantity:1},{name:'三明治',spec:'1份',quantity:1}];});
  const changed=structuredClone(set);changed.item.parts![1]!.quantity=2;
  assert.ok(itemGate(set,changed));
});

test('模型服务通过真实 HTTP 发出文本、图片和 Midscene 定位请求；无效 JSON 被拒绝',async()=>{
  const requests:{auth:string|undefined;body:string}[]=[];
  const server=createServer((req,res)=>{
    void (async()=>{
      let body='';for await(const chunk of req)body+=chunk;
      requests.push({auth:req.headers.authorization,body});
      const content=body.includes('bbox_2d') ? JSON.stringify({bbox_2d:[275,300,727,700],description:'7391'}) :
        body.includes('读取图片中数字') ? '{"value":"7391"}' : body.includes('原样返回') ? '{"value":37}' : '无法识别';
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'local-test',object:'chat.completion',model:'qwen3-vl-plus',
        choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}}));
    })();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  const audit:ModelAudit[]=[];
  const model=new ModelGateway({baseUrl:'http://127.0.0.1:'+address.port+'/v1',key:'loopback-test',model:'qwen3-vl-plus',family:'qwen3-vl',inputRate:1,outputRate:2},r=>audit.push(r));
  try {
    assert.deepEqual(await model.test(),{text:true,vision:true,location:true});
    await assert.rejects(model.json('test','bad_output','输出有效 JSON。',{},x=>x),/model_invalid_output/);
    assert.equal(requests.length,4);
    assert.ok(requests.every(r=>r.auth==='Bearer loopback-test'));
    assert.ok(requests[1]!.body.includes('data:image/png;base64,'));
    assert.equal(audit[2]!.operation,'page_location');
    assert.equal(audit[3]!.ok,false);
    assert.equal(audit[0]!.inputTokens,100);
    assert.ok(!JSON.stringify(audit).includes('loopback-test'));
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

const pkg='test.market.app';
const sel=(text:string,resource:string)=>({text,resource});
const source:AndroidSource={platform:'jd',entry:'reviewed-entry',package:pkg,appVersion:'1',device:'phone1',account:eligibility.accountRef,point:'point-1',
  access:{reviewedBy:'测试',reference:'仅本地回放',allowedUse:'competition_monitoring',expiresAt:'2099-01-01T00:00:00Z'},
  selectors:{
    home:sel('外卖','home'),search:sel('搜索','search'),searchInput:sel('输入','searchInput'),result:sel('{store}','result'),
    store:sel('{store}','store'),address:sel('{address}','address'),item:sel('{item}','item'),selectedSpec:sel('{spec}','spec'),
    add:sel('加入购物车','add'),cartEmpty:sel('购物车为空','empty'),cartLine:sel('{item} {spec}','line'),quantity:sel('×{quantity}','quantity'),
    checkout:sel('去结算','checkout'),checkoutStage:sel('确认订单','stage'),delivery:sel('配送','delivery'),point:sel('固定点位','point'),remove:sel('减少','remove'),increase:sel('+','increase'),
    minimum:sel('未达起送','min')
  },
  fields:{payable:{resource:'payable',prefix:'实付 '},packaging:{resource:'packaging',prefix:'包装费 '},current:{resource:'current',prefix:''},
    reference:{resource:'reference',prefix:''},discount:{resource:'discount',prefix:'优惠 '},couponName:{resource:'coupon',prefix:''},
    couponApplied:{resource:'applied',prefix:''},couponThreshold:{resource:'threshold',prefix:''},couponBasis:{resource:'basis',prefix:''},eta:{resource:'eta',prefix:''}},subtotalBasis:'unknown',feesSeparate:null
};

test('京东一键采集经 HTTP 扫描、排除套餐、双读金额并恢复购物车',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'takeout-jd-run-replay-'));
  const image=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="760"><rect width="400" height="760" fill="white"/><rect width="400" height="190" fill="gray"/></svg>')).png().toBuffer();
  const config:AndroidSource={...source,selectors:{...source.selectors,itemDetail:sel('{item}','item')},jdShelf:{
    menuIdentity:{resource:'store'},
    searchResults:{resource:'results'},resultCard:{resource:'branch'},resultName:{resource:'result',prefix:''},
    identity:{resource:'identity'},storeName:{resource:'store',prefix:''},city:{resource:'city',prefix:''},address:{resource:'address',prefix:''},
    district:{resource:'district',prefix:''},menu:{resource:'menu'},itemCard:{resource:'card'},itemName:{resource:'item',prefix:''},
    itemKind:{resource:'kind',prefix:''},itemSpec:{resource:'spec',prefix:''},itemOptions:{resource:'options',prefix:''},sales:{resource:'sales',prefix:''},
    end:{resource:'end',text:'菜单到底'}
  }};
  await writeFile(join(dir,'android-sources.json'),JSON.stringify([config]));
  const actions:string[]=[];
  const node=(resource:string,text:string,y:number,children:UiNode[]=[],height=20):UiNode=>({type:'text',attrs:{package:pkg,text,'resource-id':resource},
    bounds:{left:40,top:y,width:300,height},children});
  const storeName='测试品牌（红桥店）', brand='测试品牌', city='测试市', district='红桥区', address='测试路1号';
  const item='拿铁', spec='500ml', line=item+' '+spec;
  const menuCard=(name:string,kind:string,sales:string,y:number)=>node('card','',y,[
    node('item',name,y),node('kind',kind,y+24),node('spec',spec,y+48),node('options','无',y+72),node('sales',sales,y+96)
  ],118);
  const screens:Record<string,UiNode[]>={
    home:[node('home','外卖',12),node('point','固定点位',36),node('search','搜索',60)],
    search:[node('searchInput','输入',100)],
    result:[node('results','',100,[node('branch','',105,[node('result',storeName,105)])],120)],
    store:[node('identity','',12,[node('store',storeName,12),node('city',city,36),node('district',district,60),node('address',address,84)],96),
      node('empty','购物车为空',109),node('menu','',140,[menuCard('拿铁双人套餐','套餐','已售 99',145),menuCard(item,'单品','已售 39',272),node('end','菜单到底',400)],310)],
    sku:[node('item',item,12),node('spec',spec,36),node('add','加入购物车',60),node('current','¥20',84),node('reference','¥30',108)],
    cart:[node('line',line,12),node('quantity','×1',36),node('checkout','去结算',140),node('remove','减少',180)],
    checkout:[node('stage','确认订单',12),node('point','固定点位',36),node('delivery','配送',60),node('line',line,84),node('quantity','×1',108),
      node('payable','实付 ¥21.50',600),node('packaging','包装费 ¥0',200),node('submit','提交订单',650)]
  };
  const transitions:Record<string,string>={search:'search',searchInput:'search',branch:'store',item:'sku',add:'cart',checkout:'checkout',remove:'store'};
  let mismatch=false, minimum=false, wrongStore=false,blankSpecOnce=false;
  const modelServer=createServer((req,res)=>{ void (async()=>{
    let body='';for await(const chunk of req)body+=chunk;
    const content=body.includes('bbox_2d') ? '{"bbox_2d":[460,187,490,207],"description":"去结算"}' :
      body.includes('商品现价原文') ? '{"current":"¥20"}' : body.includes('deliveryReference') ? JSON.stringify({payable:'21.50',packaging:'0',delivery:null,subtotal:null,other:null,discount:null,eta:null,subtotalBasis:'unknown',feesSeparate:null,deliveryReference:null,packagingReference:null,coupons:[]}) : mismatch ? '{"payable":"¥21.51"}' : '{"payable":"¥21.50"}';
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}));
  })(); });
  await new Promise<void>(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const modelPort=(modelServer.address() as {port:number}).port;
  const app=await createApplication({dataDir:dir,port:0,model:{baseUrl:'http://127.0.0.1:'+modelPort+'/v1',key:'replay-key',
    model:'qwen3-vl-plus',family:'qwen3-vl',inputRate:null,outputRate:null},androidTransport:async()=>{
    let page='home';
    const view=()=>page==='sku'&&blankSpecOnce?screens.sku!.filter(n=>n.attrs['resource-id']!=='spec'):wrongStore && page==='store' ? [...screens.store!.slice(1),
      node('identity','',12,[node('store',storeName,12),node('city',city,36),node('district',district,60),node('address','测试路2号',84)],96)] :
      minimum && page==='cart' ? [...screens.cart!,node('min','未达起送',206)] : screens[page]!;
    return {async getUITree(){return {platform:'android',capturedAt:Date.now(),root:node('root','',0,view(),760)};},
      async size(){return {width:400,height:760};},async launch(){actions.push('launch');page='home';},
      async tap(_x,y){
        const action=page==='result' ? 'branch' : page==='store' ? 'item' :
          view().find(n=>y>=n.bounds.top && y<n.bounds.top+n.bounds.height)?.attrs['resource-id'];
        assert.ok(action && transitions[action],`禁止或未知动作 ${String(action)}`);
        actions.push(action);page=transitions[action]!;
      },
      async search(text){assert.equal(text,brand);page='result';},async back(){if(page==='sku'){blankSpecOnce=false;page='store';}else page=page==='checkout' ? 'cart' : 'result';},
      async screenshot(){return image;},async close(){}};
  }});
  const json=(method:string,payload:unknown)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const api=(path:string,init?:RequestInit)=>fetch(app.baseUrl+path,init);
  const submit=(body:unknown)=>api('/api/market/jd-runs',json('POST',body));
  async function finish(id:string) {
    const until=Date.now()+18_000;
    let lastReport: unknown;
    do {
      const report=await (await api('/api/market/runs/'+id)).json() as import('../src/ui/jd-runs.js').CollectionRun;
      lastReport=report;
      if (report.state==='completed') return report;
      await delay(100);
    } while (Date.now()<until);
    assert.fail('采集回放未结束：'+JSON.stringify(lastReport));
  }
  try {
    const {storeEvidence:_storeEvidence,storeKey:_storeKey,...profileEligibility}=eligibility;
    const profileResponse=await api('/api/market/profiles',json('PUT',{id:'reviewed',name:'测试配送与账号',city,point:source.point,eligibility:{jd:profileEligibility}}));
    assert.equal(profileResponse.status,200,await profileResponse.text());
    const saved=await api('/api/market/jd-stores',json('POST',{city,district,brand,storeName}));
    assert.equal(saved.status,201);
    const savedStoreId=(await saved.json() as {id:string}).id;
    const input={requestId:randomUUID(),savedStoreId,profileId:'reviewed'};
    const created=await submit(input);
    assert.equal(created.status,202);
    assert.equal((await created.json() as {runId:string}).runId,input.requestId);
    assert.equal((await submit(input)).status,202);
    assert.equal((await submit({...input,profileId:'other-profile'})).status,409);
    const first=await finish(input.requestId);
    assert.equal(first.shelf?.coverage,'complete',JSON.stringify(first.slots[0]));
    assert.equal(first.shelf?.scannedCount,2,'货架扫描数');
    assert.equal(first.shelf?.selected[0]?.rawName,item);
    assert.equal(first.slots.length,2,'运行任务数');
    assert.equal(first.slots[1]?.menuPrices[0]?.fen,2000);
    assert.equal(first.slots[1]?.observation?.amount_fen,2150,JSON.stringify(first.slots[1]));
    assert.equal(first.slots[1]?.context?.address,address);
    assert.equal(first.slots[1]?.context?.user,'平台老客 · 非会员');
    assert.ok((first.executionMs ?? 0)>0);
    const savedWorkspace=await (await api('/api/workspace')).json() as {jdStores:{id:string;verified?:{store:{address:string}}}[]};
    assert.equal(savedWorkspace.jdStores[0]?.verified?.store.address,address);
    assert.ok(first.slots[1]?.attempts[0]?.steps.some(s=>s.phase==='restore' && s.state==='succeeded'));
    assert.equal(actions.filter(a=>a==='remove').length,1);
    assert.equal(actions.filter(a=>a==='launch').length,2,'启动次数：'+actions.join(','));
    assert.equal((await api(first.slots[1]!.proof!.screenshot)).status,200);
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM market_orders').get()?.n,0);
    assert.equal((await api('/api/market/records?runId='+input.requestId)).status,200);
    assert.ok((first.elapsedMs ?? 0)>0);

    mismatch=true;
    const secondId=randomUUID();
    assert.equal((await submit({...input,requestId:secondId})).status,202);
    const second=await finish(secondId);
    assert.equal(second.slots[1]?.error,'amount_evidence_mismatch');
    assert.equal(second.slots[1]?.menuPrices[0]?.fen,2000);
    assert.equal(second.slots[1]?.observation,null);

    minimum=true;
    const minimumId=randomUUID();
    assert.equal((await submit({...input,requestId:minimumId})).status,202);
    const short=await finish(minimumId);
    assert.equal(short.slots[1]?.error,'minimum_not_met');
    assert.equal(short.slots[1]?.menuPrices[0]?.fen,2000);
    assert.equal(short.slots[1]?.observation,null);
    assert.equal(actions.filter(a=>a==='checkout').length,2);
    assert.equal(actions.filter(a=>a==='remove').length,3);

    wrongStore=true;
    const wrongId=randomUUID();
    assert.equal((await submit({...input,requestId:wrongId})).status,202);
    const wrong=await finish(wrongId);
    assert.equal(wrong.slots.length,1);
    assert.equal(wrong.slots[0]?.error,'store_identity_mismatch');
    assert.equal(actions.filter(a=>a==='add').length,3);
    assert.ok(!actions.includes('submit'));
    wrongStore=false;minimum=false;mismatch=false;
    const imported=await api('/api/market/catalog/imports',json('POST',{mode:'commit',source:'trial',records:[{city,district,brand,storeName,itemName:item,spec,is_baoxiao:null,options:[]}]}));
    assert.equal(imported.status,201,await imported.clone().text());
    const targetId=(await imported.json() as {entries:{id:string}[]}).entries[0]!.id;
    const directId=randomUUID(), beforeLaunch=actions.filter(a=>a==='launch').length;
    blankSpecOnce=true;
    assert.equal((await submit({requestId:directId,targetId,profileId:'reviewed'})).status,202);
    const specified=await finish(directId);
    assert.equal(specified.shelf,null);assert.equal(specified.slots.length,1);
    assert.equal(specified.slots[0]?.observation?.amount_fen,2150,JSON.stringify(specified));
    assert.equal(specified.slots[0]?.observation?.details?.fieldResults?.packaging?.status,'verified');
    assert.equal(specified.slots[0]?.cleanup,'restored');
    assert.ok(specified.slots[0]?.quoteMs);assert.equal(actions.filter(a=>a==='launch').length-beforeLaunch,1);
    assert.ok(specified.slots[0]?.attempts[0]?.steps.some(s=>s.phase==='menu_model'));
    assert.ok(specified.slots[0]?.attempts[0]?.steps.some(s=>s.phase==='item_open_retry'&&s.state==='succeeded'));
    assert.equal((await api('/api/market/catalog/'+targetId+'/quotes')).status,200);
  } finally {
    await app.close();
    await new Promise<void>(resolve=>modelServer.close(()=>resolve()));
  }
});
type Screen = [string,string][];
function replay(png:Buffer, minimum=false, jdShape=false, cartTotal=1) {
  const s=supply;
  const line:Screen=[['line','拿铁 500ml'],['quantity','×1']];
  const screens:Record<string,Screen>={
    home:[['home','外卖'],['point','固定点位'],['search','搜索']],
    search:[['searchInput','输入']],
    result:[['result',s.store.name]],
    store:[['store',s.store.name],['address',s.store.address],['item',s.item.name],['empty','购物车为空']],
    sku:[['item',s.item.name],['spec',s.item.spec],['add','加入购物车'],['current','¥20起'],['reference','¥30']],
    cart:[...line,['checkout','去结算'],['remove','减少'],['increase','+'],...(minimum?[['min','未达起送'] as [string,string]]:[])],
    checkout:[['stage','确认订单'],['point','固定点位'],['delivery','配送'],...line,['payable','实付 ¥21.50'],
      ['packaging','包装费 ¥0'],['discount','优惠 -¥4'],['coupon','店铺优惠'],['applied','-¥4'],['eta','预计 35–45 分钟'],['threshold','满¥20'],['basis','折前商品小计']]
  };
  const transitions:Record<string,string>={search:'search',searchInput:'search',result:'store',item:'sku',add:'cart',checkout:'checkout',remove:'store'};
  const noResource=new Set<string>();
  if (jdShape) {
    screens.desktop=[['channel','外卖']];
    screens.channel=[['entryCategory','外卖']];
    screens.typed=[['searchInput','测试品牌'],['searchSubmit','搜索']];
    screens.store=[['store',s.store.name],['address',s.store.address],['category','饮品，未选中'],['empty','购物车为空']];
    screens.menu=[['bundle','拿铁双人套餐，已售39'],['item','拿铁，已售39'],['empty','购物车为空']];
    screens.sku![0]=['itemDetail','\u200b 拿铁'];
    screens.cart![2]=['checkout','去结算，按钮'];
    screens.cart![3]=['remove','减少购买数量，按钮'];
    screens.cart!.push(['cartCount',`门店购物车，${cartTotal}件商品 按钮`],['backgroundQty','×1']);
    screens.checkout![3]=['checkoutLine','拿铁 500ml'];
    screens.checkout![4]=['checkoutQuantity','数量1件'];
    Object.assign(transitions,{channel:'channel',entryCategory:'home',searchSubmit:'result',category:'menu'});
    for (const key of ['channel','entryCategory','category','item','itemDetail','line','checkout','remove']) noResource.add(key);
  }
  const actions:string[]=[];
  let page='home',quantity=1;
  const box=(i:number)=>({left:40,top:15+i*52,width:300,height:36});
  const device:AndroidSession={
    async getUITree(){
      let children=screens[page]!.map(([id,text],i):UiNode=>({type:'text',attrs:{package:pkg,class:'android.widget.TextView',
        'resource-id':noResource.has(id) ? '' : id,text:id==='quantity'?'×'+quantity:text},bounds:box(i),children:[]}));
      if (jdShape && page==='cart') {
        const inside=[0,1,3,4];
        const panel:UiNode={type:'panel',attrs:{package:pkg,'resource-id':'panel'},bounds:{left:0,top:0,width:400,height:310},children:children.filter((_,i)=>inside.includes(i))};
        children=[...children.filter((_,i)=>!inside.includes(i)),panel];
      }
      return {platform:'android',capturedAt:Date.now(),root:{type:'root',attrs:{package:pkg},bounds:{left:0,top:0,width:400,height:760},children}};
    },
    async size(){return {width:400,height:760};},async launch(){page=jdShape?'desktop':'home';},
    async tap(_x,y){
      const i=Math.floor((y-15)/52),key=screens[page]![i]![0];
      actions.push(key);
      if (key==='increase') { quantity++;return; }
      if (key==='remove' && --quantity>0) return;
      page=transitions[key]!;
    },
    async search(text,_signal,submit){assert.equal(text,jdShape?s.store.brand:s.store.name);assert.equal(submit,!jdShape);page=jdShape?'typed':'result';},
    async back(){assert.equal(page,'checkout');page='cart';},
    async screenshot(){return png;},async close(){}
  };
  return {device,actions};
}
test('Android 页面回放检查起价、真实零包装费、未知配送费、优惠、证据与购物车恢复',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'takeout-android-replay-')),cfg=join(dir,'sources.json');
  await writeFile(cfg,JSON.stringify([source]));
  const sources=await AndroidSources.load(cfg);
  const image=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="760"><rect width="400" height="760" fill="white"/><rect width="400" height="190" fill="gray"/></svg>')).png().toBuffer();
  const model={status:{configured:true,model:'replay-only',family:null,problem:null},async json<T>(_scope:string,_operation:string,_prompt:string,_data:unknown,check:(x:unknown)=>T){return check({payable:'¥21.50'});},
    async locate(){return [180,136] as [number,number];}};
  const t=task('jd',source);
  const first=replay(image);
  const collector=androidCollector('jd',sources,model,new EvidenceStore(dir),()=>null,async()=>first.device);
  const result=await collector.collect(t,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(result.error_code,null,JSON.stringify(result.trace));
  assert.equal(result.status,'partial');
  assert.equal(result.observation!.amount_fen,2150);
  assert.equal(result.observation!.components.packaging_fee.amount_fen,0);
  assert.equal(result.observation!.components.delivery_fee.amount_fen,null);
  assert.equal(result.market!.prices[0]!.qualifier,'from');
  assert.equal(result.market!.prices[0]!.fen,null);
  assert.equal(result.market!.prices[1]!.kind,'display_reference');
  assert.equal(result.observation!.details!.coupons![0]!.applied!.fen,400);
  assert.equal(result.observation!.details!.coupons![0]!.basis,'折前商品小计');
  assert.equal(result.cleanup,'restored');
  assert.deepEqual(first.actions,['search','searchInput','result','item','add','checkout','remove']);
  assert.doesNotThrow(()=>checkResult(t,result));
  const db=new SqliteStore(join(dir,'review.sqlite'));
  try {
    const market=new CompetitionStore(db,sources);
    db.createRun({id:t.run_id,scenario:'competition',created_at:new Date().toISOString(),label:'复核测试',schedule_key:null},[t]);
    const claim=db.claim('jd',new Date().toISOString(),'live')!;
    const persisted=structuredClone(result);
    persisted.observation!.attempt_id=claim.attempt_id;
    db.finish(claim,persisted,null);
    const id=persisted.observation!.observation_id;
    assert.throws(()=>market.reviewQuote(id,'disputed','',1),/填写发现的差异/);
    market.reviewQuote(id,'disputed','费用不符',1);
    assert.equal(market.slots(t.run_id)[0]!.review?.decision,'disputed');
    assert.equal(db.snapshot(t.run_id).observations[0]!.amount_fen,2150);
    market.reviewQuote(id,'verified','已核对原图',2);
    assert.equal(market.slots(t.run_id)[0]!.review?.decision,'verified');
  } finally { db.close(); }

  const multiple=replay(image), multiTask=structuredClone(t);
  multiTask.live!.quantity=2;
  const multiResult=await androidCollector('jd',sources,model,new EvidenceStore(dir),()=>null,async()=>multiple.device)
    .collect(multiTask,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(multiResult.observation?.basket_items[0]?.quantity,2);
  assert.deepEqual(multiple.actions.slice(-5),['add','increase','checkout','remove','remove']);
  assert.equal(multiResult.cleanup,'restored');

  const minimum=replay(image,true);
  const blocked=androidCollector('jd',sources,model,new EvidenceStore(dir),()=>null,async()=>minimum.device);
  const noQuote=await blocked.collect(t,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(noQuote.status,'unavailable');
  assert.equal(noQuote.error_code,'minimum_not_met');
  assert.equal(noQuote.observation,null);
  assert.equal(noQuote.cleanup,'restored');
  assert.ok(!minimum.actions.includes('checkout'));

  const label=(text:string)=>({text,className:'TextView'});
  const jdSource:AndroidSource={...source,searchBy:'brand',selectors:{...source.selectors,
    channel:label('外卖'),entryCategory:label('外卖'),searchValue:sel('{query}','searchInput'),searchSubmit:sel('搜索','searchSubmit'),
    category:label('饮品，未选中'),item:{...label('{item}'),withDescription:true},itemDetail:label('{item}'),
    cartLine:label('{item} {spec}'),cartPanel:sel('','panel'),cartCount:label('门店购物车，{quantity}件商品 按钮'),
    checkout:label('去结算，按钮'),remove:label('减少购买数量，按钮'),
    checkoutLine:sel('{item} {spec}','checkoutLine'),checkoutQuantity:sel('数量{quantity}件','checkoutQuantity')}};
  await writeFile(cfg,JSON.stringify([jdSource]));
  const jdSources=await AndroidSources.load(cfg);
  assert.equal(jdSources.permitted('jd'),true,JSON.stringify(jdSources.status('jd')));
  const menu=replay(image,false,true), jdTask=task('jd',jdSource);
  const quote=await androidCollector('jd',jdSources,model,new EvidenceStore(dir),()=>null,async()=>menu.device)
    .collect(jdTask,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(quote.error_code,null,JSON.stringify(quote.trace));
  assert.equal(quote.observation?.amount_fen,2150);
  assert.equal(quote.cleanup,'restored');
  assert.deepEqual(menu.actions,['channel','entryCategory','search','searchInput','searchSubmit','result','category','item','add','checkout','remove']);
  assert.doesNotThrow(()=>checkResult(jdTask,quote));
  const brokenEvidence=replay(image,false,true);
  brokenEvidence.device.screenshot=async()=>{
    if (brokenEvidence.actions.includes('add')) throw new Error('screenshot failed');
    return image;
  };
  const recoveredCart=await androidCollector('jd',jdSources,model,new EvidenceStore(dir),()=>null,async()=>brokenEvidence.device)
    .collect(jdTask,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(recoveredCart.status,'failed');
  assert.equal(recoveredCart.cleanup,'restored');
  assert.ok(brokenEvidence.actions.includes('remove'));
  assert.ok(!brokenEvidence.actions.includes('checkout'));
  const otherItem=replay(image,false,true,2);
  const refused=await androidCollector('jd',jdSources,model,new EvidenceStore(dir),()=>null,async()=>otherItem.device)
    .collect(jdTask,randomUUID(),AbortSignal.timeout(20_000));
  assert.equal(refused.error_code,'cart_not_owned');
  assert.equal(refused.cleanup,'quarantined');
  assert.ok(!otherItem.actions.includes('checkout'));

  const singleDb=new SqliteStore(join(dir,'single-run.sqlite'));
  try {
    const market=new CompetitionStore(singleDb,jdSources);
    const {targetIds}=market.importOrders([{key:'one-order',supply,reference:'模拟目标来源',paidAt:null,actualPaidFen:null}]);
    market.saveProfile(jdTask.live!.profile);
    market.savePlan({id:'single',name:'单平台试采',targetIds,profileId:'test',quantity:1,startDate:'2026-11-06',days:1,times:{lunch:'11:30'},enabled:false});
    assert.throws(()=>market.runNow('single','lunch','meituan'),/live_source_not_ready/);
    const planned=market.slots(market.runNow('single','lunch','jd'));
    assert.deepEqual(planned.map(({task})=>[task.platform,task.max_attempts]),[['jd',1]]);
  } finally { singleDb.close(); }

  const live = (platform:Platform,fen:number,ms=0):Slot=>{
    const targetTask=task(platform);
    const value=structuredClone(result) as AttemptResult;
    const o=value.observation!;
    o.amount_fen=fen;o.platform=platform;o.observed_at=new Date(Date.parse(o.observed_at)+ms).toISOString();
    return {task:targetTask,result:value,state:'completed',attempts:1,next_attempt_at:null};
  };
  const jd=live('jd',2150), mt=live('meituan',1900), tb=live('taobao_instant',2000);
  assert.equal(comparePair(jd,mt).deltaFen,250);
  const otherBranch=live('meituan',1900);
  otherBranch.result!.resolvedLive=structuredClone(otherBranch.task.live!);
  otherBranch.result!.resolvedLive!.mapping!.candidate.supply=structuredClone(supply);
  otherBranch.result!.resolvedLive!.mapping!.candidate.supply.store.name='测试品牌（另一分店）';
  otherBranch.result!.resolvedLive!.mapping!.candidate.supply.store.address='测试路2号';
  otherBranch.result!.resolvedLive!.mapping!.candidate.supply.store.key='branch-2';
  jd.task.live!.profile.eligibility.jd!.storeKey=supply.store.key;
  otherBranch.result!.resolvedLive!.profile.eligibility.meituan!.storeKey='branch-2';
  assert.equal(comparePair(jd,otherBranch).deltaFen,250);
  assert.equal(comparisonRows([jd,otherBranch])[0]!.cells.meituan.actualStore?.name,'测试品牌（另一分店）');
  otherBranch.result!.resolvedLive!.mapping!.candidate.supply.item.spec='700ml';
  assert.equal(comparePair(jd,otherBranch).deltaFen,null);
  const oldCompetitor=live('meituan',1900);
  oldCompetitor.result!.observation!.collector_version='meituan-0.1.0';
  assert.equal(comparePair(jd,oldCompetitor).deltaFen,null);
  assert.equal(comparisonRows([jd,mt,tb])[0]!.lowestFen,1900);
  assert.equal(comparisonRows([jd,mt])[0]!.lowestFen,null);
  const disputed={...tb,review:{observationId:tb.result!.observation!.observation_id,decision:'disputed' as const,note:'证据金额不符',minutes:1,reviewedAt:new Date().toISOString()}};
  assert.equal(comparePair(jd,disputed).deltaFen,null);
  assert.equal(comparisonRows([jd,mt,disputed])[0]!.lowestFen,null);
  assert.equal(comparisonRows([jd,mt,disputed])[0]!.cells.taobao_instant.rawObservation!.amount_fen,2000);
  assert.equal(comparePair(jd,live('meituan',1900,301_000)).deltaFen,null);
  assert.equal(comparisonRows([jd,mt],Date.parse(jd.result!.observation!.observed_at)+901_000)[0]!.cells.jd.historical,true);
  const expired=live('meituan',1900);expired.task.live!.profile.validUntil=new Date(Date.now()-60_000).toISOString();
  assert.equal(comparePair(jd,expired).deltaFen,null);
  const wrong=live('meituan',1900);wrong.task.live!.profile.eligibility.meituan!.storeCustomer='new';
  assert.equal(comparePair(jd,wrong).deltaFen,null);
  wrong.task.live!.profile.eligibility.meituan!.storeCustomer='existing';wrong.result!.observation!.value_origin='synthetic';
  assert.equal(comparePair(jd,wrong).deltaFen,null);
});

test('一个平台配置错误不会阻断其他平台，闪购书面许可缺失时保持受限',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'takeout-source-test-')),path=join(dir,'source.json');
  await writeFile(path,JSON.stringify([source,{platform:'meituan',selectors:{}},{...source,platform:'taobao_instant'}]));
  const sources=await AndroidSources.load(path);
  assert.equal(sources.permitted('jd'),true);
  assert.equal(sources.status('meituan').status,'invalid_configuration');
  assert.equal(sources.permitted('taobao_instant'),false);
  assert.equal(sources.status('taobao_instant').status,'restricted');
});

test('订单幂等入库，不生成当前报价；三天计划保留全部 162 个槽位',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'takeout-plan-test-')),db=new SqliteStore(join(dir,'test.sqlite'));
  const sources=await AndroidSources.load(join(dir,'absent.json'));
  const market=new CompetitionStore(db,sources);
  try {
    const orders=Array.from({length:6},(_,i)=>{
      const copy=structuredClone(supply);copy.store.key=String(i%3);copy.item.key=String(i);
      return {key:'order-'+i,supply:copy,paidAt:'2026-11-02T11:20:00+08:00',actualPaidFen:1600,reference:'脱敏测试记录'};
    });
    assert.equal(market.importOrders(orders).imported,6);
    assert.equal(market.importOrders(orders).duplicates,6);
    assert.equal(market.recentRuns('live').length,0);
    market.saveProfile({...task('jd').live!.profile,storeQualifications:[
      {storeKey:'0',platform:'jd',customer:'new',evidence:'仅门店0的证据'},
      {storeKey:'1',platform:'jd',customer:'existing',evidence:'仅门店1的证据'}]});
    market.savePlan({id:'trial',name:'三店',targetIds:market.list<Target>('market_targets').map(t=>t.id),profileId:'test',quantity:1,
      startDate:'2026-11-02',days:3,times:{lunch:'11:30',dinner:'17:30',night:'21:30'},enabled:true});
    const end=new Date('2026-11-05T12:00:00+08:00');
    market.materialize(end);market.materialize(end);db.expire(end.toISOString());
    const latest=market.recentRuns('live')[0]!;
    const rows=market.slots(latest.id).filter(s=>s.task.platform==='jd');
    for (const row of rows) {
      const expected=({'0':'new','1':'existing'} as Record<string,string>)[row.task.store_id] ?? 'unknown';
      assert.equal(row.task.live!.profile.eligibility.jd!.storeCustomer,expected);
    }
    const trial=market.trialReport()[0]!;
    assert.equal(trial.expected,162);
    assert.equal(trial.stats.planned,162);
    assert.equal(trial.stats.failed,162);
    assert.equal(trial.stats.quoted,0);
    assert.equal(trial.stats.threePlatforms,0);
  } finally { db.close(); }
});

test('每次尝试追加报价快照，历史报价不被新尝试覆盖',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'takeout-quote-snapshot-'));
  const store=new SqliteStore(join(dir,'snapshot.sqlite'));
  try {
    const now=new Date().toISOString();
    const slot=task('jd');
    store.createRun({id:'run',scenario:'competition',created_at:now,label:'快照测试',schedule_key:null},[slot]);
    const insertAttempt=store.db.prepare('INSERT INTO attempts(id,slot_id,number,started_at) VALUES(?,?,?,?)');
    insertAttempt.run('a1',slot.slot_id,1,now);
    insertAttempt.run('a2',slot.slot_id,2,new Date(Date.parse(now)+1000).toISOString());
    const observation=(id:string,attemptId:string,fen:number,valid:boolean,at:string)=>({
      observation_id:id,source_id:liveSources.jd,tenant_id:TENANT,slot_id:slot.slot_id,attempt_id:attemptId,platform:'jd',store_id:supply.store.key,
      basket_id:target.id,scenario_id:'scenario',price_kind:'checkout_payable',price_scope:'basket',currency:'CNY',amount_fen:fen,raw_value:(fen/100).toFixed(2),
      observed_at:at,collected_at:at,quote_valid:valid,value_origin:'observed',evidence_refs:[],details:{},
    }) as unknown as Observation;
    store.appendQuoteSnapshot(slot.slot_id,'a1',observation('o1','a1',2160,true,now));
    store.appendQuoteSnapshot(slot.slot_id,'a2',observation('o2','a2',2190,false,new Date(Date.parse(now)+2000).toISOString()));
    // 同一尝试重复写入不应重复出现。
    store.appendQuoteSnapshot(slot.slot_id,'a1',observation('o1b','a1',2160,true,now));
    const details=new CompetitionStore(store,await AndroidSources.load(join(dir,'no-sources.json'))).runDetails('run');
    const quotes=details?.slots[0]?.quotes ?? [];
    assert.equal(quotes.length,2);
    assert.deepEqual(quotes.map(q=>[q.attemptId,q.amountFen,q.quoteValid]),[['a1',2160,true],['a2',2190,false]]);
  } finally {store.close();}
});

test('没有快照的旧任务回退到单条 observation 读取',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'takeout-quote-fallback-'));
  const store=new SqliteStore(join(dir,'fallback.sqlite'));
  try {
    const now=new Date().toISOString();
    const slot=task('jd');
    store.createRun({id:'run',scenario:'competition',created_at:now,label:'回退测试',schedule_key:null},[slot]);
    const legacyObservation={observation_id:'legacy',attempt_id:'old-attempt',amount_fen:2050,quote_valid:true,observed_at:now,collected_at:now,raw_value:'20.50',evidence_refs:[]};
    store.db.prepare('UPDATE slots SET state=?, result_json=? WHERE id=?')
      .run('completed',JSON.stringify({status:'success',cleanup:'untouched',observation:legacyObservation,evidence:null,trace:[]}),slot.slot_id);
    const details=new CompetitionStore(store,await AndroidSources.load(join(dir,'no-sources.json'))).runDetails('run');
    const quotes=details?.slots[0]?.quotes ?? [];
    assert.deepEqual(quotes.map(q=>[q.attemptId,q.amountFen,q.quoteValid]),[['old-attempt',2050,true]]);
  } finally {store.close();}
});
