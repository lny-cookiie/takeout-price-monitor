// 美团采集器：接入调度器，把 navigateMeituan 全链路 + 结算字段读取包装成 Collector 契约。
// 设计取舍：优先跑通真实链路并落库；字段缺失时返回 partial 并在 missing_reasons 说明原因，
// 不用任何模拟数据填充，保证落库数据可追溯。
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {AttemptResult, Collector, Evidence, Observation, Task} from '../domain/contracts.js';
import {connectAndroid} from './android-transport.js';
import type {AndroidSources, AndroidSource} from './android-source.js';
import type {ModelGateway} from '../infra/model.js';
import type {EvidenceStore} from '../infra/evidence.js';
import {createU2Semantic, nodeLabel} from './meituan-semantic.js';
import type {U2Semantic,U2Node} from './meituan-semantic.js';
import {cartIsExplicitlyEmpty,cartLooksEmpty,ownedCartRemoveControl} from './cart-safety.js';
import {observedStore,observedStoreName,observedAddressNode,observedItem,observedSingleBasket,payableEvidenceNodes} from './observed-identity.js';
import {digest,normalize} from '../domain/competition.js';
import {navigateMeituan, readMeituanSettlement} from './meituan-collect.js';

export interface MeituanCollectorOptions {
  sources: AndroidSources;
  model: Pick<ModelGateway, 'status' | 'locate' | 'json'>;
  evidence: EvidenceStore;
  connect?: typeof connectAndroid;
  navigate?: typeof navigateMeituan;
  semantic?: typeof createU2Semantic;
}

export function liveMeituanCollector(opts: MeituanCollectorOptions): Collector {
  return {
    platform: 'meituan',
    mode: 'live',
    async close() {},
    async collect(task: Task, attemptId: string, signal: AbortSignal, _attemptNumber, emit): Promise<AttemptResult> {
      const started = Date.now(), started_at = new Date(started).toISOString();
      const trace: AttemptResult['trace'] = [];
      const note = (phase: string, text: string) => trace.push({phase, at: new Date().toISOString(), note: text});
      const source = opts.sources.get('meituan') as AndroidSource | undefined;
      if (!source || !opts.sources.permitted('meituan')) throw new Error('live_source_not_ready');
      if (!opts.model.status.configured) throw new Error('model_not_configured');

      const live = task.live!;
      const itemName = live.target.supply.item.name;
      const brand = live.target.supply.store.brand;
      let observation: Observation | null = null;
      let evidence: Evidence | null = null;
      let status: AttemptResult['status'] = 'failed';
      let error_code: string | null = null;
      let availability = 'unknown';
      let cartMayHaveChanged = false;
      let cleanup: AttemptResult['cleanup'] = 'untouched';
      let semantic: U2Semantic | undefined;
      let storeProof: Evidence | null = null, itemProof: Evidence | null = null, storeAddressProof: Evidence | null = null, storeCartProof: Evidence | null = null;
      let cartEmptyPrecheck: boolean | undefined;
      let actualStore: ReturnType<typeof observedStore> = null;
      let actualItem: ReturnType<typeof observedItem> = null;
      let verifiedLive: AttemptResult['resolvedLive'];

      // 美团底栏（购物车状态）不在 u2 可访问性树里；用系统 uiautomator 全量 dump 取文字。
      const dumpTexts = async (): Promise<string[]> => {
        const {execFile} = await import('node:child_process');
        const {promisify} = await import('node:util');
        const run = promisify(execFile);
        const adb = process.env.MIDSCENE_ADB_PATH ?? 'adb';
        const file = '/sdcard/_takeout_state.xml';
        // u2 读屏服务会占住 uiautomator，导致 dump 静默失败；dump 前先停 u2，读完语义层会自动重启 u2。
        await run(adb, ['-s', source.device, 'shell', 'pkill', '-f', 'com.wetest.uia2'], {timeout: 8_000, windowsHide: true}).catch(() => null);
        await new Promise(r => setTimeout(r, 1_000));
        await run(adb, ['-s', source.device, 'shell', 'rm', '-f', file], {timeout: 8_000, windowsHide: true}).catch(() => null);
        await run(adb, ['-s', source.device, 'shell', 'uiautomator', 'dump', '--compressed', file], {timeout: 25_000, windowsHide: true}).catch(() => null);
        const {stdout} = await run(adb, ['-s', source.device, 'shell', 'cat', file], {timeout: 20_000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, windowsHide: true}).catch(() => ({stdout: ''}));
        return [...stdout.matchAll(/(?:text|content-desc)="([^"]*)"/g)].map(m => m[1]!).filter(Boolean);
      };
      const cartBarState = async () => {
        let texts: string[] = [];
        // 页面切换动画期间 uiautomator dump 会失败或返回空，重试几次再下结论，不能把“没读到”当成空车。
        for (let attempt = 0; attempt < 3; attempt++) {
          texts = await dumpTexts();
          if (texts.length > 5) break;
          await new Promise(r => setTimeout(r, 900));
        }
        const hasMin = texts.some(t => /起送/.test(t));
        const hasContent = texts.some(t => /到手约|共减|去结算|已加购商品/.test(t));
        return {empty: hasMin && !hasContent, hasMin, hasContent, nodes: texts.length, sample: texts.filter(t => /起送|到手约|共减|去结算/.test(t)).slice(0, 6)};
      };

      try {
        emit?.({phase: 'connect', state: 'started'});
        const device = await (opts.connect ?? connectAndroid)(source, signal);
        note('connect', '已连接设备');
        emit?.({phase: 'connect', state: 'succeeded'});

        const logicalSize = async () => device.size();
        await device.launch();
        const geometry = await sharp(await device.screenshot(signal)).metadata();
        if (!geometry.width || !geometry.height) throw new Error('screen_geometry_unknown');
        const physical = {width: geometry.width, height: geometry.height};
        const captureNodes = async (nodes:U2Node[],stage:string) => {
          const image=await device.screenshot(signal), meta=await sharp(image).metadata(), size=await device.size();
          const fresh=await semantic!.read();
          if (nodes.some(n=>!fresh.some(v=>v.text===n.text && v.desc===n.desc && Math.abs(v.left-n.left)<2 && Math.abs(v.top-n.top)<2 && Math.abs(v.width-n.width)<2 && Math.abs(v.height-n.height)<2)))
            throw new Error('page_changed_during_capture');
          if (!meta.width || !meta.height || !(size.width>0 && size.height>0)) throw new Error('screen_geometry_unknown');
          const layers=[];
          for (const node of nodes) {
            const left=Math.floor(node.left*meta.width/size.width),top=Math.floor(node.top*meta.height/size.height);
            const width=Math.ceil(node.width*meta.width/size.width),height=Math.ceil(node.height*meta.height/size.height);
            if (left<0 || top<0 || width<1 || height<1 || left+width>meta.width || top+height>meta.height) throw new Error('evidence_geometry_invalid');
            layers.push({input:await sharp(image).extract({left,top,width,height}).png().toBuffer(),left,top});
          }
          const masked=await sharp({create:{width:meta.width,height:meta.height,channels:3,background:'#121719'}}).composite(layers).png().toBuffer();
          return opts.evidence.save(randomUUID(),stage,masked,'','live');
        };

        // 视觉定位与点击：美团门店卡在 MRNX 容器里读不到节点，这两项是必要兜底能力，
        // 抽成变量后同时提供给语义层和导航流程，避免各写一套。
        const visualLocate = async (hint: string) => {
          const shot = await (device as any).screenshot();
          const [px, py] = await opts.model.locate('meituan', shot, hint, signal);
          const logical = await logicalSize();
          return {x: px / physical.width * logical.width, y: py / physical.height * logical.height};
        };
        const tapPoint = (x: number, y: number) => device.tap(x, y);
        semantic = (opts.semantic ?? createU2Semantic)({
          serial: source.device,
          tapPoint,
          logicalSize,
          physicalSize: async () => physical,
          back: async () => { await device.back?.(); },
          sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
          visualLocate,
          brand, itemName,
        } as any);

        emit?.({phase: 'brand_search', state: 'started'});
        const steps = await (opts.navigate ?? navigateMeituan)({
          serial: source.device,
          semantic,
          sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
          brand,
          itemName,
          onStoreReached: async () => {
            const menuNodes=await semantic!.read();
            actualStore=observedStore(menuNodes,brand,live.target.supply.store.city);
            if(!actualStore){
              // 美团点菜页只有门店名没有地址；地址在“商家”标签页。先按唯一门店名核对，再补读地址。
              const named=observedStoreName(menuNodes,brand);
              if(!named) throw new Error('meituan_store_unverified');
              let address='';
              const merchantTab=await semantic!.find(n=>nodeLabel(n).trim()==='商家',3_000).catch(()=>null);
              if(merchantTab){
                await semantic!.tap(merchantTab,'商家标签');
                await semantic!.waitStable(4);
                const merchantNodes=await semantic!.read();
                const addressNode=observedAddressNode(merchantNodes,live.target.supply.store.city);
                if(addressNode){
                  address=nodeLabel(addressNode).trim();
                  storeAddressProof=await captureNodes([addressNode],'store_address');
                }
                const menuTab=await semantic!.find(n=>nodeLabel(n).trim()==='点菜',3_000).catch(()=>null);
                if(menuTab){
                  await semantic!.tap(menuTab,'点菜标签');
                  // 等点菜页真正加载出来：点菜页有商品行（选套餐/一件即送/神券价），商家页有“网友探店/堂食菜品”。
                  let onMenu=false;
                  for(let i=0;i<6 && !onMenu;i++){
                    await semantic!.waitStable(3);
                    const labels=(await semantic!.read()).map(n=>nodeLabel(n).trim());
                    onMenu=labels.some(l=>/选套餐|一件即送|神券价|起送\d|到手约/.test(l)) && !labels.some(l=>/网友探店|堂食菜品|门面/.test(l));
                    if(!onMenu) await new Promise(r=>setTimeout(r,800));
                  }
                  if(!onMenu) throw new Error('store_menu_not_reached');
                } else throw new Error('store_menu_tab_missing');
              }
              actualStore={name:named.name,address,nodes:[named.node]};
            }
            storeProof=await captureNodes(actualStore.nodes,'store');
            // 美团门店页底部的购物车栏不在 u2 可访问性树里（u2 读不到“起送/到手约”），
            // 但系统 uiautomator 全量 dump 能读到，因此用 dump 判断空车：有“起送”且没有“到手约/共减/去结算”。
            const barState=await cartBarState();
            console.log('[meituan] 购物车栏状态', JSON.stringify(barState));
            cartEmptyPrecheck=barState.empty;
            if(!cartEmptyPrecheck) throw new Error('cart_preflight_unverified');
          },
          onCartMutation: async () => {
            // 空车前置条件在门店页已经确认；商品列表页读不到购物车栏，不能在这里重新猜。
            if (cartEmptyPrecheck !== true) throw new Error('cart_preflight_unverified');
            cartMayHaveChanged = true;
            cleanup = 'quarantined';
          },
          searchText: async (text: string) => { await (device as any).search?.(text, signal, true); },
          // 搜索输入框会保留上一次关键词；用键盘退格清空，避免拼成“板烧鸡腿堡麦当劳”。
          clearSearchInput: async () => {
            const {execFile} = await import('node:child_process');
            const {promisify} = await import('node:util');
            const run = promisify(execFile);
            const adb = process.env.MIDSCENE_ADB_PATH ?? 'adb';
            for (let i = 0; i < 20; i++) {
              await run(adb, ['-s', source.device, 'shell', 'input', 'keyevent', '67'], {timeout: 5_000, windowsHide: true}).catch(() => null);
            }
          },
          pressEnter: async () => {
            const {execFile} = await import('node:child_process');
            const {promisify} = await import('node:util');
            const run = promisify(execFile);
            const adb = process.env.MIDSCENE_ADB_PATH ?? 'adb';
            await run(adb, ['-s', source.device, 'shell', 'input', 'keyevent', '66'], {timeout: 5_000, windowsHide: true}).catch(() => null);
          },
          // 门店卡在 MRNX 容器里读不到节点，必须把视觉兜底传进去，
          // 否则 navigateMeituan 会直接抛 meituan_store_card_needs_visual。
          visualLocate,
          tapPoint,
        } as any);
        emit?.({phase: 'brand_search', state: 'succeeded', data: {steps}});
        note('nav', steps.join(' > '));

        // 读结算页
        emit?.({phase: 'checkout', state: 'started'});
        let quote: ReturnType<typeof readMeituanSettlement> | null = null;
        let checkoutNodes:U2Node[]=[];
        for (let i = 0; i < 20 && !quote?.raw?.['券前']; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const nodes = await semantic.read().catch(() => []);
          if (!nodes.length) continue;
          const parsed = readMeituanSettlement(nodes);
          if (parsed.raw?.['券前']) { quote = parsed; checkoutNodes=nodes; }
        }
        if (!quote) throw new Error('meituan_no_checkout');
        if (!observedSingleBasket(checkoutNodes,itemName,live.target.supply.item.spec ?? '')) throw new Error('meituan_checkout_item_unverified');
        // 商品身份以结算页的同一购物篮为准：单据上唯一的商品名+规格+1 件，比在列表页猜更可靠。
        if (!actualItem) {
          actualItem=observedItem(checkoutNodes,itemName,live.target.supply.item.spec ?? '');
          if(!actualItem) throw new Error('meituan_item_unverified');
          itemProof=await captureNodes(actualItem.nodes,'item');
        }
        // 只截取已识别的“实付”标签与金额节点，避免将配送地址发送给模型。
        const payableNodes=payableEvidenceNodes(checkoutNodes,quote.raw);
        if (!payableNodes || quote.payable_fen==null) throw new Error('meituan_payable_unverified');
        evidence=await captureNodes(payableNodes,'checkout');
        const checkoutShot=await opts.evidence.read(evidence.id,'png');
        const verify=await opts.model.json<{value:string}>('meituan','meituan_checkout_verify',
          '读取实付或合计标签旁明确显示的金额，只输出金额；未看到则输出空字符串。',{},v=>v as {value:string},
          {image:checkoutShot,signal,schema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}});
        const matched=/^\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(verify.value ?? '');
        if (!matched || Math.round(Number(matched[1])*100)!==quote.payable_fen) throw new Error('meituan_payable_mismatch');
        const totalFen=quote.payable_fen;
        const verifiedStoreProof=storeProof as Evidence|null, verifiedItemProof=itemProof as Evidence|null;
        if (!actualStore || !actualItem || !verifiedStoreProof || !verifiedItemProof) throw new Error('meituan_identity_unverified');
        const identity=actualStore as NonNullable<typeof actualStore>, observed=actualItem as NonNullable<typeof actualItem>;
        const previous=live.mapping?.candidate.supply.store;
        const storeKey=previous && normalize(previous.name)===normalize(identity.name) && normalize(previous.address)===normalize(identity.address)
          ? previous.key : digest(['meituan',identity.name,identity.address]);
        const actualSupply={store:{...live.target.supply.store,key:storeKey,name:identity.name,address:identity.address},
          item:{...live.target.supply.item,name:observed.name,spec:observed.spec}};
        const target={...live.target,supply:actualSupply,revision:digest(actualSupply)};
        const exact={relation:'exact' as const,reason:'本次页面已核对',missing:[]};
        const resolvedLive={...live,target,mapping:{id:randomUUID(),targetId:target.id,targetRevision:target.revision,
          candidate:{platform:'meituan' as const,entry:task.entry_point,supply:actualSupply,reference:verifiedStoreProof.id,evidence:verifiedStoreProof},
          store:exact,item:exact,status:'verified' as const,proposedAt:verifiedStoreProof.captured_at,reviewedAt:verifiedStoreProof.captured_at}};
        observation = {
          observation_id: randomUUID(), source_id: task.source_id, tenant_id: task.tenant_id,
          slot_id: task.slot_id, attempt_id: attemptId, platform: 'meituan',
          store_id: task.store_id, basket_id: task.basket_id, scenario_id: task.scenario_id,
          price_kind: 'checkout_payable', price_scope: 'basket', currency: 'CNY',
          amount_fen: totalFen, raw_value: `¥${(totalFen / 100).toFixed(2)}`,
          components: {
            delivery_fee: {amount_fen: null, raw_value: null, basis: 'unknown', included_in: null},
            packaging_fee: {amount_fen: null, raw_value: null, basis: 'unknown', included_in: null},
          },
          missing_reasons: {
            delivery_fee: 'not_verified',
            packaging_fee: 'not_verified',
          },
          observed_at: new Date().toISOString(), collected_at: new Date().toISOString(),
          value_origin: 'observed', quote_valid: true,
          detail_complete: false,
          basket_items: [{product_id: live.target.id, name: observed.name, variant: observed.spec, quantity: 1}],
          account_ref: task.account_ref, delivery_point_id: task.delivery_point_id, entry_point: task.entry_point,
          evidence_refs: [evidence],
          contract_version: task.contract_version, collector_version: 'meituan-0.2.0',
          details: {
            components: {
              subtotal: null,
              packaging: null,
              delivery: null,
              other: null,
              discount: null,
            },
            subtotalBasis: 'unknown',
            feesSeparate: null,
            eta: null,
            coupons: null,
            missing: identity.address ? {} : {store_address: '商家页未读到营业地址，本次只按唯一门店名核对实际分店'},
            reconciled: false,
            contextEvidence: evidence,
            storeEvidence: verifiedStoreProof,
            itemEvidence: verifiedItemProof,
            ...((): {supplementaryEvidence?: Evidence[]} => {
              const list: Evidence[] = [];
              if (storeAddressProof) list.push(storeAddressProof);
              if (storeCartProof) list.push(storeCartProof);
              return list.length ? {supplementaryEvidence: list} : {};
            })(),
          },
        };
        status = observation.detail_complete ? 'success' : 'partial';
        note('identity','已读取实际门店和规格');
        verifiedLive=resolvedLive;
        availability = 'available';
        emit?.({phase: 'checkout', state: 'succeeded', data: {amountFen: totalFen, components: quote.raw}});
      } catch (e) {
        error_code = (e as Error).message.slice(0, 120);
        emit?.({phase: 'checkout', state: 'failed', errorCode: error_code});
        note('error', error_code);
      }

      if (cartMayHaveChanged && semantic) {
        try {
          await semantic.back();
          await semantic.waitStable(3);
          const state=await cartBarState();
          if (state.empty) cleanup='restored';
          else {
            const remove=ownedCartRemoveControl(await semantic.read(),itemName,live.target.supply.item.spec ?? '');
            if (remove) {
              await semantic.tap(remove,'恢复本次商品');
              await semantic.waitStable(3);
              if ((await cartBarState()).empty) cleanup='restored';
            }
          }
        } catch { note('cleanup','购物车状态未确认，需要人工核对'); }
      }

      const finished_at = new Date().toISOString();
      return {
        status, error_code, availability, observation, trace,
        evidence, started_at, finished_at,
        cleanup,
        cost: {model_yuan: null, execution_ms: Date.now() - started},
        ...(observation && verifiedLive ? {resolvedLive: verifiedLive} : {}),
      };
    },
  };
}
