// 淘宝闪购采集：只操作有明确语义和证据的控件；节点不可用时停止。
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import type {ModelGateway} from '../infra/model.js';
import {requireAndroidForeground} from './android-transport.js';
import {nodeLabel} from './meituan-semantic.js';
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
  /** 费用行是否全部读到并加减核对通过 */
  reconciled?: boolean;
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

  const requireForegroundOnce = () => requireAndroidForeground(async()=>String(await adb(['shell','dumpsys','window'])), 'com.taobao.taobao', activeSignal);
  // 快速韧性：淘宝被系统切到桌面/锁屏时，立即解锁并重新拉起，再确认前台，不让整次采集直接失败。
  const requireForeground = async () => {
    try { return await requireForegroundOnce(); } catch (error) {
      if ((error as {code?:string}).code !== 'target_app_not_foreground') throw error;
      log('  [recover] 淘宝不在前台，解锁并重新拉起');
      // 可能是系统权限/更新弹层盖住了应用：先按返回键尝试关掉弹层，再解锁并重新拉起。
      await adb(['shell', 'input', 'keyevent', '4']).catch(() => null);
      await sleep(500);
      await adb(['shell', 'wm', 'dismiss-keyguard']).catch(() => null);
      await adb(['shell', 'input', 'keyevent', '224']).catch(() => null);
      await adb(['shell', 'am', 'start', '-n', 'com.taobao.taobao/com.taobao.tao.welcome.Welcome']).catch(() => null);
      await new Promise(r => setTimeout(r, 2_500));
      return requireForegroundOnce();
    }
  };
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

    const readCropLines = async (tag: string, topRatio: number, bottomRatio: number, opts: {maxLines?: number; maxTokens?: number} = {}) => {
      let full: Buffer | null = null;
      for (let attempt = 0; attempt < 3 && !full; attempt++) {
        try { full = await snap(tag); } catch (error) {
          if (attempt >= 2) throw error;
          await new Promise(r => setTimeout(r, 900));
        }
      }
      if (!full) throw new Error('screen_capture_failed');
      const meta = await sharp(full).metadata();
      const width = meta.width ?? W, height = meta.height ?? H;
      const top = Math.round(height * topRatio);
      const cropH = Math.max(60, Math.round(height * (bottomRatio - topRatio)));
      const crop = await sharp(full).extract({left: 0, top, width, height: cropH}).resize({width: 900}).png().toBuffer();
      const maxLines = opts.maxLines ?? 15;
      const content = await o.model.text('taobao_instant', 'taobao_crop_lines',
        `把这张截图里从上到下的可见文字按行原样输出，每行一条，最多 ${maxLines} 行；不要编号、不要总结、不要判断。`,
        {image: crop, signal: activeSignal, maxTokens: opts.maxTokens ?? 500});
      return content.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, maxLines);
    };
  /** 只截搜索栏右侧区域定位橙色“搜索”按钮：全屏找按钮时模型会点到左侧的其它文字（真机实测 x≈110）。 */
  const tapOrangeSearch = async (): Promise<boolean> => {
    try {
      const full = await snap('orange-search-crop');
      const meta = await sharp(full).metadata();
      const w = meta.width ?? W, h = meta.height ?? H;
      const left = Math.round(w * 0.60), top = Math.round(h * 0.072);
      const cw = Math.max(120, Math.round(w * 0.39)), ch = Math.max(60, Math.round(h * 0.052));
      const crop = await sharp(full).extract({left, top, width: cw, height: Math.min(ch, h - top)}).png().toBuffer();
      const [cx] = await model.locate('taobao_instant', crop, '橙色底白色“搜索”按钮', signal);
      // 真机实测：搜索栏这一行的垂直中心在屏幕高度 11.3% 处；模型常把按钮定位到搜索栏上边缘（点了没反应）。
      // 因此横向用模型/裁剪结果，纵向用标定的搜索栏中心。
      const x = Math.min(w - 12, Math.max(Math.round(w * 0.80), left + Math.round(cx)));
      const y = Math.round(h * 0.1132);
      await adb(['shell', 'input', 'tap', String(x), String(y)]);
      log(`  [orange-search] 点击 (${x},${y})`);
      return true;
    } catch (error) {
      log(`  [orange-search] 定位失败：${(error as Error).message}`);
      return false;
    }
  };

  /** 清空当前输入框（键盘退格），避免搜索框保留上一次关键词（真机曾遇到残留“kfc肯德基”）。 */
  const clearInput = async (times = 24) => {
    for (let i = 0; i < times; i++) {
      await adb(['shell', 'input', 'keyevent', '67']).catch(() => null);
    }
  };
  /** 把品牌名可靠地输入到搜索框：重新聚焦 → 清空 → 输入 → 截图核对输入框内容 → 最多重试一次。 */
  const typeBrandIntoSearch = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const shot = await snap('search-focus');
        const [fx, fy] = await model.locate('taobao_instant', shot, '页面顶部的搜索输入框', signal);
        if (fy < H * 0.25) await adb(['shell', 'input', 'tap', String(Math.round(fx)), String(Math.round(fy))]);
      } catch { /* 聚焦失败也继续尝试清空和输入 */ }
      await sleep(900);
      await clearInput();
      const typed = await typeChinese(brand);
      await sleep(900);
      const topLines = await readCropLines('search-input-check', 0.05, 0.13).catch(() => [] as string[]);
      log(`  [type] 第${attempt + 1}次输入 ${brand} 注入=${typed} 顶部行=${topLines.slice(0, 4).join(' / ')}`);
      if (typed && topLines.some(line => line.includes(brand))) return true;
    }
    return false;
  };

  /** 两帧截图的 48×48 灰度平均绝对差；用于判断“页面是否真的变了”，不依赖模型。 */
  const screenMAD = async (a: Buffer, b: Buffer) => {
    const ra = await sharp(a).resize(48, 48).greyscale().raw().toBuffer();
    const rb = await sharp(b).resize(48, 48).greyscale().raw().toBuffer();
    const n = Math.min(ra.length, rb.length);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(ra[i]! - rb[i]!);
    return n ? sum / n : 0;
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
    // 从别的应用（例如刚跑完美团）切到淘宝前先回桌面，避免淘宝启动后被上一个应用的任务栈或系统弹层挡住；
    // 真机出现过连续 4 次“淘宝不在前台”的恢复循环，随后在空页面上打字。
    await adb(['shell', 'input', 'keyevent', '3']).catch(() => null);
    await sleep(800);
    await adb(['shell', 'am', 'start', '-S', '-n', 'com.taobao.taobao/com.taobao.tao.welcome.Welcome']);
    // 冷启动不要死等固定秒数：实测首页常在 8-10 秒就可用；双 11 弹层期更慢，改为 12 秒后再确认就绪。
    await sleep(12_000);
    await snap('boot-check');
    await readNodes();
    mark('冷启动淘宝', true);
    // 淘宝首页会弹“超级88红包/惊喜消费券”这类全屏弹层，盖住标签栏导致点“闪购”完全没反应。
    // 用中心区域红色占比识别弹层，点它右下角的关闭按钮（约 49.8% 宽、78.1% 高）关闭；识别不到就按返回键。
    const dismissHomePopup = async (tag: string): Promise<void> => {
      const shot = await snap(tag);
      const meta = await sharp(shot).metadata();
      const w = meta.width ?? W, h = meta.height ?? H;
      const left = Math.round(w * 0.2), top = Math.round(h * 0.25);
      const cw = Math.round(w * 0.6), ch = Math.round(h * 0.45);
      try {
        const {data, info} = await sharp(shot).extract({left, top, width: cw, height: ch}).raw().toBuffer({resolveWithObject: true});
        let red = 0, total = info.width * info.height;
        for (let i = 0; i < total; i++) {
          const r = data[i * info.channels]!, g = data[i * info.channels + 1]!, b = data[i * info.channels + 2]!;
          if (r > 170 && g < 90 && b < 90) red++;
        }
        if (red / total > 0.35) {
          log(`  [popup] 首页弹层红色占比=${(red / total * 100).toFixed(0)}%，点关闭`);
          await adb(['shell', 'input', 'tap', String(Math.round(W * 0.498)), String(Math.round(H * 0.781))]);
          await sleep(1_200);
          await adb(['shell', 'input', 'keyevent', '4']);
          await sleep(1_000);
        }
      } catch { /* 识别失败时不影响主流程 */ }
    };
    await dismissHomePopup('popup-check');

    // 1 首页 →「闪购外卖」tab
    // 冷启动后的首页偶尔会自己跳回“推荐”页或弹活动层：点完闪购必须确认页面真的变了，再继续。
    // 页面是否切换用截图差异判断（模型读字偶发回显提示词，不适合作页面状态判据）。
    let s1 = false;
    // 冷启动后淘宝可能直接停在闪购频道（会记住上次标签）；先判断，避免“点了没变化”被当成失败。
    try {
      const pre = await readCropLines('flash-precheck', 0.03, 0.30, {maxLines: 14, maxTokens: 360});
      s1 = pre.some(line => /闪购/.test(line)) && pre.some(line => /超值外卖送到家|我的闪购|美食外卖/.test(line));
      log(`  [flash-tab] 预检是否已在闪购频道=${s1} 行=${pre.slice(0, 5).join(' / ')}`);
    } catch { /* 预检失败则按原流程点标签 */ }
    for (let i = 0; i < 3 && !s1; i++) {
      // “闪购”标签位置稳定，直接用屏幕比例点击（模型定位在首页偶发 60 秒超时，会吃掉整次预算）。
      const before = await snap(`flash-before-${i + 1}`);
      await adb(['shell', 'input', 'tap', String(Math.round(W * 0.37)), String(Math.round(H * 0.068))]);
      await sleep(2_200);
      const after = await snap(`flash-after-${i + 1}`);
      const mad = await screenMAD(before, after);
      s1 = mad >= 6;
      log(`  [flash-tab] 第${i + 1}次比例点击后画面差异=${mad.toFixed(1)} 判定=${s1 ? '已切换' : '未切换'}`);
      if (!s1) {
        try { const {writeFile} = await import('node:fs/promises'); await writeFile(`.runtime/tb-flash-fail-${i + 1}.png`, after); } catch { /* 诊断 */ }
        if (i >= 1) {
          log('  [recover] 闪购标签点击无效，重新拉起淘宝后再试');
          await adb(['shell', 'wm', 'dismiss-keyguard']).catch(() => null);
          await adb(['shell', 'am', 'start', '-n', 'com.taobao.taobao/com.taobao.tao.welcome.Welcome']).catch(() => null);
          await new Promise(r => setTimeout(r, 3_000));
        }
      }
    }
    mark('进入闪购频道', s1);
    if (!s1) return {store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};

    // 2 闪购频道页 → 搜索框
    const s2 = await tapByVision('页面顶部的搜索输入框', 'searchbox', {yMin: Math.round(H*0.08), yMax: Math.round(H*0.16), cropTopRatio: 0.06, cropBottomRatio: 0.18});
    mark('打开搜索框', s2);

    // 3 输入品牌并搜索
    // 淘宝的搜索建议页和搜索结果页在视觉上差别明显：结果页有“综合/销量/速度”排序栏，
    // 建议页有“历史搜索/搜索发现/专属好店”。不靠模型判断，只让它原样读文字行，由代码判定。
    const typedBrand = s2 && await typeBrandIntoSearch();
    log(`  [type] 品牌注入=${typedBrand}`);
    await sleep(500);
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
      const sortBar = /综合/.test(text) && /销量/.test(text) && /速度/.test(text);
      const storeCards = lines.some(line => /月售/.test(line) && /起送/.test(line)) ||
        lines.some(line => line.includes(brand) && /店/.test(line) && /(月售|起送)/.test(line));
      return (sortBar || storeCards) && !/历史搜索|搜索发现|专属好店/.test(text);
    };
    let s3 = false;
    const checkResults = async (tag: string) => {
      try {
        const lines = await readCropLines(tag, 0.04, 0.42, {maxLines: 22, maxTokens: 560});
        const ok = looksLikeResults(lines);
        if (!ok) log(`  [results] ${tag} 未见结果页特征，行：${lines.slice(0, 10).join(' / ')}`);
        return ok;
      } catch (error) {
        log(`  [results] ${tag} 读取失败：${(error as Error).message}`);
        return false;
      }
    };
    if (s2 && typedBrand) {
      // 真机实测（2026-11-18 白天）：输入品牌后页面停在“搜索建议 + 键盘”状态，
      // 真正能进入结果页的是键盘右下角的搜索键；页面右上角橙色按钮和回车都只保持建议下拉。
      const submitVariants: Array<[string, () => Promise<void>]> = [
        ['键盘搜索键', async () => { await adb(['shell', 'input', 'tap', String(Math.round(W * 0.878)), String(Math.round(H * 0.935))]); }],
        ['右上角橙色搜索按钮', async () => { await adb(['shell', 'input', 'tap', String(Math.round(W * 0.86)), String(Math.round(H * 0.095))]); }],
        ['回车', async () => { await adb(['shell', 'input', 'keyevent', '66']); }],
      ];
      for (const [label, action] of submitVariants) {
        if (s3) break;
        const before = await snap('search-submit-before');
        await action();
        await sleep(3_200);
        const after = await snap('search-submit-after');
        const mad = await screenMAD(before, after);
        log(`  [results] 提交方式=${label} 画面差异=${mad.toFixed(1)}`);
        if (mad >= 6) s3 = true;
        else s3 = await checkResults(`results-check-${label === '键盘搜索键' ? 1 : label === '右上角橙色搜索按钮' ? 2 : 3}`);
      }
    }
    if (s3) {
      // 截图差异可能只是“搜索建议下拉”展开，不是结果页；识别到建议下拉先按返回收起，再走频道列表备用路径。
      // 搜索结果页顶部也有“闪购 超值外卖送到家”这一行，不能只凭品牌出现次数判断建议下拉；
      // 结果页一定带排序栏（综合/销量/速度）或门店信息（月售/起送），建议下拉则没有。
      const topLines = await readCropLines('suggest-guard', 0.04, 0.42, {maxLines: 22, maxTokens: 560}).catch(() => [] as string[]);
      const hasSortBar = ['综合', '销量', '速度'].every(t => topLines.some(line => line.includes(t)));
      const hasStoreInfo = topLines.some(line => /月售/.test(line)) || topLines.some(line => /起送/.test(line));
      const suggestMarkers = topLines.filter(line => line.includes(brand)).length >= 2 && topLines.some(line => /超值外卖送到家/.test(line));
      const storeCardMarkers = hasSortBar || hasStoreInfo;
      if (suggestMarkers && !storeCardMarkers) {
        log('  [results] 判定为搜索建议下拉，按返回收起后改走频道门店列表');
        await adb(['shell', 'input', 'keyevent', '4']);
        await sleep(1_500);
        s3 = false;
      }
    }
    if (s2 && !s3) {
      // 备用路径：闪购频道页本身就是门店列表，直接滚动找麦当劳门店卡。
      // 定位用整屏截图（缩图后模型返回快）；只在命中位置合理时点击，进入后再用页面标签确认是门店页。
      log('  [results] 搜索入口未进入结果页，改从闪购频道门店列表查找麦当劳');
      const fallbackStart = Date.now();
      for (let attempt = 0; attempt < 7 && !s3; attempt++) {
        if (Date.now() - fallbackStart > 70_000) { log('  [results] 频道列表查找超预算，停止'); break; }
        try {
          const shot = await snap(`channel-scan-${attempt + 1}`);
          const meta = await sharp(shot).metadata();
          const h = meta.height ?? H;
          const [cx, cy] = await model.locate('taobao_instant', shot, `门店名称“${brand}”那一行`, signal);
          const gx = Math.round(cx), gy = Math.round(cy);
          if (gy > Math.round(h * 0.15) && gy < Math.round(h * 0.95)) {
            await adb(['shell', 'input', 'tap', String(gx), String(gy)]);
            await sleep(3_000);
            const check = await readCropLines('channel-store-check', 0.03, 0.30, {maxLines: 16, maxTokens: 420}).catch(() => [] as string[]);
            if (['点餐', '评价', '品牌'].every(t => check.some(line => line.includes(t)))) {
              log(`  [results] 从频道列表点击麦当劳进入门店页 (${gx},${gy})`);
              s3 = true;
              break;
            }
            await adb(['shell', 'input', 'keyevent', '4']);
            await sleep(1_200);
          }
        } catch (error) {
          log(`  [results] 频道列表扫描失败：${(error as Error).message}`);
        }
        await adb(['shell', 'input', 'swipe', String(Math.round(W / 2)), String(Math.round(H * 0.82)), String(Math.round(W / 2)), String(Math.round(H * 0.38)), '360']);
        await sleep(1_200);
      }
      if (!s3) log('  [results] 频道列表也没有找到麦当劳门店');
    }
    mark('搜索品牌', !!s3, `${brand} 注入=${typedBrand}${s3 ? '' : '，未进入结果页'}`);
    if (!s3) return {store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};

    // 4 结果页 → 目标门店（y 区间避开顶部“超抢手”广告位）
    // 提示词用「门店卡片独有特征」锚定，不要用“以麦当劳开头”这种描述：
    // 页面顶部搜索框里也写着“麦当劳”，实测模型会直接点搜索框（y≈0.12H）；
    // 也不要用商品图，卡片下方横向商品列表里同样有“板烧鸡腿堡”和价格（y≈0.70H）。
    // 只有门店卡片同时具备“月售 / 评分 / 起送 / 商家自配送”这些字。
    // 离线复现结论：给 2B 定位模型的提示词越长越容易卡满 60 秒超时；短文字锚点约 2 秒返回。
    const storeHint = o.storeKeyword
      ? `文字“${o.storeKeyword}”所在的门店名称那一行`
      : `列表里“${brand}”门店名称那一行`;
    // 关键：把视野收窄到「门店卡标题区」这一段（相对高度 26%~58%）。
    // 上界 26% 排掉顶部搜索框与“超抢手”广告位；下界 58% 排掉门店卡下方的横向商品图区
    // （那里也有“板烧鸡腿堡”和价格，实测模型会被吸过去，给出 y≈0.70H 的错误坐标）。
    // 全部用屏幕高度的比例表达，不引入绝对像素，换机型自动适配。
    // 2026-11-17 真机实测：较窄的裁剪（26%~58%）连续 3 次定位超时，而较宽裁剪一次命中；
    // 直接用宽裁剪，避免每次浪费 60 秒超时。
    // 搜索提交后有可能直接进了门店页（点了搜索建议时就是如此）；先在当前页面判断，避免把门店页里的榜单入口当门店卡点。
    let alreadyInStore = false;
    if (s3) {
      const probeLines = await readCropLines('store-or-results', 0.03, 0.30, {maxLines: 18, maxTokens: 460}).catch(() => [] as string[]);
      alreadyInStore = ['点餐', '评价', '品牌'].every(t => probeLines.some(line => line.includes(t)));
      log(`  [store] 当前页是否已是门店页=${alreadyInStore} 顶部行=${probeLines.slice(0, 8).join(' / ')}`);
    }
    let s4 = alreadyInStore;
    if (s3 && !alreadyInStore) {
      s4 = await tapByVision(storeHint, 'store',
        {yMin: Math.round(H * 0.25), yMax: Math.round(H * 0.64), cropTopRatio: 0.22, cropBottomRatio: 0.66}, 2);
    }
    if (s4) {
      // 淘宝门店页的“点餐”页不显示门店名和地址，但“品牌”标签页会显示门店全名和营业地址（真机确认）。
      // 门店身份必须来自这里，不能用结算页的收货地址冒充门店地址。
      await sleep(1_500);
      const openedBrand = await tapByVision('文字“品牌”', 'store-brand', {yMin: Math.round(H * 0.05), yMax: Math.round(H * 0.30), cropTopRatio: 0.04, cropBottomRatio: 0.32}, 2);
      if (!openedBrand) {
        // 视觉定位偶发把自己限制在“品牌故事”那张图上；退回顶部标签栏的比例坐标，点完仍以品牌页文字核对为准。
        log('  [store-brand] 视觉定位失败，退回标签栏比例坐标');
        await adb(['shell', 'input', 'tap', String(Math.round(W * 0.45)), String(Math.round(H * 0.12))]);
      }
      await sleep(1_700);
      const brandLines = await readCropLines('store-brand-lines', 0.12, 0.50, {maxLines: 16, maxTokens: 600}).catch(() => [] as string[]);
      log(`  [store] 品牌页可见行：${brandLines.slice(0, 14).join(' / ')}`);
      const clean = (line: string) => line.replace(/>+\s*$/g, '').replace(/\s*堂食店\s*$/g, '').trim();
      // 门店名可能因为拍照/换行被拆成两行（例如“麦当劳&麦咖啡(天津南开大学西...”+“堂食店>”），
      // 把含品牌的那一行和后面一两行拼起来，直到出现“店”字为止。
      let storeName: string | null = null;
      for (let i = 0; i < brandLines.length && !storeName; i++) {
        if (!brandLines[i]!.includes(brand)) continue;
        let candidate = brandLines[i]!;
        for (let j = i + 1; j <= i + 2 && j < brandLines.length && !/店/.test(candidate); j++) candidate += ' ' + brandLines[j]!;
        if (/店/.test(candidate) && candidate.length < 80) storeName = clean(candidate);
      }
      const addressLine = (brandLines.find(line => /天津/.test(line) && /(路|街|道|号)/.test(line)) ?? null) && clean(brandLines.find(line => /天津/.test(line) && /(路|街|道|号)/.test(line))!);
      const cityKey = normalize(o.city).replace(/市$/, '');
      const nameOk = !!storeName && normalize(storeName).includes(normalize(brand));
      const addrOk = !!addressLine && normalize(addressLine).includes(cityKey);
      log(`  [store] 品牌页识别门店=${storeName ?? '未读到'} 地址=${addressLine ?? '未读到'}`);
      if (!nameOk || !addrOk) throw new Error('taobao_store_unverified');
      actualStore = {name: storeName!, address: addressLine!, nodes: []};
      const brandPng = await snap('store-brand-evidence');
      // 品牌页只有门店/品牌信息；顶部 10% 涂黑防状态栏个人信息，其余保留。
      const floor = Math.round(H * 0.10);
      const masked = await sharp(brandPng).composite([{input: await sharp({create: {width: W, height: floor, channels: 3, background: '#121719'}}).png().toBuffer(), left: 0, top: 0}]).png().toBuffer();
      storeEvidence = await o.evidence.save(randomUUID(), 'store', masked, `门店名称：${storeName}\n营业地址：${addressLine}`, 'live');
      // 回点餐页继续店内搜索
      await tapByVision('文字“点餐”', 'store-menu', {yMin: Math.round(H * 0.06), yMax: Math.round(H * 0.22), cropTopRatio: 0.05, cropBottomRatio: 0.24}, 2).catch(() => false);
      await sleep(1_500);
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
    let s5 = s4 && await tapByVision('文字“搜一搜”的搜索框', 'shopsearch', {yMin: Math.round(H*0.02), yMax: Math.round(H*0.16), cropTopRatio: 0.01, cropBottomRatio: 0.18}, 1);
    if (s4 && !s5) {
      // 兜底：门店页顶部搜索框位置稳定（约 36% 宽、9.5% 高）；模型定位失败时用标定坐标点一次，
      // 以“画面是否变化”确认进入了店内搜索页，避免三次 60 秒定位超时把整次预算耗光。
      const before = await snap('shopsearch-fallback-before');
      await adb(['shell', 'input', 'tap', String(Math.round(W * 0.36)), String(Math.round(H * 0.095))]);
      await sleep(2_200);
      const after = await snap('shopsearch-fallback-after');
      s5 = (await screenMAD(before, after)) >= 8;
      log('  [shopsearch] 标定兜底 进入店内搜索=' + s5);
    }

    mark('打开店内搜索', !!s5);

    // 6 店内搜单品：真机实测店内搜索是“边输入边出结果”，不需要再点搜索键或回车；
    // 之前多点一次提交会把页面带进建议/空状态，导致后面的商品行扫描全部落空。
    const typedItem = s5 && await typeChinese(itemName);
    await sleep(2_800);
    const s6 = s5 && typedItem;
    if (s6) log('  [item-search] 已输入单品名，等待店内搜索结果自动刷新');
    mark('店内搜单品', !!s6, `${itemName} 注入=${typedItem}`);

    // 7 点目标单品加号。用标定的相对比例坐标。
    // 注意：搜索后页面本来就停在顶部，这里**不要**再 swipe 回滚——实测多余滑动会让商品行偏移，
    // 导致标定坐标点空（2026-11-12 复现：加了 swipe 后停在结果页，去掉后正常进入单品详情页）。
    // 7 加购目标单品：店内搜索结果里同一个“板烧鸡腿堡”会混着三件套/套餐行，
    // 目标单品行可能在屏幕下方。这里循环“找橙色+按钮 → 读该按钮所在行的标题 → 标题完全等于单品名才点”，
    // 不匹配就上滑继续找。行内文字用模型只读文字行、代码判定，不依赖模型判断“是不是套餐”。
    let s7 = false;
    if (s6) {
      if (!cartEmptyPrecheck) throw new Error('cart_preflight_unverified');
      try { const {writeFile} = await import('node:fs/promises'); await writeFile('.runtime/tb-item-list.png', await snap('item-list-dbg')); } catch { /* 诊断 */ }
      // 店内搜索结果通常第一屏就能看到目标单品行，先直接扫描；找不到再滚动（滚动会把目标行移走，反而浪费轮数）。
      const plusScanStart = Date.now();
      for (let attempt = 0; attempt < 4 && !s7; attempt++) {
        if (Date.now() - plusScanStart > 55_000) { log('  [plus] 扫描超预算，停止'); break; }
        const shot = await snap(`find-plus-${attempt + 1}`);
        let hit: [number, number] | null = null;
        try { hit = await model.locate('taobao_instant', shot, '橙色圆形“+”按钮', signal); } catch (error) { log(`  [plus] 定位失败：${(error as Error).message}`); }
        if (hit) {
          const x = Math.round(hit[0]), y = Math.round(hit[1]);
          // 商品标题在“+”按钮上方约 200-320 像素处；裁剪带要同时覆盖标题和价格。
          const bandTop = Math.max(0, y - 330), bandH = Math.min(430, H - bandTop);
          const band = await sharp(shot).extract({left: 0, top: bandTop, width: W, height: bandH}).resize({width: 900}).png().toBuffer();
          let rowText = '';
          try {
            rowText = await model.text('taobao_instant', 'taobao_row_title',
              '把这张截图里的可见文字按行原样输出，最多 8 行；不要编号、不要总结。',
              {image: band, signal, maxTokens: 240});
          } catch { /* 读不到就当作不匹配 */ }
          const rowLines = rowText.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
          log(`  [plus] 候选 (${x},${y}) 行内文字：${rowLines.slice(0, 8).join(' / ')}`);
          // 单品行的标题会单独成行且完全等于目标名；套餐行是“板烧鸡腿堡套餐/三件套”等，不会完全相等。
          // 但搜索框里也会出现一模一样的单品名文字（真机踩坑：把搜索框那一行当成商品行，点到了旁边的商品）。
          // 因此额外要求这一行带“月售”（商品行特征），且不出现“搜索”或状态栏时间。
          const hasMonthSale = rowLines.some(line => /月售/.test(line));
          const hasSearchBoxText = rowLines.some(line => line === '搜索' || /^\d{1,2}:\d{2}$/.test(line));
          if (rowLines.some(line => line === itemName) && hasMonthSale && !hasSearchBoxText) {
            await adb(['shell', 'input', 'tap', String(x), String(y)]);
            log(`  [add-item] 点击单品行加号 (${x},${y})`);
            cartMayHaveChanged = true;
            o.onCleanup('quarantined');
            s7 = true;
            break;
          }
        }
        await adb(['shell', 'input', 'swipe', String(Math.round(W / 2)), String(Math.round(H * 0.62)), String(Math.round(W / 2)), String(Math.round(H * 0.44)), '380']);
        await sleep(1_800);
      }
      if (!s7) log('  [add-item] 没有找到标题完全等于单品名的行');
      await sleep(3000);
    }
    mark('定位单品', s7);

    // 8 详情页会不会已经加购，取决于第 7 步是否精确点中「+」图标本身：
    //    点中 → 直接加购（详情页显示 − N + 数量控件，无「加入购物车」按钮）
    //    点偏 → 只进详情页（仍有「加入购物车」按钮，购物车仍 ¥0）
    //    所以这里无条件尝试点一次「加入购物车」；已经加购时按钮不存在，定位失败即可，不重试。
    let s8=false;
    if (s7) {
      // 直接点中 + 时商品已加购，底栏出现“去结算/到手约”；若点开的是详情页，底栏仍是空车，需要再点“加入购物车”。
      const bottom = await readCropLines('after-add', 0.82, 1).catch(() => [] as string[]);
      log(`  [addcart] 底栏：${bottom.slice(0, 6).join(' / ')}`);
      s8 = bottom.some(line => /去结算|到手约|共减/.test(line));
      if (!s8) {
        s8 = await tapByVision('“加入购物车”按钮', 'addcart',
          {yMin: Math.round(H * 0.40), yMax: Math.round(H * 0.72), cropTopRatio: 0.36, cropBottomRatio: 0.74}, 1);
        if (s8) await sleep(1_200);
      }
    }
    mark('加购结算', s8);
    await sleep(2200);

    // 9 去结算：点完必须确认页面真的换了（会直接点空/点到购物车栏），用截图差异判断。
    let s9 = false;
    if (s8) {
      // 去结算按钮固定在底栏最右侧（约 80% 宽、96% 高）；真机出现过模型定位连续 60 秒超时把预算耗尽。
      // 先用标定坐标点两次并看画面差异，仍不动再用模型定位兜底一次。
      for (let i = 0; i < 2 && !s9; i++) {
        const before = await snap(`checkout-before-${i + 1}`);
        await adb(['shell', 'input', 'tap', String(Math.round(W * 0.80)), String(Math.round(H * 0.963))]);
        await sleep(3_000);
        const after = await snap(`checkout-after-${i + 1}`);
        const mad = await screenMAD(before, after);
        s9 = mad >= 6;
        log(`  [checkout] 第${i + 1}次标定点击后画面差异=${mad.toFixed(1)} 判定=${s9 ? '已进入结算页' : '未跳转'}`);
      }
      if (!s9) {
        const before = await snap('checkout-before-model');
        const tapped = await tapByVision('“去结算”按钮', 'checkout', {yMin: Math.round(H * 0.90), yMax: H - 10, cropTopRatio: 0.86, cropBottomRatio: 1}, 1);
        if (tapped) {
          await sleep(3_000);
          const after = await snap('checkout-after-model');
          s9 = (await screenMAD(before, after)) >= 6;
          log(`  [checkout] 模型兜底后判定=${s9}`);
        }
      }
    }
    mark('去结算', !!s9);
    await sleep(4_000);
    if (!s9) return {store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};

    // 结算页读屏不可用（实测 0 节点）：整页截图读文字，金额读两次必须一致。
    // 隐私：整页截图只用于本地模型读取；保存证据时把顶部地址区域涂黑。
    const readCheckoutLines = async (tag: string) => {
      const png = await snap(tag);
      const content = await o.model.text('taobao_instant', 'taobao_checkout_lines',
        '把这张结算页截图里所有可见文字按行原样输出，最多 30 行；金额、商品名、门店名都要按原样保留。不要总结、不要判断。',
        {image: png, signal: activeSignal, maxImageWidth: 900, maxTokens: 750});
      return {lines: content.split(/\r?\n/).map(v => v.trim()).filter(Boolean), png};
    };
    // 本地小模型偶尔把结算页读成状态栏数字（真机：可见行1 只有时间/网速）。读到这种结果就重新截一次再读，
    // 不把“没读出来”误判成金额不一致。
    const meaningful = (lines: string[]) => lines.filter(line => /[\u4e00-\u9fa5]/.test(line)).length >= 5;
    let firstRead = await readCheckoutLines('checkout-read-1');
    for (let attempt = 0; attempt < 2 && !meaningful(firstRead.lines); attempt++) {
      log(`  [checkout] 首次整页读取无效，重试第 ${attempt + 1} 次`);
      await sleep(700);
      firstRead = await readCheckoutLines(`checkout-read-${attempt + 2}`);
    }
    // 第二次只读底部金额栏（约 2-3 秒），不用整页再读一遍，给 240 秒预算留余量。
    const bottomLines = await readCropLines('checkout-read-2', 0.72, 1).catch(() => [] as string[]);
    const secondRead = {lines: bottomLines, png: firstRead.png};
    // 隐私：收货地址、收件人、手机号一律不写日志、不落证据文字；门店地址是商家信息，保留。
    const redact = (line: string) => line
      .replace(/\d{11}/g, '***')
      .replace(/(公寓|小区|单元|宿舍|号楼|栋|室)\S*/g, '***');
    const isPersonal = (line: string) =>
      /\d{11}/.test(line) || /(公寓|小区|单元|宿舍|号楼|栋|室)/.test(line) ||
      (/天津/.test(line) && /(大学|学院|校区|新三村|学者|村)/.test(line));
    const safeLines = (lines: string[]) => lines.filter(line => !isPersonal(line)).map(redact);
    log(`  [checkout] 可见行1：${safeLines(firstRead.lines).slice(0, 18).join(' / ')}`);
    log(`  [checkout] 可见行2：${safeLines(secondRead.lines).slice(0, 18).join(' / ')}`);
    const amountFrom = (lines: string[]) => {
      // 结算页有几个金额：商品优惠后价、打包费、配送费、红包、合计、立即支付。应付必须取“立即支付/实付/合计”。
      const keywords = ['立即支付', '实付', '应付', '合计'];
      for (const key of keywords) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (!line.includes(key)) continue;
          const m = /(\d+(?:\.\d{1,2})?)/.exec(line.replace(/[¥￥]/g, ' '));
          if (m) return Math.round(Number(m[1]) * 100);
          // “合计”标签和金额可能分两行：看后面两行里纯金额
          for (const next of lines.slice(i + 1, i + 3)) {
            const n = /^[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(next.replace(/[¥￥]/g, '').trim());
            if (n) return Math.round(Number(n[1]) * 100);
          }
        }
      }
      return null;
    };
    const amountFen = amountFrom(firstRead.lines);
    const amountFen2 = amountFrom(secondRead.lines);
    if (amountFen == null || amountFen2 == null || amountFen !== amountFen2) throw new Error('taobao_payable_unverified');
    const itemLine = firstRead.lines.find(line => line.trim() === itemName) ?? null;
    const quantityLine = firstRead.lines.find(line => /^(x|×)?\s*1\s*(件|份)?$/.test(line.trim())) ?? null;
    if (itemLine && quantityLine) actualItem = {name: itemLine.trim(), spec: o.itemSpec, nodes: []};
    log(`  [checkout] 应付=${amountFen} 商品=${itemLine ?? '未读到'} 数量行=${quantityLine ?? '未读到'}`);
    // 费用行：读“优惠后/打包费/配送费/红包/已优惠”，按“商品原价 - 优惠 + 打包 + 配送 = 应付”核对。
    const amountAfter = (label: string) => {
      const idx = firstRead.lines.findIndex(line => line.includes(label));
      if (idx < 0) return null;
      for (const line of firstRead.lines.slice(idx, idx + 3)) {
        const m = /[¥￥]\s*(\d+(?:\.\d{1,2})?)/.exec(line);
        if (m) return Math.round(Number(m[1]) * 100);
      }
      return null;
    };
    const packagingFen = amountAfter('打包费');
    const deliveryFen = amountAfter('配送费');
    const discountFen = amountAfter('已优惠');
    const afterDiscountFen = amountAfter('优惠后');
    const subtotalFen = afterDiscountFen != null && discountFen != null ? afterDiscountFen + discountFen : null;
    const reconciled = packagingFen != null && deliveryFen != null && discountFen != null && subtotalFen != null &&
      subtotalFen - discountFen + packagingFen + deliveryFen === amountFen;
    log(`  [checkout] 费用行 原价=${subtotalFen} 优惠=${discountFen} 打包=${packagingFen} 配送=${deliveryFen} 核对=${reconciled}`);
    if (!reconciled) throw new Error('taobao_reconciliation_failed');
    // 证据：结算整页顶部 24% 涂黑（收货地址/收件人/电话区域），保留门店、商品、金额和费用明细。
    const floor = Math.round(H * 0.24);
    const maskedPng = await sharp(firstRead.png).composite([{input: await sharp({create: {width: W, height: floor, channels: 3, background: '#121719'}}).png().toBuffer(), left: 0, top: 0}]).png().toBuffer();
    const checkoutEvidence = await o.evidence.save(randomUUID(), 'checkout', maskedPng, safeLines(firstRead.lines).join('\n'), 'live');
    // 商品证据：在结算页截图上定位商品名那一行，裁一条单独存证。
    let itemEvidenceShot: Evidence | null = null;
    try {
      const [ix, iy] = await model.locate('taobao_instant', firstRead.png, `文字“${itemName}”`, signal);
      const bandTop = Math.max(floor, Math.round(iy) - 120);
      const bandH = Math.min(260, H - bandTop);
      const band = await sharp(firstRead.png).extract({left: 0, top: bandTop, width: W, height: bandH}).png().toBuffer();
      const bandLines = await o.model.text('taobao_instant', 'taobao_item_band',
        '把这张截图里的可见文字按行原样输出，最多 8 行；不要编号、不要总结。',
        {image: band, signal: activeSignal, maxImageWidth: 900, maxTokens: 260}).catch(() => '');
      itemEvidenceShot = await o.evidence.save(randomUUID(), 'item', band, bandLines.split(/\r?\n/).filter(Boolean).slice(0, 8).join('\n'), 'live');
    } catch {
      // 模型定位商品行偶发超时；结算页顶部已按 24% 涂黑，退回到固定的中上段裁一条商品证据（含商品名/数量/价格），
      // 保证身份证据链不断，同时不引入任何隐私区域。
      try {
        const bandTop = Math.round(H * 0.26), bandH = Math.min(Math.round(H * 0.14), H - bandTop);
        const band = await sharp(firstRead.png).extract({left: 0, top: bandTop, width: W, height: bandH}).png().toBuffer();
        itemEvidenceShot = await o.evidence.save(randomUUID(), 'item', band, safeLines(firstRead.lines).slice(0, 10).join('\n'), 'live');
        log('  [checkout] 商品行定位失败，改用固定中上段作商品证据');
      } catch { /* 仍失败则让身份校验明确失败 */ }
    }
    if (!actualStore || !actualItem || !storeEvidence || !itemEvidenceShot) throw new Error('taobao_identity_unverified');
    mark('采数完成', true);
    return {checkoutSha256: checkoutEvidence.sha256, checkoutEvidence, storeEvidence, itemEvidence: itemEvidenceShot,
      store: actualStore.name, storeAddress: actualStore.address, item: actualItem.name, itemSpec: actualItem.spec,
      originalFen: subtotalFen, discountFen, packagingFen, deliveryFen, redPacketFen: null,
      totalFen: amountFen, steps, rawText: JSON.stringify({lines: safeLines(firstRead.lines)}), reconciled: true};
  } catch (e) {
    log('采集异常:', (e as Error).message);
    return {error:(e as Error).message,store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};
  } finally {
    if (cartMayHaveChanged) {
      activeSignal=AbortSignal.timeout(120_000);
      try {
        await requireForeground();
        // 判断当前是不是结算页（底栏有“立即支付/提交订单”）；是就退回商品列表，不是就在当前列表页处理。
        let bottom = await readCropLines('cleanup-current', 0.80, 1).catch(() => [] as string[]);
        const onCheckout = bottom.some(line => /立即支付|提交订单|确认订单/.test(line));
        if (onCheckout) {
          await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
          await sleep(2_500);
          bottom = await readCropLines('cleanup-after-back', 0.82, 1).catch(() => [] as string[]);
        }
        const hasOwnedItem = (lines: string[]) => lines.some(line => /去结算|到手约|共减/.test(line));
        log('  [cleanup] 开始恢复购物车 底栏=' + bottom.slice(0, 4).join(' / '));
        // 本次任务开始时已确认空车，购物车里的商品只可能是本次加购的，因此可以按减号移除。
        for (let i = 0; i < 3 && hasOwnedItem(bottom); i++) {
          const shot = await snap(`cleanup-remove-${i + 1}`);
          let hit: [number, number] | null = null;
          try { hit = await model.locate('taobao_instant', shot, '红色减号“−”按钮', activeSignal); } catch { /* 下一轮再试 */ }
          if (!hit) {
            // 减号定位失败时，打开左下角购物车面板，点面板右上角“清空”（任务开始时已确认该店空车，
            // 因此该店购物车里的商品只可能是本次加购），再确认底部回到空车状态。
            log('  [cleanup] 减号定位失败，尝试购物车面板清空');
            await adb(['shell', 'input', 'tap', String(Math.round(W * 0.107)), String(Math.round(H * 0.966))]);
            await sleep(1_600);
            const panelShot = await snap('cleanup-clear-panel');
            let clearHit: [number, number] | null = null;
            try { clearHit = await model.locate('taobao_instant', panelShot, '文字“清空”', activeSignal); } catch { clearHit = null; }
            if (clearHit) {
              await adb(['shell', 'input', 'tap', String(Math.round(clearHit[0])), String(Math.round(clearHit[1]))]);
              await sleep(1_400);
              // 可能有二次确认弹窗
              const confirmShot = await snap('cleanup-clear-confirm');
              let okHit: [number, number] | null = null;
              try { okHit = await model.locate('taobao_instant', confirmShot, '文字“确定”或“确认”按钮', activeSignal); } catch { okHit = null; }
              if (okHit) { await adb(['shell', 'input', 'tap', String(Math.round(okHit[0])), String(Math.round(okHit[1]))]); await sleep(1_200); }
              await adb(['shell', 'input', 'tap', String(Math.round(W * 0.5)), String(Math.round(H * 0.16))]).catch(() => null);
              await sleep(1_000);
              bottom = await readCropLines(`cleanup-bar-clear-${i + 2}`, 0.82, 1).catch(() => [] as string[]);
              continue;
            }
            break;
          }
          await adb(['shell', 'input', 'tap', String(Math.round(hit[0])), String(Math.round(hit[1]))]);
          await sleep(1_800);
          bottom = await readCropLines(`cleanup-bar-${i + 2}`, 0.82, 1).catch(() => [] as string[]);
        }
        const empty = bottom.some(line => /起送/.test(line)) && !hasOwnedItem(bottom);
        if (empty) { cartMayHaveChanged=false; o.onCleanup('restored'); }
      } catch { /* 未确认恢复时保留隔离状态 */ }
    }
    if (!cartMayHaveChanged) await escape();
  }
}
