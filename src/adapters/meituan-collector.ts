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
import {looksLikeCaptcha,CaptchaEncountered} from './captcha.js';
import {observedStore,observedStoreName,observedAddressNode,observedItem,observedSingleBasket,payableEvidenceNodes} from './observed-identity.js';
import {digest,normalize} from '../domain/competition.js';
import {navigateMeituan, readMeituanSettlement} from './meituan-collect.js';

export interface MeituanCollectorOptions {
  sources: AndroidSources;
  /** 测试注入：读取当前页面全部可见文字的兜底实现（默认用 uiautomator dump）。 */
  cartBarTexts?: () => Promise<string[]>;
  model: Pick<ModelGateway, 'status' | 'locate' | 'json' | 'text'>;
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

      // 美团底栏（购物车状态）不在 u2 可访问性树里，uiautomator dump 又会因为页面动画报“could not get idle state”。
      // 改为截取屏幕底部 10% 的购物车栏，让本地模型逐行读文字（离线实测 1 秒左右、准确）：
      // 空车显示“¥20起送/预估加配送费”，有商品显示“到手约/共减/去结算”。
      let deviceRef: Awaited<ReturnType<typeof connectAndroid>> | null = null;
      let physicalRef: {width: number; height: number} | null = null;
      let visualLocateRef: ((hint: string) => Promise<{x: number; y: number} | null>) | null = null;
      let tapPointRef: ((x: number, y: number) => Promise<void>) | null = null;
      const adbShell = async (args: string[]) => {
        const {execFile} = await import('node:child_process');
        const {promisify} = await import('node:util');
        const run = promisify(execFile);
        const adb = process.env.MIDSCENE_ADB_PATH ?? 'adb';
        return run(adb, ['-s', source.device, ...args], {timeout: 20_000, windowsHide: true, encoding: 'utf8'}).catch(() => ({stdout: ''}));
      };
      const cartBarState = async () => {
        if (opts.cartBarTexts) {
          const texts = await opts.cartBarTexts();
          const hasMin = texts.some(t => /起送/.test(t));
          const hasContent = texts.some(t => /到手约|共减|去结算/.test(t));
          return {empty: hasMin && !hasContent, lines: texts, hasMin, hasContent};
        }
        const png = await deviceRef!.screenshot(signal);
        const meta = await sharp(png).metadata();
        const width = meta.width ?? 0, height = meta.height ?? 0;
        if (!width || !height) throw new Error('screen_geometry_unknown');
        const top = Math.round(height * 0.90);
        const band = await sharp(png).extract({left: 0, top, width, height: height - top}).resize({width: 900}).png().toBuffer();
        try { const {writeFile} = await import('node:fs/promises'); await writeFile('.runtime/mt-cart-bar-dbg.png', band); await writeFile('.runtime/mt-cart-full-dbg.png', png); } catch { /* 诊断 */ }
        console.log('[meituan] 购物车栏截图尺寸', width, height, '裁剪 top', top);
        const content = await opts.model.text('meituan', 'meituan_cart_bar',
          '把这张截图里的可见文字按行原样输出，最多 6 行；不要编号、不要总结、不要判断。',
          {image: band, signal, maxTokens: 200});
        const lines = content.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
        const hasMin = lines.some(line => /起送/.test(line));
        const hasContent = lines.some(line => /到手约|共减|去结算/.test(line));
        return {empty: hasMin && !hasContent, lines, hasMin, hasContent};
      };
      // 风控优先：任何阶段读到验证码/滑块字样，立刻停止且不做任何点击，交给人工处理。
      const assertNoCaptcha = async () => {
        const labels = (await semantic?.read().catch(() => [] as U2Node[]) ?? []).map(n => nodeLabel(n).trim());
        if (looksLikeCaptcha(labels)) throw new CaptchaEncountered();
      };

      try {
        emit?.({phase: 'connect', state: 'started'});
        const device = await (opts.connect ?? connectAndroid)(source, signal);
        deviceRef = device;
        note('connect', '已连接设备');
        emit?.({phase: 'connect', state: 'succeeded'});

        const logicalSize = async () => device.size();
        await device.launch();
        const geometry = await sharp(await device.screenshot(signal)).metadata();
        if (!geometry.width || !geometry.height) throw new Error('screen_geometry_unknown');
        const physical = {width: geometry.width, height: geometry.height};
        physicalRef = physical;
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
        visualLocateRef = visualLocate;
        tapPointRef = tapPoint;
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
        // 手机长时间空闲可能锁屏，进入美团导航前先唤醒并解锁，避免 target_app_not_foreground。
        await adbShell(['shell', 'input', 'keyevent', '224']);
        await adbShell(['shell', 'wm', 'dismiss-keyguard']);
        const steps = await (opts.navigate ?? navigateMeituan)({
          serial: source.device,
          semantic,
          sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
          brand,
          itemName,
          onStoreReached: async () => {
            await assertNoCaptcha();
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
                // 点菜页加载慢或标签点击被忽略时重试：最多点 3 次“点菜”，每次再等页面出现菜单特征。
                let onMenu=false;
                for(let attempt=0;attempt<3 && !onMenu;attempt++){
                  const menuTab=await semantic!.find(n=>nodeLabel(n).trim()==='点菜',3_000).catch(()=>null);
                  if(!menuTab) throw new Error('store_menu_tab_missing');
                  await semantic!.tap(menuTab,'点菜标签');
                  for(let i=0;i<5 && !onMenu;i++){
                    await semantic!.waitStable(3);
                    const labels=(await semantic!.read()).map(n=>nodeLabel(n).trim());
                    // 不同门店模板的商品行文字不一样（有的只有“月售/神抢手/超值多人餐”，没有“选套餐”），
                    // 用“点菜+商家两个标签存在 + 出现商品/营销文字 + 不是商家页”组合判定。
                    const hasTabs=labels.includes('点菜') && labels.includes('商家');
                    const hasMenuText=labels.some(l=>/月售|神抢手|超值多人餐|大堡口福|选套餐|一件即送|起送\d|到手约|¥/.test(l));
                    const isMerchantPage=labels.some(l=>/网友探店|堂食菜品|门面|亮证经营/.test(l));
                    onMenu=hasTabs && hasMenuText && !isMerchantPage;
                    if(!onMenu) await new Promise(r=>setTimeout(r,700));
                  }
                  if(!onMenu) console.log(`[meituan] 第${attempt+1}次点“点菜”后仍未看到菜单，重试`);
                }
                if(!onMenu) throw new Error('store_menu_not_reached');
              }
              actualStore={name:named.name,address,nodes:[named.node]};
            }
            // 点菜页如果停在上次的滚动位置，底部购物车栏会被隐藏（真机截图确认）；先滑回顶部再读取门店证据和购物车状态。
            await adbShell(['shell', 'input', 'swipe', String(Math.round(physical.width / 2)), String(Math.round(physical.height * 0.30)), String(Math.round(physical.width / 2)), String(Math.round(physical.height * 0.85)), '420']);
            await new Promise(r => setTimeout(r, 900));
            storeProof=await captureNodes(actualStore.nodes,'store');
            if (opts.cartBarTexts) {
              // 单测/注入模式：直接使用注入的底部购物车栏文字判断空车，不依赖真机菜单结构。
              const injected = await cartBarState();
              cartEmptyPrecheck = injected.empty;
            } else {
              // 当前美团版本的门店页不渲染底部购物车栏（真机四张整屏截图确认）。改为：
              // 打开右上角“…”菜单 → 购物车。若目标店购物车有商品，购物车页会按门店分组列出该店；
              // 若整页没有目标门店名，则目标店购物车为空。判断依据保存为文字记录，不保存含用户其他商品的截图。
              // “…”菜单偶尔点不动或弹出有延迟：最多重试 3 次（含视觉定位兜底），仍打不开再报错。
              let cartEntry=null;
              for(let attempt=0;attempt<3 && !cartEntry;attempt++){
                const moreBtn=await semantic!.find(n=>(nodeLabel(n).trim()==='更多'||nodeLabel(n).trim()==='更多选项') && n.top < 200,1_500).catch(()=>null);
                if(moreBtn){ await semantic!.tap(moreBtn,'更多菜单'); }
                else {
                  const hit=await visualLocate('顶部右侧的“…”按钮').catch(()=>null);
                  if(hit) await tapPoint(hit.x,hit.y);
                }
                await new Promise(r=>setTimeout(r,1_600+attempt*600));
                cartEntry=await semantic!.find(n=>nodeLabel(n).trim()==='购物车',2_500).catch(()=>null);
                if(!cartEntry){ await semantic!.back().catch(()=>null); await new Promise(r=>setTimeout(r,800)); }
              }
              if(!cartEntry) throw new Error('cart_entry_missing');
              await semantic!.tap(cartEntry,'购物车入口');
              await semantic!.waitStable(4);
              const cartNodes=await semantic!.read();
              const cartLabels=cartNodes.map(n=>nodeLabel(n).trim()).filter(Boolean);
              // 购物车页是全局购物车，会列出所有门店；必须只认“当前门店”这一组，
              // 否则用户购物车里其他麦当劳分店的商品会被误判成目标店非空。
              const menuLabelsForStore=(await semantic!.read().catch(()=>[] as U2Node[])).map(n=>nodeLabel(n));
              const currentStoreLabel=menuLabelsForStore.find(l=>l.includes(brand)&&/店/.test(l))??'';
              const core=currentStoreLabel.replace(/[（）()&＆\s]/g,'');
              const branchTail=core.slice(-5);
              const targetListed=branchTail.length>=3
                ? cartLabels.some(l=>l.replace(/[（）()&＆\s]/g,'').includes(branchTail))
                : cartLabels.some(l=>l.includes(brand)&&/店/.test(l));
              console.log('[meituan] 购物车目标店判定', JSON.stringify({currentStoreLabel,branchTail,targetListed}));
              const cartTitleOk=cartLabels.some(l=>l==='购物车');
              console.log('[meituan] 购物车页检查', JSON.stringify({targetListed, cartTitleOk, sample: cartLabels.filter(l=>/麦当劳|购物车|全选|去结算/.test(l)).slice(0,10)}));
              note('cart_precheck', targetListed ? '购物车页出现目标门店，判定非空' : '购物车页未出现目标门店，判定目标店空车');
              await semantic!.back();
              await semantic!.waitStable(3);
              if(!cartTitleOk) throw new Error('cart_page_unverified');
              cartEmptyPrecheck=!targetListed;
            }
            if(!cartEmptyPrecheck) throw new Error('cart_preflight_unverified');
          },
          onCartMutation: async () => {
            await assertNoCaptcha();
            // 空车前置条件在门店页已经确认；商品列表页读不到购物车栏，不能在这里重新猜。
            if (cartEmptyPrecheck !== true) throw new Error('cart_preflight_unverified');
            cartMayHaveChanged = true;
            cleanup = 'quarantined';
          },
          searchText: async (text: string) => {
            // 美团搜索页会保留上一次关键词（真机遇到过“一碗牛·清炖牛肉”残留在输入框），
            // 先用退格清空，再用 yadb 注入品牌词并回车提交；失败再退回 Midscene 的输入实现。
            try {
              for (let i = 0; i < 25; i++) await adbShell(['shell', 'input', 'keyevent', '67']);
              const escaped = text.replace(/'/g, "'\\''");
              await adbShell(['shell', `app_process -Djava.class.path=/data/local/tmp/yadb /data/local/tmp com.ysbing.yadb.Main -keyboard '${escaped}'`]);
              await new Promise(r => setTimeout(r, 700));
              await adbShell(['shell', 'input', 'keyevent', '66']);
            } catch {
              await (device as any).search?.(text, signal, true);
            }
          },
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
        await assertNoCaptcha();
        try {
          const {writeFile} = await import('node:fs/promises');
          await writeFile('.runtime/mt-checkout-page.png', await device.screenshot(signal));
          const probe = await semantic.read().catch(() => [] as U2Node[]);
          console.log('[meituan] 结算页节点样例', JSON.stringify(probe.slice(0, 18).map(n => nodeLabel(n).trim()).filter(Boolean)));
        } catch { /* 诊断 */ }
        let totalFen: number | null = null;
        let feeSubtotal: number | null = null, feePackaging: number | null = null, feeDelivery: number | null = null, feeDiscount: number | null = null;
        let reconciled = false;
        let quote: ReturnType<typeof readMeituanSettlement> | null = null;
        let checkoutNodes:U2Node[]=[];
        for (let i = 0; i < 12 && !quote?.raw?.['券前']; i++) {
          await new Promise(r => setTimeout(r, 800));
          const nodes = await semantic.read().catch(() => []);
          if (!nodes.length) continue;
          const parsed = readMeituanSettlement(nodes);
          if (parsed.raw?.['券前']) { quote = parsed; checkoutNodes=nodes; }
        }
        if (quote && checkoutNodes.length >= 5 && quote.payable_fen != null) {
          // 读屏可用的结算页：沿用节点核对与“实付金额二次读取”。
          if (!observedSingleBasket(checkoutNodes,itemName,live.target.supply.item.spec ?? '')) throw new Error('meituan_checkout_item_unverified');
          if (!actualItem) {
            actualItem=observedItem(checkoutNodes,itemName,live.target.supply.item.spec ?? '');
            if(!actualItem) throw new Error('meituan_item_unverified');
            itemProof=await captureNodes(actualItem.nodes,'item');
          }
          const payableNodes=payableEvidenceNodes(checkoutNodes,quote.raw);
          if (!payableNodes) throw new Error('meituan_payable_unverified');
          evidence=await captureNodes(payableNodes,'checkout');
          const checkoutShot=await opts.evidence.read(evidence.id,'png');
          const verify=await opts.model.json<{value:string}>('meituan','meituan_checkout_verify',
            '读取实付或合计标签旁明确显示的金额，只输出金额；未看到则输出空字符串。',{},v=>v as {value:string},
            {image:checkoutShot,signal,schema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}});
          const matched=/^\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(verify.value ?? '');
          if (!matched || Math.round(Number(matched[1])*100)!==quote.payable_fen) throw new Error('meituan_payable_mismatch');
          totalFen=quote.payable_fen;
          const rawOf=(key:string)=>{const v=quote!.raw?.[key]; const m=typeof v==='string'?/(\d+(?:\.\d{1,2})?)/.exec(v):null; return m?Math.round(Number(m[1])*100):null;};
          feeSubtotal=rawOf('商品原价')??rawOf('商品金额');
          feePackaging=rawOf('打包费');
          feeDelivery=rawOf('配送费')??rawOf('用户配送费');
          feeDiscount=rawOf('红包')??rawOf('优惠');
        } else {
          // 结算页是 WebView 自绘，读屏为空（真机确认）：用整页截图读文字，金额读两次必须一致，再做费用加减核对。
          const readLines = async (tag: string) => {
            // 本地小模型偶发把结算页读成状态栏数字（真机：可见行只有时间和网速）；
            // 读到这种结果就重拍重读，最多 3 次，避免把“没读出来”误判成金额缺失。
            const meaningful = (lines: string[]) => lines.filter(line => /[\u4e00-\u9fa5]/.test(line)).length >= 5;
            let best: {lines: string[]; png: any} = {lines: [], png: Buffer.alloc(0)};
            for (let attempt = 1; attempt <= 3; attempt++) {
              const png = await device.screenshot(signal);
              let content = '';
              try {
                content = await opts.model.text('meituan', 'meituan_checkout_lines',
                  '把这张截图里所有可见文字按行原样输出，最多 30 行；金额、商品名、门店名、费用名按原样保留；不要总结、不要判断。',
                  {image: png, signal, maxImageWidth: 900, maxTokens: 800});
              } catch (error) {
                console.log('[meituan] 结算页读取异常，重试', (error as Error).message);
              }
              const lines = content.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
              best = {lines, png};
              if (meaningful(lines)) break;
              console.log('[meituan] 结算页读取无效，重试', attempt);
              await new Promise(r => setTimeout(r, 700));
            }
            return best;
          };
          const firstRead = await readLines('checkout-read-1');
          const secondRead = await readLines('checkout-read-2');
          const redact = (line: string) => line.replace(/\d{11}/g, '***').replace(/(公寓|小区|单元|宿舍|号楼|栋|室)\S*/g, '***');
          const isPersonal = (line: string) => /\d{11}/.test(line) || /(公寓|小区|单元|宿舍|号楼|栋|室)/.test(line);
          const safeLines = (lines: string[]) => lines.filter(v => !isPersonal(v)).map(redact);
          console.log('[meituan] 结算页可见行1', JSON.stringify(safeLines(firstRead.lines).slice(0, 18)));
          const amountFrom = (lines: string[]) => {
            for (const key of ['立即支付', '实付', '应付', '合计', '券前']) {
              for (const line of lines) {
                if (!line.includes(key)) continue;
                const m = /[¥￥]?\s*(\d+(?:\.\d{1,2})?)/.exec(line.replace(/[¥￥]/g, ' '));
                if (m) return Math.round(Number(m[1]) * 100);
              }
            }
            return null;
          };
          const payable = amountFrom(firstRead.lines), payable2 = amountFrom(secondRead.lines);
          if (payable == null || payable2 == null || payable !== payable2) throw new Error('meituan_payable_unverified');
          const feeNear = (label: string) => {
            for (const lines of [firstRead.lines, secondRead.lines]) {
              const idx = lines.findIndex(line => line.includes(label));
              if (idx < 0) continue;
              for (const line of lines.slice(idx, idx + 3)) {
                const m = /[¥￥]\s*(\d+(?:\.\d{1,2})?)/.exec(line);
                if (m) return Math.round(Number(m[1]) * 100);
              }
              const after = lines[idx + 1];
              const bare = after ? /^[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(after) : null;
              if (bare) return Math.round(Number(bare[1]) * 100);
            }
            return null;
          };
          feeSubtotal = feeNear('商品原价');
          feePackaging = feeNear('打包费');
          feeDelivery = feeNear('用户配送费') ?? feeNear('配送费');
          // 优惠金额必须取“共减/红包”关键字后面的数字；直接找行内第一个金额会把“券前 ¥33.59”当成优惠。
          const discountFrom = (lines: string[]) => {
            for (const line of lines) {
              const m = /共减\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/.exec(line) ?? /红包[^\d¥￥]{0,6}[¥￥]?\s*(\d+(?:\.\d{1,2})?)/.exec(line);
              if (m) return Math.round(Number(m[1]) * 100);
            }
            return null;
          };
          feeDiscount = discountFrom(firstRead.lines) ?? discountFrom(secondRead.lines);
          reconciled = [feeSubtotal, feePackaging, feeDelivery, feeDiscount].every(v => v != null) &&
            (feeSubtotal! + feePackaging! + feeDelivery! - feeDiscount!) === payable;
          console.log('[meituan] 结算页费用核对', JSON.stringify({feeSubtotal, feePackaging, feeDelivery, feeDiscount, payable, reconciled}));
          if (!reconciled) throw new Error('meituan_reconciliation_failed');
          totalFen = payable;
          const storeLine = firstRead.lines.find(line => line.includes(brand) && /店/.test(line)) ?? null;
          const itemLine = firstRead.lines.find(line => line.trim() === itemName) ?? null;
          const quantityLine = firstRead.lines.find(line => /^(×|x)\s*1$|^x1$/i.test(line.trim())) ?? null;
          if (!storeLine) throw new Error('meituan_identity_unverified');
          if (!itemLine || !quantityLine) throw new Error('meituan_checkout_item_unverified');
          const knownStoreAddress = (actualStore as {address?: string} | null)?.address ?? '';
          if (!actualStore) actualStore = {name: storeLine, address: knownStoreAddress, nodes: []};
          if (!actualItem) actualItem = {name: itemLine, spec: live.target.supply.item.spec ?? '', nodes: []};
          console.log('[meituan] 结算后身份', JSON.stringify({store: actualStore, item: actualItem, totalFen, reconciled}));
          // 证据：整页顶部 24% 涂黑（收货地址/收件人/电话），保留门店、商品、费用和金额。
          const floor = Math.round(physical.height * 0.24);
          const maskedPng = await sharp(firstRead.png).composite([{input: await sharp({create: {width: physical.width, height: floor, channels: 3, background: '#121719'}}).png().toBuffer(), left: 0, top: 0}]).png().toBuffer();
          evidence = await opts.evidence.save(randomUUID(), 'checkout', maskedPng, safeLines(firstRead.lines).join('\n'), 'live');
          // 商品证据：结算页商品行区域（在地址块下方），单独存证。
          const itemTop = Math.round(physical.height * 0.26), itemH = Math.round(physical.height * 0.14);
          const itemBand = await sharp(firstRead.png).extract({left: 0, top: itemTop, width: physical.width, height: itemH}).png().toBuffer();
          const bandText = await opts.model.text('meituan', 'meituan_item_band', '把这张截图里的可见文字按行原样输出，最多 8 行；不要编号、不要总结。', {image: itemBand, signal, maxImageWidth: 900, maxTokens: 300}).catch(() => '');
          itemProof = await opts.evidence.save(randomUUID(), 'item', itemBand, bandText.split(/\r?\n/).filter(Boolean).slice(0, 8).join('\n'), 'live');
        }
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
          amount_fen: totalFen!, raw_value: `¥${(totalFen! / 100).toFixed(2)}`,
          components: {
            delivery_fee: {amount_fen: feeDelivery, raw_value: feeDelivery == null ? null : String(feeDelivery / 100), basis: feeDelivery == null ? 'unknown' : 'separately_displayed', included_in: feeDelivery == null ? null : 'checkout_payable'},
            packaging_fee: {amount_fen: feePackaging, raw_value: feePackaging == null ? null : String(feePackaging / 100), basis: feePackaging == null ? 'unknown' : 'separately_displayed', included_in: feePackaging == null ? null : 'checkout_payable'},
          },
          missing_reasons: {
            ...(feeDelivery == null ? {delivery_fee: 'not_verified'} : {}),
            ...(feePackaging == null ? {packaging_fee: 'not_verified'} : {}),
          },
          observed_at: new Date().toISOString(), collected_at: new Date().toISOString(),
          value_origin: 'observed', quote_valid: true,
          detail_complete: reconciled,
          basket_items: [{product_id: live.target.id, name: observed.name, variant: observed.spec, quantity: 1}],
          account_ref: task.account_ref, delivery_point_id: task.delivery_point_id, entry_point: task.entry_point,
          evidence_refs: [evidence],
          contract_version: task.contract_version, collector_version: 'meituan-0.2.0',
          details: {
            components: {
              subtotal: feeSubtotal == null ? null : {raw: `¥${(feeSubtotal / 100).toFixed(2)}`, fen: feeSubtotal, evidence: evidence as Evidence},
              packaging: feePackaging == null ? null : {raw: `¥${(feePackaging / 100).toFixed(2)}`, fen: feePackaging, evidence: evidence as Evidence},
              delivery: feeDelivery == null ? null : {raw: `¥${(feeDelivery / 100).toFixed(2)}`, fen: feeDelivery, evidence: evidence as Evidence},
              other: null,
              discount: feeDiscount == null ? null : {raw: `¥${(feeDiscount / 100).toFixed(2)}`, fen: feeDiscount, evidence: evidence as Evidence},
            },
            subtotalBasis: reconciled ? 'before_discount' : 'unknown',
            feesSeparate: reconciled ? true : null,
            eta: null,
            coupons: null,
            missing: identity.address ? {} : {store_address: '商家页未读到营业地址，本次只按唯一门店名核对实际分店'},
            reconciled,
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
        emit?.({phase: 'checkout', state: 'succeeded', data: {amountFen: totalFen, components: feeSubtotal != null ? {subtotal: feeSubtotal} : undefined}});
      } catch (e) {
        error_code = (e as Error).message.slice(0, 120);
        emit?.({phase: 'checkout', state: 'failed', errorCode: error_code});
        note('error', error_code);
      }

      if (cartMayHaveChanged && semantic) {
        try {
          // 恢复只撤销本次加购：从结算页退回商品详情页，点数量控件里的黄色减号，直到底部购物车栏回到空车状态。
          await semantic.back();
          await new Promise(r => setTimeout(r, 1_500));
          let restored = false;
          // 清理优先走“门店购物车页 + 管理模式全选删除”：任务开始时已确认目标店空车，
          // 所以该店购物车里的商品只可能是本次加购；整页删除比逐个找减号更可靠。
          const clearStoreCartViaManage = async (): Promise<boolean> => {
            try {
              const more = await semantic!.find(n => (nodeLabel(n).trim()==='更多'||nodeLabel(n).trim()==='更多选项') && n.top < 200, 1_500).catch(() => null);
              if (!more) return false;
              await semantic!.tap(more, '更多菜单');
              await new Promise(r => setTimeout(r, 1_200));
              const cartEntry = await semantic!.find(n => nodeLabel(n).trim() === '购物车', 2_500).catch(() => null);
              if (!cartEntry) return false;
              await semantic!.tap(cartEntry, '购物车入口');
              await semantic!.waitStable(4);
              const before = (await semantic!.read()).map(n => nodeLabel(n).trim());
              const listed = before.some(l => l.includes(brand) && /店/.test(l));
              console.log('[meituan] 门店购物车页核对', JSON.stringify({ listed, sample: before.filter(l => /购物车|麦当劳/.test(l)).slice(0, 6) }));
              if (!listed) { await semantic!.back(); await semantic!.waitStable(2); return true; }
              const manage = await semantic!.find(n => nodeLabel(n).trim() === '管理', 2_000).catch(() => null);
              if (!manage) return false;
              await semantic!.tap(manage, '管理');
              await semantic!.waitStable(2);
              const selectAll = await semantic!.find(n => nodeLabel(n).trim() === '全选', 2_000).catch(() => null);
              if (selectAll) { await semantic!.tap(selectAll, '全选'); await semantic!.waitStable(1); }
              const del = await semantic!.find(n => /删除/.test(nodeLabel(n)), 2_000).catch(() => null);
              if (!del) return false;
              await semantic!.tap(del, '删除');
              await semantic!.waitStable(2);
              const confirm = await semantic!.find(n => nodeLabel(n).trim() === '删除' || nodeLabel(n).trim() === '确定', 2_000).catch(() => null);
              if (confirm) { await semantic!.tap(confirm, '确认删除'); await semantic!.waitStable(2); }
              const after = (await semantic!.read()).map(n => nodeLabel(n).trim());
              const stillListed = after.some(l => l.includes(brand) && /店/.test(l));
              console.log('[meituan] 管理模式删除后核对', JSON.stringify({ stillListed }));
              await semantic!.back();
              await semantic!.waitStable(2);
              return !stillListed;
            } catch { return false; }
          };
          // 先回到门店页再清理：从结算页按一次返回不一定是门店页（真机落到过搜索结果页）。
          const ensureStorePage = async (): Promise<boolean> => {
            for (let i = 0; i < 5; i++) {
              const labels = (await semantic!.read().catch(() => [] as U2Node[])).map(n => nodeLabel(n).trim());
              const tabs = ['点餐', '商家', '评价'].every(t => labels.includes(t));
              const checkout = labels.some(l => /提交订单|立即支付/.test(l));
              if (tabs && !checkout) return true;
              await semantic!.back();
              await new Promise(r => setTimeout(r, 1_200));
            }
            return false;
          };
          const clearViaCartPanel = async (): Promise<boolean> => {
            try {
              const sw = physicalRef?.width ?? 1260, sh = physicalRef?.height ?? 2844;
              if (!(await ensureStorePage())) return false;
              // 门店页左下角购物车图标打开已选商品面板，面板右上角有“清空”。
              await adbShell(['shell', 'input', 'tap', String(Math.round(sw * 0.11)), String(Math.round(sh * 0.96))]);
              await new Promise(r => setTimeout(r, 1_600));
              const panelLabels = (await semantic!.read().catch(() => [] as U2Node[])).map(n => nodeLabel(n).trim());
              const hasClear = panelLabels.some(l => l === '清空');
              console.log('[meituan] 购物车面板清空入口', JSON.stringify({ hasClear, sample: panelLabels.filter(l => /清空|已加购|板烧/.test(l)).slice(0, 6) }));
              if (!hasClear) return false;
              const clear = await semantic!.find(n => nodeLabel(n).trim() === '清空', 1_500).catch(() => null);
              if (!clear) return false;
              await semantic!.tap(clear, '清空');
              await new Promise(r => setTimeout(r, 1_400));
              const confirm = await semantic!.find(n => /^(确定|确认|清空)$/.test(nodeLabel(n).trim()), 1_500).catch(() => null);
              if (confirm) { await semantic!.tap(confirm, '确认清空'); await new Promise(r => setTimeout(r, 1_400)); }
              await adbShell(['shell', 'input', 'tap', String(Math.round(sw * 0.5)), String(Math.round(sh * 0.2))]);
              await new Promise(r => setTimeout(r, 1_200));
              const state = await cartBarState().catch(() => null);
              console.log('[meituan] 面板清空后底栏', JSON.stringify({ empty: state?.empty }));
              return !!state?.empty;
            } catch { return false; }
          };
          restored = await clearViaCartPanel();
          // 最终兜底：全局购物车“管理”模式删除本次商品。
          // 用“u2 读位置 + adb 物理坐标点击”复刻真机验证过的步骤（2026-11-19 手动成功 3 次）。
          const clearViaGlobalCartManage = async (): Promise<boolean> => {
            try {
              const densityText = String((await adbShell(['shell', 'wm', 'density']))?.stdout ?? '');
              const density = Number(/density:\s*(\d+)/i.exec(densityText)?.[1] ?? 540);
              const ratio = density / 160;
              const W = physicalRef?.width ?? 1260, H = physicalRef?.height ?? 2844;
              const tapDp = async (left: number, top: number, width = 0, height = 0) => {
                const x = Math.round((left + width / 2) * ratio), y = Math.round((top + height / 2) * ratio);
                await adbShell(['shell', 'input', 'tap', String(x), String(y)]);
              };
              // 直接 start MainActivity 只会把旧任务栈（门店/结算页）带回前台，必须先 force-stop 再启动，
              // 才能回到美团首页并看到底部“购物车”标签；force-stop 不会清购物车（购物车在服务端）。
              await adbShell(['shell', 'am', 'force-stop', 'com.sankuai.meituan']);
              await new Promise(r => setTimeout(r, 1_000));
              await adbShell(['shell', 'am', 'start', '-n', 'com.sankuai.meituan/com.meituan.android.pt.homepage.activity.MainActivity']);
              await new Promise(r => setTimeout(r, 6_000));
              await adbShell(['shell', 'input', 'tap', String(Math.round(W * 0.68)), String(Math.round(H * 0.958))]);
              await new Promise(r => setTimeout(r, 3_000));
              const manage = await semantic!.find(n => nodeLabel(n).trim() === '管理', 3_000).catch(() => null);
              if (!manage) return false;
              await tapDp(manage.left, manage.top, manage.width, manage.height);
              await new Promise(r => setTimeout(r, 2_000));
              for (let attempt = 0; attempt < 3; attempt++) {
                const nodes = await semantic!.read();
                const itemIdx = nodes.findIndex(n => nodeLabel(n).trim() === itemName);
                if (itemIdx < 0) { await adbShell(['shell', 'input', 'keyevent', '4']); return true; }
                const item = nodes[itemIdx]!;
                const checkbox = nodes.find(n => /Button/i.test(String((n as {cls?: string}).cls ?? '')) && n.left < item.left && Math.abs(n.top - item.top) < 60);
                console.log('[meituan] 全局购物车勾选', JSON.stringify({ attempt, item: [item.left, item.top], checkbox: checkbox ? [checkbox.left, checkbox.top] : null }));
                if (!checkbox) return false;
                await tapDp(checkbox.left, checkbox.top, checkbox.width, checkbox.height);
                await new Promise(r => setTimeout(r, 1_500));
                const afterSelect = await semantic!.read();
                const del = afterSelect.find(n => /^删除\(\d+\)/.test(nodeLabel(n).trim()));
                if (!del) return false;
                await tapDp(del.left, del.top, del.width, del.height);
                await new Promise(r => setTimeout(r, 1_500));
                const confirmNodes = await semantic!.read();
                const confirm = confirmNodes.find(n => nodeLabel(n).trim() === '删除' && n.top > 400);
                if (confirm) { await tapDp(confirm.left, confirm.top, confirm.width, confirm.height); await new Promise(r => setTimeout(r, 1_800)); }
                const verify = await semantic!.read();
                const remains = verify.filter(n => nodeLabel(n).trim() === itemName).length;
                console.log('[meituan] 全局购物车删除后核对', JSON.stringify({ remains }));
                if (remains === 0) { await adbShell(['shell', 'input', 'keyevent', '4']); return true; }
              }
              return false;
            } catch { return false; }
          };
          if (!restored) restored = await clearViaGlobalCartManage();
          if (!restored) restored = await clearStoreCartViaManage();
          // 兜底：优先用“…”菜单进购物车页核对（读文字，不依赖底栏渲染）：没有目标门店分组就说明本次加购已移除。
          try {
            const more = await semantic!.find(n => (nodeLabel(n).trim()==='更多'||nodeLabel(n).trim()==='更多选项') && n.top < 200, 1_500).catch(() => null);
            if (more) await semantic!.tap(more, '更多菜单');
            await new Promise(r => setTimeout(r, 1_200));
            const cartEntry = await semantic!.find(n => nodeLabel(n).trim() === '购物车', 2_500).catch(() => null);
            if (cartEntry) {
              await semantic!.tap(cartEntry, '购物车入口');
              await semantic!.waitStable(4);
              const labels = (await semantic!.read()).map(n => nodeLabel(n).trim());
              const targetListed = labels.some(l => l.includes(brand) && /店/.test(l));
              console.log('[meituan] 恢复核对购物车页', JSON.stringify({targetListed, sample: labels.filter(l => /麦当劳|购物车/.test(l)).slice(0, 6)}));
              await semantic!.back();
              await semantic!.waitStable(2);
              if (!targetListed) restored = true;
            }
          } catch { /* 核对失败则走底栏循环兜底 */ }
          for (let attempt = 0; attempt < 4 && !restored; attempt++) {
            const state = await cartBarState().catch(() => null);
            if (state?.empty) { restored = true; break; }
            // 底栏既没有“起送”也没有“到手约/去结算”，说明当前不在门店页（可能停在结算页/搜索页），
            // 先按返回回到门店页再判断，不要盲目找减号。
            if (!state?.hasMin && !state?.hasContent) {
              await semantic.back();
              await new Promise(r => setTimeout(r, 1_400));
              continue;
            }
            const minus = visualLocateRef ? await visualLocateRef('黄色圆形“−”按钮').catch(() => null) : null;
            if (!minus) { await semantic.back(); await new Promise(r => setTimeout(r, 1_200)); continue; }
            await tapPointRef!(minus.x, minus.y);
            await new Promise(r => setTimeout(r, 1_800));
          }
          if (!restored) {
            // 兜底：底栏文字读不到时，从门店页右上角“…”进购物车页核对目标店是否还列着商品。
            // 购物车页没有目标门店分组 = 本次加购已移除；这里只读页面文字，不点任何“全选/结算”按钮。
            try {
              const more = await semantic!.find(n => (nodeLabel(n).trim()==='更多'||nodeLabel(n).trim()==='更多选项') && n.top < 200, 1_500).catch(() => null);
              if (more) await semantic!.tap(more, '更多菜单');
              await new Promise(r => setTimeout(r, 1_200));
              const cartEntry = await semantic!.find(n => nodeLabel(n).trim() === '购物车', 2_500).catch(() => null);
              if (cartEntry) {
                await semantic!.tap(cartEntry, '购物车入口');
                await semantic!.waitStable(4);
                const labels = (await semantic!.read()).map(n => nodeLabel(n).trim());
                const targetListed = labels.some(l => l.includes(brand) && /店/.test(l));
                console.log('[meituan] 清理兜底购物车页核对', JSON.stringify({targetListed, sample: labels.filter(l => /麦当劳|购物车/.test(l)).slice(0, 6)}));
                await semantic!.back();
                await semantic!.waitStable(2);
                if (!targetListed) { restored = true; }
              }
            } catch { /* 兜底失败保持隔离 */ }
          }
          if (restored) { cartMayHaveChanged = false; cleanup = 'restored'; }
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
