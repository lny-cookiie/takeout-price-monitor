// 淘宝闪购采集：只操作有明确语义和证据的控件；节点不可用时停止。
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import type {ModelGateway} from '../infra/model.js';
import {requireAndroidForeground} from './android-transport.js';
import type {U2Node} from './meituan-semantic.js';
import {AndroidUiTreeReader} from './android-uitree.js';
import {flatten} from './android-page.js';
import {cartIsExplicitlyEmpty,ownedCartRemoveControl} from './cart-safety.js';
import {observedStore,observedItem,observedSingleBasket,payableEvidenceNodes} from './observed-identity.js';
import {readMeituanSettlement} from './meituan-collect.js';
import {normalize} from '../domain/competition.js';
import type {EvidenceStore} from '../infra/evidence.js';
import type {Evidence} from '../domain/contracts.js';
import {randomUUID} from 'node:crypto';

const run = promisify(execFile);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), '[taobao]', ...a);

export interface TaobaoStep {name: string; ok: boolean; detail?: string}
export interface TaobaoQuote {
  error?: string;
  storeEvidence?: Evidence;
  itemEvidence?: Evidence;
  checkoutEvidence?: Evidence;
  /** 结算页截图的 sha256，作为该笔报价的页面证据（page_stage=checkout） */
  checkoutSha256?: string | null;
  /** 结算页截图落盘路径，便于人工复核 */
  checkoutImagePath?: string | null;
  checkoutImage?: Buffer;
  store: string | null;
  storeAddress?: string;
  itemSpec?: string;
  item: string | null;
  originalFen: number | null;
  discountFen: number | null;
  packagingFen: number | null;
  deliveryFen: number | null;
  redPacketFen: number | null;
  totalFen: number | null;
  steps: TaobaoStep[];
  /** 结算页原始文本证据，便于人工核对 */
  rawText: string | null;
}

export interface TaobaoCollectOptions {
  adbPath: string;
  serial: string;
  brand: string;
  itemName: string;
  itemSpec: string;
  city: string;
  evidence: EvidenceStore;
  onCleanup: (state:'untouched'|'restored'|'quarantined')=>void;
  /** 目标门店名关键字，例如「鞍山西道」；为空则取搜索结果第一家 */
  storeKeyword?: string;
  model: Pick<ModelGateway, 'locate' | 'json' | 'text'>;
  /** yadb 可执行文件路径（Midscene 自带） */
  yadbPath: string;
  signal?: AbortSignal;
  /** 进度回调，用于前端进度条 */
  onStep?: (name: string) => void;
}

const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));

export async function collectTaobao(o: TaobaoCollectOptions): Promise<TaobaoQuote> {
  const {adbPath, serial, brand, itemName, model, yadbPath} = o;
  const signal = o.signal ?? AbortSignal.timeout(600_000);
  let activeSignal=signal, cartMayHaveChanged=false;
  const steps: TaobaoStep[] = [];
  let W = 0, H = 0;
  const adb = async (args: string[]) =>
    (await run(adbPath, ['-s', serial, ...args], {encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,timeout:20_000,signal:activeSignal,windowsHide:true})).stdout;

  const requireForeground = () => requireAndroidForeground(async()=>String(await adb(['shell','dumpsys','window'])), 'com.taobao.taobao', activeSignal);
  let treeReader:AndroidUiTreeReader|undefined;
  const readNodes = async ():Promise<U2Node[]> => {
    await requireForeground();
    treeReader ??= await AndroidUiTreeReader.create({serial,adbPath,devicePixelRatio:1,startTimeoutMs:5_000,requestTimeoutMs:5_000});
    const tree=await treeReader.read();
    const nodes=flatten(tree.root).filter(n=>n.attrs.package==='com.taobao.taobao').map(n=>({
      text:String(n.attrs.text??''),desc:String(n.attrs['content-desc']??''),cls:String(n.type??''),rid:String(n.attrs['resource-id']??''),
      left:n.bounds.left,top:n.bounds.top,width:n.bounds.width,height:n.bounds.height}));
    if (!nodes.length) throw new Error('taobao_semantics_unavailable');
    await requireForeground();
    return nodes;
  };

  const snap = async (tag: string): Promise<Buffer> => {
    await requireForeground();
    const png = (await adb(['exec-out', 'screencap', '-p'])) as Buffer;
    const m = await sharp(png).metadata();
    if (!m.width || !m.height) throw new Error('screen_geometry_unknown');
    W = m.width; H = m.height;
    return png;
  };

    const readCropLines = async (tag: string, topRatio: number, bottomRatio: number) => {
      const full = await snap(tag);
      const meta = await sharp(full).metadata();
      const width = meta.width ?? W, height = meta.height ?? H;
      const top = Math.round(height * topRatio);
      const cropH = Math.max(60, Math.round(height * (bottomRatio - topRatio)));
      const crop = await sharp(full).extract({left: 0, top, width, height: cropH}).resize({width: 900}).png().toBuffer();
      const content = await o.model.text('taobao_instant', 'taobao_crop_lines',
        '把这张截图里从上到下的可见文字按行原样输出，每行一条，最多 15 行；不要编号、不要总结、不要判断。',
        {image: crop, signal: activeSignal, maxTokens: 500});
      return content.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 15);
    };
  const captureNodes=async(nodes:U2Node[],stage:string):Promise<Evidence>=>{
    const png=await snap(stage), fresh=await readNodes();
    if (nodes.some(n=>!fresh.some(v=>v.text===n.text && v.desc===n.desc && v.left===n.left && v.top===n.top && v.width===n.width && v.height===n.height)))
      throw new Error('page_changed_during_capture');
    const layers=[];
    for(const n of nodes){
      const left=Math.floor(n.left),top=Math.floor(n.top),width=Math.ceil(n.width),height=Math.ceil(n.height);
      if(left<0 || top<0 || width<1 || height<1 || left+width>W || top+height>H) throw new Error('evidence_geometry_invalid');
      layers.push({input:await sharp(png).extract({left,top,width,height}).png().toBuffer(),left,top});
    }
    const masked=await sharp({create:{width:W,height:H,channels:3,background:'#121719'}}).composite(layers).png().toBuffer();
    return o.evidence.save(randomUUID(),stage,masked,'','live');
  };
  let storeEvidence:Evidence|undefined,itemEvidence:Evidence|undefined,actualStore:ReturnType<typeof observedStore>=null,actualItem:ReturnType<typeof observedItem>=null;

  const mark = (name: string, ok: boolean, detail?: string) => {
    steps.push({name, ok, detail});
    o.onStep?.(name);
    log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  /** 恢复历史视觉定位和裁剪约束；前台检查与证据保存独立保留。 */
  const tapByVision = async (
    hint: string, tag: string,
    r: {xMin?: number; xMax?: number; yMin?: number; yMax?: number; cropTopRatio?: number; cropBottomRatio?: number} = {},
    retries = 3,
  ): Promise<boolean> => {
    const xMin = r.xMin ?? 10, xMax = r.xMax ?? W - 10;
    const yMin = r.yMin ?? 60, yMax = r.yMax ?? H - 70;
    for (let i = 1; i <= retries; i++) {
      try {
        const png = await snap(`${tag}-r${i}`);
        // 可选：按屏幕高度的相对比例裁掉上下干扰区（顶部搜索框、广告位等），
        // 让模型在更小的视野里定位，从源头消除同名文字干扰。坐标按裁剪偏移还原为全屏坐标。
        // 这里只用比例，不引入任何绝对像素常量，换机型自动适配。
        let img = png;
        let offsetY = 0;
        if (r.cropTopRatio != null || r.cropBottomRatio != null) {
          const top = Math.round(H * (r.cropTopRatio ?? 0));
          const bottom = Math.round(H * (r.cropBottomRatio ?? 1));
          const cropH = Math.max(80, bottom - top);
          img = await sharp(png).extract({left: 0, top, width: W, height: cropH}).toBuffer();
          offsetY = top;
        }
        const [x0, y0] = await model.locate('taobao_instant', img, hint, signal);
        const x = Math.round(x0), y = Math.round(y0) + offsetY;
        if (x < xMin || x > xMax || y < yMin || y > yMax) {
          log(`  [${tag}] 第${i}次越界 (${x},${y}) 允许 x[${xMin}-${xMax}] y[${yMin}-${yMax}]`);
          await sleep(700); continue;
        }
        await adb(['shell', 'input', 'tap', String(x), String(y)]);
        log(`  [${tag}] 点击 (${x},${y})`);
        await sleep(4000);
        return true;
      } catch (e) {
        log(`  [${tag}] 第${i}次异常 ${(e as Error).message}`);
        await sleep(1200);
      }
    }
    return false;
  };

  const typeChinese = async (text: string): Promise<boolean> => {
    try {
      await requireForeground();
      // 先清空输入框：淘宝搜索框会保留上一次关键词，yadb 是追加注入而不是替换，
      // 不清理就会出现「想搜麦当劳、实际搜成清炖牛肉饭」。一次 adb 调用连发退格。
      const clears = Array.from({length: 30}, () => 'input keyevent KEYCODE_DEL').join(' && ');
      await adb(['shell', `input keyevent KEYCODE_MOVE_END && ${clears}`]).catch(() => null);
      await sleep(300);
      await run(adbPath, ['-s', serial, 'push', yadbPath, '/data/local/tmp/'], {timeout: 20_000, encoding: 'utf8'}).catch(() => null);
      const out = await run(adbPath, ['-s', serial, 'shell',
        `app_process -Djava.class.path=/data/local/tmp/yadb /data/local/tmp com.ysbing.yadb.Main -keyboard '${text.replace(/'/g, "'\\''")}'`],
        {timeout: 25_000, encoding: 'utf8'});
      return out.stdout.includes('Copy text:true');
    } catch { return false; }
  };

  const escape = async () => {
    for (let i = 0; i < 3; i++) {
      try { await requireForeground(); await adb(['shell','input','keyevent','KEYCODE_BACK']); }
      catch { break; }
    }
  };

  try {
    // 0 唤醒屏幕并回到可操作的桌面状态。
    // 设备息屏时 screencap 会得到约 20KB 的全黑图，视觉定位必然错——这是实测踩过的坑。
    await adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']).catch(() => null);
    await sleep(900);
    await adb(['shell', 'cmd', 'statusbar', 'collapse']).catch(() => null);
    await adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']).catch(() => null);
    await sleep(1400);
    mark('唤醒屏幕', true);

    // 视觉模型预热：对当前屏幕做一次真实视觉定位，把视觉编码器（mmproj）真正加载进显存。
    // 只发文本请求不会加载视觉编码器；实测模型服务空闲约 40 分钟后，首次 locate 会撞满
    // 60 秒超时，而同一张截图在本地单测只要 7 秒——冷的就是视觉通道，不是模型本体。

    // 冷启动淘宝，保证从干净首页开始。
    // 等待时间不能太短：淘宝冷启动期间会占满 CPU，此时立刻调视觉模型会拖到 60 秒超时
    // （2026-11-12 实测：等 11 秒时连续 3 次 model_location_failed，每次卡满 62 秒）。
    await adb(['shell', 'am', 'start', '-S', '-n', 'com.taobao.taobao/com.taobao.tao.welcome.Welcome']);
    // 冷启动不要死等固定秒数：实测首页常在 8-10 秒就可用，死等 20 秒纯属浪费；
    // 但双 11 弹层期会更慢，所以改成「先等 8 秒，再用首页 tab 特征轮询确认就绪」。
    await sleep(8_000);
    await snap('boot-check');
    await readNodes();
    mark('冷启动淘宝', true);

    // 1 首页 →「闪购外卖」tab
    // 冷启动后的首页偶尔会自己跳回“推荐”页或弹活动层：点完闪购必须确认页面真的变了，再继续。
    let s1 = false;
    for (let i = 0; i < 3 && !s1; i++) {
      const tapped = await tapByVision('页面顶部 tab 栏里“闪购外卖”四个字（“推荐”右侧相邻那项，黄色“闪购”+红底“外卖”）', i === 0 ? 'flash-tab' : `flash-tab-${i + 1}`, {yMin: Math.round(H*0.04), yMax: Math.round(H*0.11), cropTopRatio: 0.02, cropBottomRatio: 0.13}, 1);
      if (!tapped) continue;
      await sleep(1_800);
      const lines = await readCropLines(`flash-check-${i + 1}`, 0, 0.30).catch(() => [] as string[]);
      s1 = lines.some(l => /闪购/.test(l) && /外卖|超值|送到家/.test(l));
      if (!s1) log(`  [flash-tab] 第${i + 1}次点击后仍未进入闪购频道，重试`);
    }
    mark('进入闪购频道', s1);
    if (!s1) return {store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};

    // 2 闪购频道页 → 搜索框
    const s2 = await tapByVision('闪购频道页最上方的搜索输入框（左侧“闪购▾”，中间是推荐词，右侧橙色“搜索”按钮）', 'searchbox', {yMin: Math.round(H*0.08), yMax: Math.round(H*0.16), cropTopRatio: 0.06, cropBottomRatio: 0.18});
    mark('打开搜索框', s2);

    // 3 输入品牌并搜索
    // 淘宝的搜索建议页和搜索结果页在视觉上差别明显：结果页有“综合/销量/速度”排序栏，
    // 建议页有“历史搜索/搜索发现/专属好店”。不靠模型判断，只让它原样读文字行，由代码判定。
    const typedBrand = s2 && await typeChinese(brand);
    log(`  [type] 品牌注入=${typedBrand}`);
    await sleep(800);
    const readLines = async (tag: string) => {
      const png = await snap(tag);
      // 走纯文本通道：本机 2B 模型在 JSON 约束下曾一直生成到 1800 token 上限后截断，输出变成非法 JSON。
      // 这里只要它把可见文字按行返回，代码自己做判断；失败重试一次，仍失败返回空行。
      for (let attempt = 0; ; attempt++) {
        try {
          const content = await o.model.text('taobao_instant', 'taobao_visible_lines',
            '把这张截图里从上到下的可见文字按行原样输出，行与行之间换行，最多 20 行；不要编号、不要总结、不要判断。',
            {image: png, signal: activeSignal, maxImageWidth: 800, maxTokens: 600});
          const lines = content.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 25);
          return {lines, png};
        } catch (error) {
          log(`  [lines] 读取失败（第 ${attempt + 1} 次）：` + (error as Error).message);
          if (attempt >= 1) return {lines: [] as string[], png};
          await sleep(700);
        }
      }
    };
    const looksLikeResults = (lines: string[]) => {
      const text = lines.join('\n');
      return /综合/.test(text) && /销量/.test(text) && /速度/.test(text) && !/历史搜索|搜索发现|专属好店/.test(text);
    };
    let s3 = false;
    if (s2 && typedBrand) {
      await adb(['shell', 'input', 'keyevent', '66']);
      await sleep(2_200);
      try { s3 = looksLikeResults((await readLines('results-check-1')).lines); } catch (error) { log('  [results] 第一次读取失败：' + (error as Error).message); }
    }
    if (s2 && !s3) {
      log('  [results] 回车未进入结果页，改点橙色搜索按钮');
      const tapped = await tapByVision('页面顶部橙色底、白色“搜索”两个字的按钮', 'brand-search', {yMin: Math.round(H*0.04), yMax: Math.round(H*0.13), cropTopRatio: 0.03, cropBottomRatio: 0.15});
      if (tapped) {
        await sleep(2_200);
        try { s3 = looksLikeResults((await readLines('results-check-2')).lines); } catch (error) { log('  [results] 第二次读取失败：' + (error as Error).message); }
      }
    }
    mark('搜索品牌', !!s3, `${brand} 注入=${typedBrand}${s3 ? '' : '，未进入结果页'}`);
    if (!s3) return {store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};

    // 4 结果页 → 目标门店（y 区间避开顶部“超抢手”广告位）
    // 提示词用「门店卡片独有特征」锚定，不要用“以麦当劳开头”这种描述：
    // 页面顶部搜索框里也写着“麦当劳”，实测模型会直接点搜索框（y≈0.12H）；
    // 也不要用商品图，卡片下方横向商品列表里同样有“板烧鸡腿堡”和价格（y≈0.70H）。
    // 只有门店卡片同时具备“月售 / 评分 / 起送 / 商家自配送”这些字。
    const storeHint = o.storeKeyword
      ? `搜索结果列表里的门店卡片：卡片上同时有门店评分（如“4.5分”）和“月售”字样，门店名称包含“${o.storeKeyword}”；点这张卡片里门店名称那一行（它在页面顶部搜索框下方、「综合/销量/速度」排序栏下面；不要点最顶部的搜索框，也不要点卡片下方的汉堡商品图）`
      : '搜索结果列表里第一张门店卡片：卡片上同时有门店评分（如“4.5分”）和“月售”字样；点这张卡片里门店名称那一行（它在页面顶部搜索框下方、「综合/销量/速度」排序栏下面；不要点最顶部的搜索框，也不要点卡片下方的汉堡商品图）';
    // 关键：把视野收窄到「门店卡标题区」这一段（相对高度 26%~58%）。
    // 上界 26% 排掉顶部搜索框与“超抢手”广告位；下界 58% 排掉门店卡下方的横向商品图区
    // （那里也有“板烧鸡腿堡”和价格，实测模型会被吸过去，给出 y≈0.70H 的错误坐标）。
    // 全部用屏幕高度的比例表达，不引入绝对像素，换机型自动适配。
    // 2026-11-17 真机实测：较窄的裁剪（26%~58%）连续 3 次定位超时，而较宽裁剪一次命中；
    // 直接用宽裁剪，避免每次浪费 60 秒超时。
    const s4 = s3 && await tapByVision(storeHint, 'store',
      {yMin: Math.round(H * 0.25), yMax: Math.round(H * 0.64), cropTopRatio: 0.22, cropBottomRatio: 0.66}, 2);
    if (s4) {
      // 诊断：点击门店卡后立即保存整屏截图与前台 Activity，用于判断到底进了哪一页。
      try {
        const {writeFile} = await import('node:fs/promises');
        await writeFile('.runtime/tb-store-after-click.png', await snap('store-after-click'));
        const focus = String(await adb(['shell', 'dumpsys', 'window'])).split('\n').filter(l => l.includes('mCurrentFocus')).join('\n');
        log('  [store] 点击后前台 ' + focus.trim().slice(0, 160));
      } catch { /* 诊断不影响主流程 */ }
      try { actualStore=observedStore(await readNodes(),brand,o.city); } catch { actualStore=null; }
      if (!actualStore) {
        // 淘宝门店页是 Flutter/MRNX 自绘，u2 读不到文字；视觉定位能进店，但让 2B 模型“判断门店名和地址”
        // 会读到配送地址（北京市朝阳区）并幻觉。改为滑到门店页顶部，让模型只逐行读可见文字，
        // 由代码在文字行里找“品牌+店”的门店名和含城市的地址行。
        let storeName: string | null = null;
        let storeAddress: string | null = null;
        let storePng: Buffer | null = null;
        for (let i = 0; i < 2 && (!storeName || !storeAddress); i++) {
          await adb(['shell', 'input', 'swipe', String(Math.round(W / 2)), String(Math.round(H * 0.32)), String(Math.round(W / 2)), String(Math.round(H * 0.92)), '420']);
          await sleep(1_800);
          const shot = await readLines(`store-verify-${i + 1}`);
          log(`  [store] 顶部可见行：${shot.lines.slice(0, 12).join(' / ')}`);
          const nameLine = shot.lines.find(l => l.includes(brand) && /店/.test(l) && l.length < 60) ?? null;
          const addressLine = shot.lines.find(l => /天津/.test(l) && /(路|道|街|号)/.test(l)) ?? null;
          if (!storeName && nameLine) storeName = nameLine;
          if (!storeAddress && addressLine) storeAddress = addressLine;
          if (!storePng && (nameLine || addressLine)) storePng = shot.png;
        }
        const cityKey = normalize(o.city).replace(/市$/, '');
        const nameOk = !!storeName && normalize(storeName).includes(normalize(brand));
        const addrOk = !!storeAddress && !!cityKey && normalize(storeAddress).includes(cityKey);
        log(`  [store] 识别门店=${storeName ?? '未读到'} 地址=${storeAddress ?? '未读到'}`);
        // 淘宝门店页顶部不显示门店名称和地址（真机截图确认只有搜索框与点餐/评价/品牌三个标签）。
        // 门店身份改到结算页核对；这里先保留进店页截图作为证据，不伪造门店名。
        const png = storePng ?? await snap('store-verify-last');
        const floor = Math.round(H * 0.18);
        const masked = await sharp(png).composite([{input: await sharp({create: {width: W, height: floor, channels: 3, background: '#121719'}}).png().toBuffer(), left: 0, top: 0}]).png().toBuffer();
        if (nameOk && addrOk) {
          actualStore = {name: storeName!, address: storeAddress!, nodes: []};
          storeEvidence = await o.evidence.save(randomUUID(), 'store', masked, `门店名称：${storeName}\n营业地址：${storeAddress}`, 'live');
        } else {
          storeEvidence = await o.evidence.save(randomUUID(), 'store_entry', masked, '门店页未显示门店名和地址，门店身份待结算页核对', 'live');
          log('  [store] 门店页未显示店名/地址，改为结算页核对');
        }
      } else {
        storeEvidence = await captureNodes(actualStore.nodes, 'store');
      }
    }
    // 购物车底栏同样不在读屏树里；用底栏截图文字判断空车（空车显示“¥20起送/另需配送费”，有商品显示“去结算/到手约”）。
    let cartEmptyPrecheck = false;
    if (s4) {
      const bottomLines = await readCropLines('cartbar', 0.78, 1).catch(() => [] as string[]);
      log(`  [cart] 底栏可见行：${bottomLines.slice(0, 8).join(' / ')}`);
      cartEmptyPrecheck = bottomLines.some(l => /起送/.test(l)) && !bottomLines.some(l => /去结算|到手约|共减/.test(l));
      if (!cartEmptyPrecheck) throw new Error('cart_preflight_unverified');
    }
    mark('进入目标门店', !!s4);

    // 5 门店页下滑，让顶部展开完整的“搜一搜”搜索框（刚进店只有小放大镜，无法定位）
    if (s4) {
      await adb(['shell', 'input', 'swipe', String(Math.round(W / 2)), String(Math.round(H * 0.62)), String(Math.round(W / 2)), String(Math.round(H * 0.28)), '420']);
      await sleep(2600);
    }
    const s5 = s4 && await tapByVision('页面顶部灰色圆角搜索输入框（占位文字“搜一搜”，右侧有放大镜图标）', 'shopsearch', {yMin: Math.round(H*0.02), yMax: Math.round(H*0.16), cropTopRatio: 0.01, cropBottomRatio: 0.18});
    mark('打开店内搜索', !!s5);

    // 6 店内搜单品
    const typedItem = s5 && await typeChinese(itemName);
    await sleep(1800);
    const s6 = s5 && await tapByVision('页面顶部或右上角橙色底、白色“搜索”两个字的按钮', 'item-search', {yMin: Math.round(H*0.02), yMax: Math.round(H*0.19), cropTopRatio: 0.01, cropBottomRatio: 0.21});
    mark('店内搜单品', !!s6, `${itemName} 注入=${typedItem}`);

    // 7 点目标单品加号。用标定的相对比例坐标。
    // 注意：搜索后页面本来就停在顶部，这里**不要**再 swipe 回滚——实测多余滑动会让商品行偏移，
    // 导致标定坐标点空（2026-11-12 复现：加了 swipe 后停在结果页，去掉后正常进入单品详情页）。
    let s7 = false;
    if (s6) {
      if (!cartEmptyPrecheck) throw new Error('cart_preflight_unverified');
      const nodes=await readNodes();
      actualItem=observedItem(nodes,itemName,o.itemSpec);
      if (!actualItem) throw new Error('taobao_item_unverified');
      itemEvidence=await captureNodes(actualItem.nodes,'item');
      cartMayHaveChanged=true;
      o.onCleanup('quarantined');
      await sleep(3000);
      // 不再用「标定相对坐标」点商品：店内搜索结果前三行分别是
      //   ①双层板烧鸡腿堡三件套(¥61起，右侧“选套餐”) ②板烧鸡腿堡套餐(¥42起，右侧“选套餐”) ③板烧鸡腿堡(¥26.5，右侧“− 1 +”)
      // 固定比例会随页面布局漂移而点到套餐上（实测采到 ¥56.9 的三件套）。
      // 改为语义定位：只认「标题正好是板烧鸡腿堡、且右侧是加减号数量控件」的那一行。
      // 提示词必须用「视觉形状」区分，而不是靠模型理解“不要套餐”：
      // 套餐行的最右侧是红色矩形“选套餐”按钮，单点商品行的最右侧才是橙色圆形“+”。
      // 2B 模型只靠否定式描述会照样点“选套餐”（实测点到了第一行三件套的选套餐）。
      const addHint = `搜索结果列表里，最右侧是“橙色圆形 + 号按钮”的那一行（不是红色矩形“选套餐”按钮的那些行）；这一行的商品标题是“${itemName}”。点这个橙色圆形的 + 号`;
      // 横向也收紧到右侧 72% 之后：加号固定在商品行最右端，
      // 不收横向时模型会点到左侧商品图（实测点到 x≈0.43W 的图片上，进而跳详情页多加购）。
      // 纵向下界压到 60%：软键盘从约 65% 处弹出，商品行在其上方。
      s7 = await tapByVision(addHint, 'add-item',
        {xMin: Math.round(W * 0.72), xMax: W - 10,
         yMin: Math.round(H * 0.08), yMax: Math.round(H * 0.60),
         cropTopRatio: 0.07, cropBottomRatio: 0.62}, 3);
      if (s7) log(`  [add-item] 已通过语义定位点击「${itemName}」的加号`);
      else log('  [add-item] 未定位到目标单品的加号');
      await sleep(4000);
    }
    mark('定位单品', s7);

    // 8 详情页会不会已经加购，取决于第 7 步是否精确点中「+」图标本身：
    //    点中 → 直接加购（详情页显示 − N + 数量控件，无「加入购物车」按钮）
    //    点偏 → 只进详情页（仍有「加入购物车」按钮，购物车仍 ¥0）
    //    所以这里无条件尝试点一次「加入购物车」；已经加购时按钮不存在，定位失败即可，不重试。
    let s8=false;
    if (s7) {
      const afterItem=await readNodes();
      if (cartIsExplicitlyEmpty(afterItem)) {
        s8=await tapByVision('页面右下角深红色矩形“加入购物车”按钮', 'addcart',
          {yMin: Math.round(H * 0.40), yMax: Math.round(H * 0.68), cropTopRatio: 0.36, cropBottomRatio: 0.72}, 1);
      } else if (observedSingleBasket(afterItem,itemName,o.itemSpec) || ownedCartRemoveControl(afterItem,itemName,o.itemSpec)) s8=true;
      else throw new Error('taobao_cart_state_unverified');
    }
    mark('加购结算', s8);
    await sleep(2200);

    // 9 去结算
    const s9 = s8 && await tapByVision('页面底部购物车栏最右侧那个红色“去结算”按钮', 'checkout', {yMin: Math.round(H * 0.85), yMax: H - 10, cropTopRatio: 0.80, cropBottomRatio: 1});
    mark('去结算', !!s9);
    await sleep(5000);

    if (!s9) return {store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};

    // 结算页必须重新核对商品与数量，并从明确标注的应付节点取证。
    const checkoutNodes=await readNodes();
    if (!observedSingleBasket(checkoutNodes,itemName,o.itemSpec)) throw new Error('taobao_checkout_item_unverified');
    const parsed=readMeituanSettlement(checkoutNodes);
    const payableNodes=payableEvidenceNodes(checkoutNodes,parsed.raw);
    if (!payableNodes || parsed.payable_fen==null) throw new Error('taobao_payable_unverified');
    const checkoutEvidence=await captureNodes(payableNodes,'checkout');
    const checkoutImage=await o.evidence.read(checkoutEvidence.id,'png');
    const verification=await model.json<{value:string}>('taobao_instant','taobao_checkout_verify',
      '读取实付或合计标签旁的金额，只输出金额；没有看到则输出空字符串。',{},v=>v as {value:string},
      {image:checkoutImage,signal,schema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}});
    const match=/^\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(verification.value ?? '');
    if (!match || Math.round(Number(match[1])*100)!==parsed.payable_fen) throw new Error('taobao_payable_mismatch');
    if (!actualStore || !actualItem || !storeEvidence || !itemEvidence) throw new Error('taobao_identity_unverified');
    mark('采数完成',true);
    return {checkoutSha256:checkoutEvidence.sha256,checkoutEvidence,storeEvidence,itemEvidence,
      store:actualStore.name,storeAddress:actualStore.address,item:actualItem.name,itemSpec:actualItem.spec,
      originalFen:null,discountFen:null,packagingFen:null,deliveryFen:null,redPacketFen:null,
      totalFen:parsed.payable_fen,steps,rawText:JSON.stringify({payable:parsed.raw})};
  } catch (e) {
    log('采集异常:', (e as Error).message);
    return {error:(e as Error).message,store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};
  } finally {
    if (cartMayHaveChanged) {
      activeSignal=AbortSignal.timeout(45_000);
      try {
        let nodes=await readNodes();
        let remove=ownedCartRemoveControl(nodes,itemName,o.itemSpec);
        if (!cartIsExplicitlyEmpty(nodes) && !remove) {
          await requireForeground();
          await adb(['shell','input','keyevent','KEYCODE_BACK']);
          await sleep(800);
          nodes=await readNodes();
          remove=ownedCartRemoveControl(nodes,itemName,o.itemSpec);
        }
        if (remove) {
          await requireForeground();
          await adb(['shell','input','tap',String(Math.round(remove.left+remove.width/2)),String(Math.round(remove.top+remove.height/2))]);
          await sleep(800);
          nodes=await readNodes();
        }
        if (cartIsExplicitlyEmpty(nodes)) { cartMayHaveChanged=false; o.onCleanup('restored'); }
      } catch { /* 未确认恢复时保留隔离状态 */ }
    }
    if (!cartMayHaveChanged) await escape();
  }
}
