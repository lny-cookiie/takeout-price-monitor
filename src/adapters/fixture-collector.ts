import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import { CollectionError, CONTRACT_VERSION, TENANT, validateTask, parseCny, checkObservation, type Collector, type Platform, type Task, type AttemptResult, type TraceStep, type Evidence, type Observation, type MoneyComponent } from '../domain/contracts.js';
import { getBasket } from '../domain/catalog.js';
import { BrowserPool } from '../infra/browser.js';
import { EvidenceStore } from '../infra/evidence.js';

interface PageMap { search: string; searchButton: string; enter: string; choose: string; add: string; checkout: string; total: string; delivery: string; packaging: string }
const MT: PageMap = { search: '搜索商家', searchButton: '搜索', enter: '进入门店', choose: '选规格', add: '加入购物车', checkout: '去结算', total: 'mt-payable', delivery: 'mt-delivery', packaging: 'mt-packaging' };
const TB: PageMap = { search: '搜索门店和商品', searchButton: '找店', enter: '逛这家店', choose: '选择口味', add: '加入购物袋', checkout: '确认购物袋', total: 'tb-payment-total', delivery: 'tb-shipping-fee', packaging: 'tb-box-fee' };
// This adapter is intentionally limited to owned loopback fixtures; it cannot navigate to competitors.
export class FixtureCollector implements Collector {
  constructor(readonly platform: Platform, private origin: string, private browser: BrowserPool, private evidence: EvidenceStore, private map: PageMap) {
    const u = new URL(origin);
    if (u.hostname !== '127.0.0.1' || u.protocol !== 'http:') throw new Error('fixtures_require_loopback');
  }
  async collect(task: Task, attemptId: string, signal: AbortSignal, attemptNumber = 1): Promise<AttemptResult> {
    const started = new Date().toISOString(), trace: TraceStep[] = [];
    let context: BrowserContext | undefined, page: Page | undefined, evidence: Evidence | null = null;
    let observation: Observation | null = null, status: AttemptResult['status'] = 'failed', error: string | null = null, availability = 'unknown';
    let cleanup: AttemptResult['cleanup'] = 'untouched', touchedCart = false;
    const mark = (phase: string, note: string, action = 'browse') => {
      if (signal.aborted) throw new CollectionError(Date.now() > Date.parse(task.deadline_at) ? 'window_missed' : 'task_timeout');
      if (Date.now() > Date.parse(task.deadline_at)) throw new CollectionError('window_missed');
      if (!task.allowed_actions.includes(action)) throw new CollectionError('action_not_allowed','blocked');
      trace.push({ phase, note, at: new Date().toISOString() });
    };
    const abort = () => { void context?.close().catch(() => {}); };
    try {
      if (task.data_mode !== 'synthetic' || task.tenant_id !== TENANT || task.entry_point !== `local_fixture_${this.platform}_v1`) throw new CollectionError('live_source_not_ready','blocked');
      validateTask(task);
      if (task.platform !== this.platform) throw new CollectionError('platform_mismatch');
      const { store, basket } = getBasket(task);
      mark('preflight','本地模拟来源；检查时窗、动作范围与固定场景');
      context = await (await this.browser.get()).newContext({ viewport: { width: 880, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
      await context.route('**/*',route => new URL(route.request().url()).origin === this.origin ? route.continue() : route.abort('blockedbyclient'));
      signal.addEventListener('abort',abort,{ once: true });
      if (signal.aborted) throw new CollectionError('task_timeout');
      page = await context.newPage(); page.setDefaultTimeout(6000); page.setDefaultNavigationTimeout(8000);
      const response = await page.goto(`${this.origin}/fixtures/${this.platform}?fault=${task.fault}&session=${attemptId}&attempt=${attemptNumber}`);
      if (response?.status() === 503) throw new CollectionError('network_error');
      mark('session','核对测试账号与配送点位');
      if ((await page.getByTestId('account-ref').innerText()).trim() !== task.account_ref || (await page.getByTestId('delivery-point').innerText()).trim() !== task.delivery_point_id) throw new CollectionError('scenario_mismatch');
      mark('store','按名称搜索，并用分店地址核对目标店铺');
      await page.getByRole('textbox',{ name: this.map.search, exact: true }).fill(store.name);
      await page.getByRole('button',{ name: this.map.searchButton, exact: true }).click();
      const target = page.locator(`[data-store-id="${store.id}"]`);
      if (!(await target.innerText()).includes(store.address)) throw new CollectionError('store_mismatch');
      await target.getByRole('button',{ name: this.map.enter, exact: true }).click();
      if (await page.getByTestId('access-block').count()) throw new CollectionError('captcha_required','blocked');
      if (!(await page.locator('[data-page="menu"]').count())) throw new CollectionError('schema_changed');
      if ((await page.getByTestId('store-name').innerText()).trim() !== store.name || (await page.getByTestId('store-address').innerText()).trim() !== store.address) throw new CollectionError('store_mismatch');
      if (await page.getByTestId('business-status').count()) throw new CollectionError('sold_out','unavailable','sold_out');
      mark('menu','检查目标商品及起价标识；不把菜单起价当结算价');
      for (const item of basket.items) {
        const product = page.locator(`[data-product-id="${item.product_id}"]`);
        if (!(await product.innerText()).includes(item.name)) throw new CollectionError('item_mismatch');
        const displayed = (await product.getByTestId('display-price').innerText()).trim();
        mark('menu_item',`${item.name} 页面标价：${displayed}；不作为结算价`);
      }
      if (await page.getByTestId('cart').getAttribute('data-owner') !== attemptId) throw new CollectionError('cart_not_owned','blocked');
      mark('variants','逐项选规格、套餐和数量','select_variant');
      for (const item of basket.items) {
        mark('cart',`${item.name} / ${item.variant} × ${item.quantity}`,'modify_owned_test_cart');
        await page.locator(`[data-product-id="${item.product_id}"]`).getByRole('button',{ name: this.map.choose, exact: true }).click();
        const dialog = page.getByRole('dialog');
        if (this.platform === 'meituan') await dialog.getByRole('combobox',{ name: '规格', exact: true }).selectOption({ label: item.variant });
        else await dialog.getByRole('radio',{ name: item.variant, exact: true }).check();
        await dialog.getByRole('spinbutton',{ name: '数量', exact: true }).fill(String(item.quantity));
        await dialog.getByRole('button',{ name: this.map.add, exact: true }).click();
        touchedCart = true;
      }
      const verifyBasket = async () => {
        const lines = page!.locator('[data-cart-product]');
        if (await lines.count() !== basket.items.length) throw new CollectionError('basket_mismatch');
        for (const item of basket.items) {
          const row = page!.locator(`[data-cart-product="${item.product_id}"]`);
          if ((await row.locator('[data-field="variant"]').innerText()).trim() !== item.variant || Number(await row.locator('[data-field="quantity"]').innerText()) !== item.quantity) throw new CollectionError('basket_mismatch');
        }
      };
      await verifyBasket();
      mark('checkout','核对完整购物篮，进入结算；禁止提交订单','read_checkout');
      await page.getByRole('button',{ name: this.map.checkout, exact: true }).click();
      await page.locator('[data-page="checkout"]').waitFor();
      if (await page.getByTestId('business-status').count()) throw new CollectionError('minimum_not_met','unavailable','minimum_not_met');
      await page.locator('[data-quote-ready="true"]').waitFor();
      await verifyBasket();
      mark('quote','读取当前整篮应付；两次同屏核对稳定后保存证据','read_checkout');
      const raw = (await page.getByTestId(this.map.total).innerText()).trim();
      await page.waitForTimeout(120);
      if ((await page.getByTestId(this.map.total).innerText()).trim() !== raw) throw new CollectionError('quote_unstable');
      const observed = new Date().toISOString();
      const component = async (id:string): Promise<MoneyComponent> => {
        if (!await page!.getByTestId(id).count()) return {amount_fen:null,raw_value:null,basis:'unknown',included_in:null};
        const raw_value=(await page!.getByTestId(id).innerText()).trim();
        return {amount_fen:parseCny(raw_value),raw_value,basis:'separately_displayed',included_in:'checkout_payable'};
      };
      const delivery = await component(this.map.delivery), packaging = await component(this.map.packaging);
      evidence = await this.evidence.capture(page,randomUUID(),'checkout');
      const missing: Record<string,string> = {};
      if (delivery.amount_fen === null && task.requested_fields.includes('delivery_fee')) missing.delivery_fee = 'not_visible';
      if (packaging.amount_fen === null && task.requested_fields.includes('packaging_fee')) missing.packaging_fee = 'not_visible';
      observation = {
        observation_id: randomUUID(), source_id: task.source_id, tenant_id: task.tenant_id, slot_id: task.slot_id, attempt_id: attemptId, platform: task.platform,
        store_id: task.store_id, basket_id: task.basket_id, scenario_id: task.scenario_id,
        price_kind: 'checkout_payable', price_scope: 'basket', currency: 'CNY', amount_fen: parseCny(raw), raw_value: raw,
        components: { delivery_fee: delivery, packaging_fee: packaging }, missing_reasons: missing,
        observed_at: observed, collected_at: evidence.captured_at, value_origin: 'synthetic', quote_valid: true, detail_complete: !Object.keys(missing).length,
        basket_items: basket.items, account_ref: task.account_ref, delivery_point_id: task.delivery_point_id, entry_point: task.entry_point,
        evidence_refs: [evidence], contract_version: CONTRACT_VERSION, collector_version: `${this.platform}-fixture-0.1.0`
      };
      checkObservation(task,observation);
      status = observation.detail_complete ? 'success' : 'partial'; error = status === 'partial' ? 'details_not_visible' : null; availability = 'available';
      mark('publish','金额、场景和证据检查通过；模拟数据单独保存');
    } catch (e) {
      observation = null;
      const known = e instanceof CollectionError;
      status = known ? e.status : 'failed'; error = known ? e.code : signal.aborted ? 'task_timeout' : 'execution_error';
      availability = known ? e.availability : 'unknown';
      trace.push({ phase: 'stop', at: new Date().toISOString(), note: `${error}${known ? '' : ': ' + String(e).slice(0,240)}` });
      if (page && !page.isClosed()) try { evidence = await this.evidence.capture(page,randomUUID(),'failure'); } catch { /* Failure without readable evidence is not a quote. */ }
    } finally {
      signal.removeEventListener('abort',abort);
      if (page && touchedCart && !page.isClosed()) {
        try {
          const restored = await page.evaluate(session => {
            const w = window as unknown as { __restoreOwnedCart?: (s:string) => boolean; __fixtureState?: {cart: unknown[]} };
            return w.__restoreOwnedCart?.(session) === true && w.__fixtureState?.cart.length === 0;
          },attemptId);
          cleanup = restored ? 'restored' : 'quarantined';
        } catch { cleanup = 'quarantined'; }
      }
      await context?.close().catch(() => {});
      trace.push({ phase: 'cleanup', at: new Date().toISOString(), note: cleanup === 'restored' ? '仅清理本次自有模拟购物篮' : cleanup === 'quarantined' ? '未确认恢复，隔离本会话' : '未改动购物车' });
    }
    return { status, error_code: error, availability, observation, trace, evidence, started_at: started, finished_at: new Date().toISOString(), cleanup, cost: { model_yuan: null, execution_ms: Date.now()-Date.parse(started) } };
  }
  async close(): Promise<void> { /* Shared browser lifecycle belongs to the composition root. */ }
}
export const meituanCollector = (origin:string,b:BrowserPool,e:EvidenceStore) => new FixtureCollector('meituan',origin,b,e,MT);
export const taobaoCollector = (origin:string,b:BrowserPool,e:EvidenceStore) => new FixtureCollector('taobao_instant',origin,b,e,TB);
