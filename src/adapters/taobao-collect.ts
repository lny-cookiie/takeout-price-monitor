// 淘宝闪购单品采集链路。
//
// 架构定位（与京东/美团的关键差异，2026-11-12 实测定稿）：
//   京东/美团：u2 读屏拿到节点 bounds → 精确点击 → guardMainPath 白名单断言。
//   淘宝：Flutter 自绘 + H5 自绘，u2 实测读不到任何节点（原生页 0 节点、H5 页 1 节点 0 文字），
//         因此整条链路只能用视觉定位，且**不能**用 guardMainPath 做偏航判定
//         （读不到节点必然判 unknown 并 back，2026-11-09 深夜正是这样把跑通的链路改坏的）。
//
// 三条核心经验：
//   1) 视觉定位必须配「页面结构硬约束」（y 区间），否则模型会被顶部广告位里的同名文字带偏。
//   2) 同一页出现多个近似商品名（"板烧鸡腿堡" / "双层板烧鸡腿堡"）时，2B 视觉模型无法区分，
//      该步骤必须用配置化的相对比例坐标（见 src/adapters/taobao-calibration.json）。
//   3) 中文输入走 yadb（com.ysbing.yadb.Main + /data/local/tmp），不用 adb input text。
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import type {ModelGateway} from '../infra/model.js';

const run = promisify(execFile);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), '[taobao]', ...a);

/** 标定值从配置读取，不硬编码在代码里（agent.md 5.4 节与第 6 节绝对坐标禁令的例外条款）。
 *  配置里记录了校准设备（型号/分辨率/density/App 版本）与重新校准的触发条件。 */
const CALIBRATION_PATH = 'src/adapters/taobao-calibration.json';
interface TaobaoCalibration {
  schema: string;
  device: {model: string; resolution: string; density: number; appVersion: string; calibratedAt: string};
  ratios: {
    shopSearchAddButton: {xRatio: number; yRatio: number; label: string; measuredPx: [number, number]};
    detailQuantityMinus: {xRatio: number; yRatio: number; label: string; measuredPx: [number, number]};
  };
}
function loadCalibration(): TaobaoCalibration {
  // 用相对 session cwd 的路径读取；配置随代码进版本库，便于追溯标定时的设备信息
  const raw = readFileSync(CALIBRATION_PATH, 'utf8');
  const parsed = JSON.parse(raw) as TaobaoCalibration;
  if (parsed.schema !== 'taobao-calibration/v1') throw new Error('taobao_calibration_schema_mismatch');
  const {shopSearchAddButton, detailQuantityMinus} = parsed.ratios;
  for (const [name, r] of Object.entries({shopSearchAddButton, detailQuantityMinus})) {
    if (!(r.xRatio > 0 && r.xRatio < 1) || !(r.yRatio > 0 && r.yRatio < 1)) {
      throw new Error(`taobao_calibration_invalid_ratio:${name}`);
    }
  }
  return parsed;
}

export interface TaobaoStep {name: string; ok: boolean; detail?: string}
export interface TaobaoQuote {
  store: string | null;
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
  /** 目标门店名关键字，例如「鞍山西道」；为空则取搜索结果第一家 */
  storeKeyword?: string;
  model: Pick<ModelGateway, 'locate' | 'json'>;
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
  const steps: TaobaoStep[] = [];
  // 读取标定配置（比例 + 校准设备信息）；配置非法时直接抛错，不带着错误坐标去点
  const calibration = loadCalibration();
  const addButton = calibration.ratios.shopSearchAddButton;
  let W = 1260, H = 2844;
  const adb = async (args: string[]) =>
    (await run(adbPath, ['-s', serial, ...args], {encoding: 'buffer', maxBuffer: 64 * 1024 * 1024})).stdout;

  const snap = async (tag: string): Promise<Buffer> => {
    const png = (await adb(['exec-out', 'screencap', '-p'])) as Buffer;
    await writeFile(`.runtime/tb-${tag}.png`, png).catch(() => null);
    const m = await sharp(png).metadata();
    W = m.width ?? W; H = m.height ?? H;
    return png;
  };

  const mark = (name: string, ok: boolean, detail?: string) => {
    steps.push({name, ok, detail});
    o.onStep?.(name);
    log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  /** 视觉定位点击；yMin/yMax 是页面结构硬约束，用于排除广告位等干扰 */
  const tapByVision = async (hint: string, tag: string, r: {yMin?: number; yMax?: number} = {}, retries = 3): Promise<boolean> => {
    const yMin = r.yMin ?? 60, yMax = r.yMax ?? H - 70;
    for (let i = 1; i <= retries; i++) {
      try {
        const png = await snap(`${tag}-r${i}`);
        const [x0, y0] = await model.locate('taobao_instant', png, hint, signal);
        const x = Math.round(x0), y = Math.round(y0);
        if (x < 10 || x > W - 10 || y < yMin || y > yMax) {
          log(`  [${tag}] 第${i}次越界 (${x},${y}) 允许 y[${yMin}-${yMax}]`);
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
      await run(adbPath, ['-s', serial, 'push', yadbPath, '/data/local/tmp/'], {timeout: 20_000, encoding: 'utf8'}).catch(() => null);
      const out = await run(adbPath, ['-s', serial, 'shell',
        `app_process -Djava.class.path=/data/local/tmp/yadb /data/local/tmp com.ysbing.yadb.Main -keyboard '${text.replace(/'/g, "'\\''")}'`],
        {timeout: 25_000, encoding: 'utf8'});
      return out.stdout.includes('Copy text:true');
    } catch { return false; }
  };

  const escape = () => {
    // 淘宝内链路可能停在任意页面，连续 back 回到淘宝主页面
    for (let i = 0; i < 3; i++) adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']).catch(() => null);
  };

  try {
    // 模型预热：本地 2B 视觉模型在长时间空闲后，第一次推理会明显变慢甚至撞满 60s 超时。
    // 实测 3 轮连测里只有第 1 轮失败（flash-tab 连续 model_location_failed），后两轮都正常，
    // 就是首次请求冷启动导致。这里先发一个极小的文本请求把模型唤醒。
    try {
      await model.json('taobao_instant', 'taobao_warmup', '只输出 JSON {"ok":true}。', {ok: true}, v => v,
        {signal: AbortSignal.timeout(150_000)});
      log('模型预热完成');
    } catch { log('模型预热未完成，继续尝试正式流程'); }

    // 0 唤醒屏幕并回到可操作的桌面状态。
    // 设备息屏时 screencap 会得到约 20KB 的全黑图，视觉定位必然错——这是实测踩过的坑。
    await adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']).catch(() => null);
    await sleep(900);
    await adb(['shell', 'svc', 'power', 'stayon', 'true']).catch(() => null);
    for (let i = 0; i < 3; i++) {
      await adb(['shell', 'cmd', 'statusbar', 'collapse']).catch(() => null);
      await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']).catch(() => null);
      await sleep(600);
    }
    await adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']).catch(() => null);
    await sleep(1400);
    mark('唤醒屏幕', true);

    // 冷启动淘宝，保证从干净首页开始。
    // 等待时间不能太短：淘宝冷启动期间会占满 CPU，此时立刻调视觉模型会拖到 60 秒超时
    // （2026-11-12 实测：等 11 秒时连续 3 次 model_location_failed，每次卡满 62 秒）。
    await adb(['shell', 'am', 'start', '-S', '-n', 'com.taobao.taobao/com.taobao.tao.welcome.Welcome']);
    await sleep(20_000);
    mark('冷启动淘宝', true);

    // 1 首页 →「闪购外卖」tab
    const s1 = await tapByVision('页面顶部 tab 栏里“闪购外卖”四个字（“推荐”右侧相邻那项，黄色“闪购”+红底“外卖”）', 'flash-tab', {yMin: 120, yMax: 300});
    mark('进入闪购频道', s1);
    if (!s1) return {store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};

    // 2 闪购频道页 → 搜索框
    const s2 = await tapByVision('闪购频道页最上方的搜索输入框（左侧“闪购▾”，中间是推荐词，右侧橙色“搜索”按钮）', 'searchbox', {yMin: 260, yMax: 430});
    mark('打开搜索框', s2);

    // 3 输入品牌并搜索
    const typedBrand = s2 && await typeChinese(brand);
    await sleep(1500);
    const s3 = s2 && await tapByVision('页面顶部橙色底、白色“搜索”两个字的按钮', 'brand-search', {yMin: 140, yMax: 360});
    mark('搜索品牌', !!s3, `${brand} 注入=${typedBrand}`);

    // 4 结果页 → 目标门店（y 区间避开顶部“超抢手”广告位）
    const storeHint = o.storeKeyword
      ? `搜索结果列表里名字包含“${o.storeKeyword}”的那家麦当劳门店卡片标题行（在“综合/销量/速度”排序栏下方）`
      : '搜索结果列表里第一家麦当劳门店卡片的标题行（在“综合/销量/速度”排序栏下方）';
    const s4 = s3 && await tapByVision(storeHint, 'store', {yMin: Math.round(H * 0.30), yMax: Math.round(H * 0.65)});
    mark('进入目标门店', !!s4);

    // 5 门店页下滑，让顶部展开完整的“搜一搜”搜索框（刚进店只有小放大镜，无法定位）
    if (s4) {
      await adb(['shell', 'input', 'swipe', String(Math.round(W / 2)), String(Math.round(H * 0.62)), String(Math.round(W / 2)), String(Math.round(H * 0.28)), '420']);
      await sleep(2600);
    }
    const s5 = s4 && await tapByVision('页面顶部灰色圆角搜索输入框（占位文字“搜一搜”，右侧有放大镜图标）', 'shopsearch', {yMin: 60, yMax: 430});
    mark('打开店内搜索', !!s5);

    // 6 店内搜单品
    const typedItem = s5 && await typeChinese(itemName);
    await sleep(1800);
    const s6 = s5 && await tapByVision('页面顶部或右上角橙色底、白色“搜索”两个字的按钮', 'item-search', {yMin: 60, yMax: 540});
    mark('店内搜单品', !!s6, `${itemName} 注入=${typedItem}`);

    // 7 点目标单品加号。用标定的相对比例坐标。
    // 注意：搜索后页面本来就停在顶部，这里**不要**再 swipe 回滚——实测多余滑动会让商品行偏移，
    // 导致标定坐标点空（2026-11-12 复现：加了 swipe 后停在结果页，去掉后正常进入单品详情页）。
    let s7 = false;
    if (s6) {
      await sleep(3000);
      const ax = Math.round(W * addButton.xRatio);
      const ay = Math.round(H * addButton.yRatio);
      await adb(['shell', 'input', 'tap', String(ax), String(ay)]);
      log(`  [add-item] 标定坐标点击 (${ax},${ay}) = (${addButton.xRatio}W, ${addButton.yRatio}H) 校准设备=${calibration.device.model}/${calibration.device.resolution}`);
      await sleep(4000);
      s7 = true;
    }
    mark('定位单品', s7);

    // 8 详情页会不会已经加购，取决于第 7 步是否精确点中「+」图标本身：
    //    点中 → 直接加购（详情页显示 − N + 数量控件，无「加入购物车」按钮）
    //    点偏 → 只进详情页（仍有「加入购物车」按钮，购物车仍 ¥0）
    //    所以这里无条件尝试点一次「加入购物车」；已经加购时按钮不存在，定位失败即可，不重试。
    const s8 = s7 && await tapByVision('页面右下角深红色矩形“加入购物车”按钮', 'addcart',
      {yMin: Math.round(H * 0.40), yMax: Math.round(H * 0.68)}, 1);
    mark('加购结算', !!s8 || s7);
    await sleep(2200);

    // 9 去结算
    const s9 = s7 && await tapByVision('页面底部购物车栏最右侧那个红色“去结算”按钮', 'checkout', {yMin: Math.round(H * 0.85), yMax: H - 10});
    mark('去结算', !!s9);
    await sleep(5000);

    if (!s9) return {store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};

    // 10 读结算页字段：先截大图存档，再让模型逐项读金额（复杂嵌套 schema 2B 模型容易输出不合法）
    const png = await snap('checkout-final');
    const img = await sharp(png).resize(Math.round(W * 0.62)).jpeg({quality: 85}).toBuffer();
    const ask = async (task: string): Promise<string | null> => {
      try {
        const r = await model.json<{value: string}>('taobao_instant', 'taobao_checkout_field',
          '读取这张淘宝结算页截图里的指定金额，只输出图中明确显示的数字（含¥符号），读不到就输出空字符串。只依据可见内容，不猜。',
          {task}, v => v as {value: string}, {image: img, signal,
            schema: {type: 'object', properties: {value: {type: 'string'}}, required: ['value'], additionalProperties: false}});
        return (r as {value?: string})?.value?.trim() || null;
      } catch { return null; }
    };
    const total = await ask('最下方“立即支付”按钮上显示的最终应付金额');
    const packaging = await ask('“打包费”这一行右侧的金额');
    const delivery = await ask('“配送费”这一行右侧的金额');
    const redPacket = await ask('“闪购红包”这一整行最右侧那个金额（通常带减号，形如 -¥6 或 -6）；只输出这一行的金额，不要输出底部的合计/总计金额');
    const original = await ask('商品行“板烧鸡腿堡”右侧的原价金额');
    const discounted = await ask('商品行“板烧鸡腿堡”下方红色的“优惠后”金额');

    const storeTxt = await (async () => {
      try {
        const r = await model.json<{value: string}>('taobao_instant', 'taobao_store_name',
          '读出结算页顶部商品分组右侧的门店全名（形如「麦当劳&麦咖啡(天津鞍山西店)」），只输出门店名。',
          {}, v => v as {value: string}, {image: img, signal,
            schema: {type: 'object', properties: {value: {type: 'string'}}, required: ['value'], additionalProperties: false}});
        return (r as {value?: string})?.value?.trim() || null;
      } catch { return null; }
    })();

    const fen = (s: string | null): number | null => {
      if (!s) return null;
      const m = /-?\d+(?:\.\d+)?/.exec(s.replace(/,/g, ''));
      if (!m) return null;
      const n = Number(m[0]);
      return Number.isFinite(n) ? Math.round(n * 100) : null;
    };

    mark('采数完成', total != null, `合计=${total}`);

    return {
      store: storeTxt,
      item: itemName,
      originalFen: fen(original),
      discountFen: fen(discounted),
      packagingFen: fen(packaging),
      deliveryFen: fen(delivery),
      redPacketFen: fen(redPacket),
      totalFen: fen(total),
      steps,
      rawText: JSON.stringify({total, packaging, delivery, redPacket, original, discounted, store: storeTxt}),
    };
  } catch (e) {
    log('采集异常:', (e as Error).message);
    return {store: null, item: null, originalFen: null, discountFen: null, packagingFen: null, deliveryFen: null, redPacketFen: null, totalFen: null, steps, rawText: null};
  } finally {
    escape();
  }
}
