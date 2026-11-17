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
import {createU2Semantic} from './meituan-semantic.js';
import type {U2Semantic,U2Node} from './meituan-semantic.js';
import {cartIsExplicitlyEmpty,ownedCartRemoveControl} from './cart-safety.js';
import {observedStore,observedItem,observedSingleBasket,payableEvidenceNodes} from './observed-identity.js';
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
      let storeProof: Evidence | null = null, itemProof: Evidence | null = null;
      let actualStore: ReturnType<typeof observedStore> = null;
      let actualItem: ReturnType<typeof observedItem> = null;
      let verifiedLive: AttemptResult['resolvedLive'];

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
            actualStore=observedStore(await semantic!.read(),brand,live.target.supply.store.city);
            if (!actualStore) throw new Error('meituan_store_unverified');
            storeProof=await captureNodes(actualStore.nodes,'store');
          },
          onCartMutation: async () => {
            const nodes=await semantic!.read();
            if (!cartIsExplicitlyEmpty(nodes)) throw new Error('cart_preflight_unverified');
            actualItem=observedItem(nodes,itemName,live.target.supply.item.spec ?? '');
            if (!actualItem) throw new Error('meituan_item_unverified');
            itemProof=await captureNodes(actualItem.nodes,'item');
            cartMayHaveChanged = true;
            cleanup = 'quarantined';
          },
          searchText: async (text: string) => { await (device as any).search?.(text, signal, true); },
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
            missing: {},
            reconciled: false,
            contextEvidence: evidence,
            storeEvidence: verifiedStoreProof,
            itemEvidence: verifiedItemProof,
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
          const current=await semantic.read();
          if (cartIsExplicitlyEmpty(current)) cleanup='restored';
          else {
            const remove=ownedCartRemoveControl(current,itemName,live.target.supply.item.spec ?? '');
            if (remove) {
              await semantic.tap(remove,'恢复本次商品');
              if (cartIsExplicitlyEmpty(await semantic.read())) cleanup='restored';
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
