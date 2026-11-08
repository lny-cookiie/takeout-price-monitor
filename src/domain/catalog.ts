import { CONTRACT_VERSION, TENANT, type Store, type Task, type Platform, type Scenario, type Fault } from './contracts.js';
// Fictional stores, addresses, products and prices. Never import into a real dataset.
export const STORES: Store[] = [
  { id: 'rice', name: '禾小碗·现炒饭', address: '模拟商圈 A 座 101', category: '中式简餐', products: [
    { id: 'rice-main', name: '招牌鸡腿饭', variants: [{ name: '标准份 · 微辣', price_fen: 2200 }, { name: '大份 · 微辣', price_fen: 2600 }] },
    { id: 'rice-tea', name: '无糖乌龙茶', variants: [{ name: '500ml · 常温', price_fen: 600 }] }
  ], baskets: [
    { id: 'rice-single', name: '鸡腿饭单人餐', items: [{ product_id: 'rice-main', name: '招牌鸡腿饭', variant: '标准份 · 微辣', quantity: 1 }] },
    { id: 'rice-set', name: '大份饭＋乌龙茶', items: [{ product_id: 'rice-main', name: '招牌鸡腿饭', variant: '大份 · 微辣', quantity: 1 }, { product_id: 'rice-tea', name: '无糖乌龙茶', variant: '500ml · 常温', quantity: 1 }] }
  ] },
  { id: 'coffee', name: '青屿咖啡', address: '模拟商圈 B 座 102', category: '咖啡饮品', products: [
    { id: 'coffee-latte', name: '燕麦拿铁', variants: [{ name: '大杯 500ml · 热 · 无糖', price_fen: 2400 }, { name: '中杯 350ml · 冰 · 无糖', price_fen: 2100 }] }
  ], baskets: [
    { id: 'coffee-single', name: '大杯热拿铁', items: [{ product_id: 'coffee-latte', name: '燕麦拿铁', variant: '大杯 500ml · 热 · 无糖', quantity: 1 }] },
    { id: 'coffee-pair', name: '中杯冰拿铁×2', items: [{ product_id: 'coffee-latte', name: '燕麦拿铁', variant: '中杯 350ml · 冰 · 无糖', quantity: 2 }] }
  ] },
  { id: 'noodle', name: '巷口小面', address: '模拟商圈 C 座 103', category: '面食', products: [
    { id: 'noodle-main', name: '红烧牛肉面', variants: [{ name: '标准份 · 细面 · 微辣', price_fen: 2800 }, { name: '大份 · 宽面 · 不辣', price_fen: 3200 }] },
    { id: 'noodle-egg', name: '卤蛋', variants: [{ name: '1枚', price_fen: 300 }] }
  ], baskets: [
    { id: 'noodle-single', name: '牛肉面单人餐', items: [{ product_id: 'noodle-main', name: '红烧牛肉面', variant: '标准份 · 细面 · 微辣', quantity: 1 }] },
    { id: 'noodle-set', name: '大份牛肉面＋卤蛋', items: [{ product_id: 'noodle-main', name: '红烧牛肉面', variant: '大份 · 宽面 · 不辣', quantity: 1 }, { product_id: 'noodle-egg', name: '卤蛋', variant: '1枚', quantity: 1 }] }
  ] }
];
export function getBasket(task: Pick<Task, 'store_id' | 'basket_id'>) {
  const store = STORES.find(s => s.id === task.store_id);
  const basket = store?.baskets.find(b => b.id === task.basket_id);
  if (!store || !basket) throw new Error('unknown_store_or_basket');
  return { store, basket };
}
export function fixtureQuote(platform: Platform, store: Store, items: { product_id: string; variant: string; quantity: number }[], fault: Fault) {
  const subtotal = items.reduce((sum, i) => {
    const v = store.products.find(p => p.id === i.product_id)?.variants.find(v => v.name === i.variant);
    if (!v) throw new Error('invalid_fixture_variant');
    return sum + v.price_fen * i.quantity;
  }, 0);
  const delivery = platform === 'meituan' ? 300 : 200;
  const packaging = 100 * items.reduce((n, i) => n + i.quantity, 0);
  const discount = platform === 'meituan' ? 400 : 500;
  return { subtotal, delivery, packaging, discount, total: fault === 'zero_quote' ? 0 : subtotal + delivery + packaging - discount + (fault === 'price_change' ? 200 : 0) };
}
export function faultFor(scenario: Scenario, platform: Platform, store: string): Fault {
  if (scenario === 'mixed') return (platform === 'meituan' ? { rice: 'none', coffee: 'missing_fee', noodle: 'sold_out' } : { rice: 'minimum_not_met', coffee: 'schema_changed', noodle: 'captcha' })[store] as Fault;
  return ({ baseline: 'none', price_change: 'price_change', network_retry: 'network_once', cart_conflict: 'cart_not_owned', zero_quote: 'zero_quote' } as const)[scenario];
}
export function makeTask(runId: string, platform: Platform, store: Store, basketId: string, scenario: Scenario, due: Date, groupId: string): Task {
  return {
    contract_version: CONTRACT_VERSION, source_id: 'LOCAL_FIXTURE', tenant_id: TENANT, slot_id: `${groupId}_${platform}`, run_id: runId, comparison_group_id: groupId,
    platform, store_id: store.id, basket_id: basketId, scenario_id: 'fixture_point_1_default_wallet_v1', entry_point: `local_fixture_${platform}_v1`,
    account_ref: `fixture_${platform}_wallet_1`, device_ref: `fixture_${platform}_browser_1`, delivery_point_id: 'fixture_point_1',
    due_at: due.toISOString(), deadline_at: new Date(due.getTime() + 300_000).toISOString(), data_mode: 'synthetic',
    fault: faultFor(scenario, platform, store.id), max_attempts: 2, timeout_seconds: 45,
    requested_fields: ['checkout_payable','delivery_fee','packaging_fee'], required_fields: ['checkout_payable'],
    allowed_actions: ['browse','select_variant','modify_owned_test_cart','read_checkout']
  };
}
