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
      const [cx, cy] = await model.locate('taobao_instant', crop, '橙色底白色“搜索”按钮', signal);
      const x = left + Math.round(cx), y = top + Math.round(cy);
      if (x < Math.round(w * 0.55) || x > w - 5 || y > Math.round(h * 0.16)) {
        log(`  [orange-search] 定位越界 (${x},${y})`);
        return false;
      }
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
    await adb(['shell', 'am', 'start', '-S', '-n', 'com.taobao.taobao/com.taobao.tao.welcome.Welcome']);
    // 冷启动不要死等固定秒数：实测首页常在 8-10 秒就可用，死等 20 秒纯属浪费；
    // 但双 11 弹层期会更慢，所以改成「先等 8 秒，再用首页 tab 特征轮询确认就绪」。
    await sleep(8_000);
    await snap('boot-check');
    await readNodes();
    mark('冷启动淘宝', true);

    // 1 首页 →「闪购外卖」tab
    // 冷启动后的首页偶尔会自己跳回“推荐”页或弹活动层：点完闪购必须确认页面真的变了，再继续。
    // 页面是否切换用截图差异判断（模型读字偶发回显提示词，不适合作页面状态判据）。
    let s1 = false;
    for (let i = 0; i < 3 && !s1; i++) {
      const before = await snap(`flash-before-${i + 1}`);
      const tapped = await tapByVision('文字“闪购”', i === 0 ? 'flash-tab' : `flash-tab-${i + 1}`, {yMin: Math.round(H*0.04), yMax: Math.round(H*0.11), cropTopRatio: 0.02, cropBottomRatio: 0.13}, 1);
      if (!tapped) continue;
      await sleep(2_500);
      const after = await snap(`flash-after-${i + 1}`);
      const mad = await screenMAD(before, after);
      s1 = mad >= 6;
      log(`  [flash-tab] 第${i + 1}次点击后画面差异=${mad.toFixed(1)} 判定=${s1 ? '已切换' : '未切换'}`);
      if (!s1) {
        try { const {writeFile} = await import('node:fs/promises'); await writeFile(`.runtime/tb-flash-fail-${i + 1}.png`, after); } catch { /* 诊断 */ }
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
      return /综合/.test(text) && /销量/.test(text) && /速度/.test(text) && !/历史搜索|搜索发现|专属好店/.test(text);
    };
    let s3 = false;
    const checkResults = async (tag: string) => {
      try {
        const lines = await readCropLines(tag, 0.04, 0.34, {maxLines: 18, maxTokens: 460});
        const ok = looksLikeResults(lines);
        if (!ok) log(`  [results] ${tag} 未见结果页特征，行：${lines.slice(0, 10).join(' / ')}`);
        return ok;
      } catch (error) {
        log(`  [results] ${tag} 读取失败：${(error as Error).message}`);
        return false;
      }
    };
    if (s2 && typedBrand) {
      const tapCalibratedSearch = async () => {
        await adb(['shell', 'input', 'tap', String(Math.round(W * 0.86)), String(Math.round(H * 0.0975))]);
      };
      // 每次提交后用“截图差异”判断是否发生了页面跳转（比读文字判定稳，且不会把搜索建议下拉误判为结果页）；
      // 只有页面没变时才继续用文字特征判断。
      const submitAndCheck = async (tag: string, action: () => Promise<void>) => {
        const before = await snap(`${tag}-before`);
        await action();
        await sleep(2_800);
        const after = await snap(`${tag}-after`);
        const mad = await screenMAD(before, after);
        log(`  [results] ${tag} 画面差异=${mad.toFixed(1)}`);
        if (mad >= 10) return true;
        return await checkResults(tag);
      };
      s3 = await submitAndCheck('results-check-1', tapCalibratedSearch);
      if (!s3) {
        log('  [results] 点搜索按钮后页面未变化，补一次回车');
        s3 = await submitAndCheck('results-check-2', async () => { await adb(['shell', 'input', 'keyevent', '66']); });
      }
      if (!s3) {
        log('  [results] 仍未跳转，点第一条搜索建议');
        try {
          const shot = await snap('suggest');
          const meta = await sharp(shot).metadata();
          const w = meta.width ?? W, h = meta.height ?? H;
          const top = Math.round(h * 0.05), ch = Math.round(h * 0.30);
          const crop = await sharp(shot).extract({left: 0, top, width: w, height: ch}).png().toBuffer();
          const [cx, cy] = await model.locate('taobao_instant', crop, `文字“${brand}”`, signal);
          const gx = Math.round(cx), gy = top + Math.round(cy);
          if (gy > Math.round(h * 0.07) && gy < Math.round(h * 0.38)) {
            s3 = await submitAndCheck('results-check-3', async () => { await adb(['shell', 'input', 'tap', String(gx), String(gy)]); });
          }
        } catch (error) {
          log('  [results] 搜索建议定位失败：' + (error as Error).message);
        }
      }
      if (!s3) {
        log('  [results] 兜底：视觉定位橙色搜索按钮再点一次');
        s3 = await submitAndCheck('results-check-4', async () => { await tapOrangeSearch(); });
      }
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
      const storeName = (brandLines.find(line => line.includes(brand) && /店/.test(line) && line.length < 60) ?? null) && clean(brandLines.find(line => line.includes(brand) && /店/.test(line) && line.length < 60)!);
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
    const s5 = s4 && await tapByVision('文字“搜一搜”的搜索框', 'shopsearch', {yMin: Math.round(H*0.02), yMax: Math.round(H*0.16), cropTopRatio: 0.01, cropBottomRatio: 0.18});
    mark('打开店内搜索', !!s5);

    // 6 店内搜单品
    const typedItem = s5 && await typeChinese(itemName);
    await sleep(1800);
    const s6 = s5 && (await tapOrangeSearch());
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
      // 目标单品行通常排在 3 个套餐之后、首屏看不到；先大幅上滑一次，减少“找按钮-读行标题”的轮数（每次约 10 秒）。
      await adb(['shell', 'input', 'swipe', String(Math.round(W / 2)), String(Math.round(H * 0.74)), String(Math.round(W / 2)), String(Math.round(H * 0.28)), '360']);
      await sleep(1_500);
      for (let attempt = 0; attempt < 4 && !s7; attempt++) {
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
          if (rowLines.some(line => line === itemName)) {
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
      for (let i = 0; i < 2 && !s9; i++) {
        const before = await snap(`checkout-before-${i + 1}`);
        const tapped = await tapByVision('“去结算”按钮', 'checkout', {yMin: Math.round(H * 0.90), yMax: H - 10, cropTopRatio: 0.86, cropBottomRatio: 1}, 1);
        if (!tapped) continue;
        await sleep(3_500);
        const after = await snap(`checkout-after-${i + 1}`);
        const mad = await screenMAD(before, after);
        s9 = mad >= 6;
        log(`  [checkout] 第${i + 1}次点击后画面差异=${mad.toFixed(1)} 判定=${s9 ? '已进入结算页' : '未跳转'}`);
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
        {image: png, signal: activeSignal, maxImageWidth: 800, maxTokens: 650});
      return {lines: content.split(/\r?\n/).map(v => v.trim()).filter(Boolean), png};
    };
    const firstRead = await readCheckoutLines('checkout-read-1');
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
    } catch { /* 定位不到商品行时，后面的身份校验会明确失败 */ }
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
        // 本次任务开始时已确认空车，购物车里的商品只可能是本次加购的，因此可以按减号移除。
        for (let i = 0; i < 3 && hasOwnedItem(bottom); i++) {
          const shot = await snap(`cleanup-remove-${i + 1}`);
          let hit: [number, number] | null = null;
          try { hit = await model.locate('taobao_instant', shot, '红色减号“−”按钮', activeSignal); } catch { /* 下一轮再试 */ }
          if (!hit) break;
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
