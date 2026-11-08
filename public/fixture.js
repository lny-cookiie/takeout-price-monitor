/* This is an owned, deliberately synthetic storefront. It is not a replica of a live platform. */
(() => {
  const config = window.__FIXTURE__;
  const mt = config.platform === 'meituan';
  const root = document.getElementById('app');
  const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => '¥' + (n / 100).toFixed(2);
  let cart = [], currentStore = null;
  function home() {
    root.innerHTML = `<section data-page="home"><h1>${mt ? '附近好店' : '即时好食'}</h1><div class="row"><input aria-label="${mt ? '搜索商家' : '搜索门店和商品'}" placeholder="输入完整门店名"><button id="search">${mt ? '搜索' : '找店'}</button></div><div id="stores"></div></section>`;
    document.getElementById('search').onclick = () => {
      const query = root.querySelector('input').value;
      const stores = config.stores.filter(s => s.name.includes(query));
      document.getElementById('stores').innerHTML = stores.map(s => `<article data-store-id="${s.id}"><h2>${esc(s.name)}</h2><p>${esc(s.address)}</p><p class="muted">${esc(s.category)} · 到店配送均为模拟</p><button>${mt ? '进入门店' : '逛这家店'}</button></article>`).join('') + `<article data-store-id="decoy"><h2>${esc(query)}（另一分店）</h2><p>模拟商圈 D 座 999</p><button>另一家分店</button></article>`;
      for (const article of root.querySelectorAll('[data-store-id]')) article.querySelector('button').onclick = () => {
        currentStore = config.stores.find(s => s.id === article.dataset.storeId);
        if (!currentStore) { root.innerHTML = '<h1>另一家分店</h1>'; return; }
        menu();
      };
    };
  }
  function menu() {
    if (config.fault === 'captcha') { root.innerHTML = '<section data-page="blocked"><h1>需要安全验证</h1><p data-testid="access-block">captcha_required</p><p>模拟访问受限，不提供自动解锁入口。</p></section>'; return; }
    if (config.fault === 'schema_changed') { root.innerHTML = '<section data-page="unknown"><h1>页面结构已变更</h1><p>旧流程需要重新核验，不自动猜按钮。</p></section>'; return; }
    const unavailable = config.fault === 'sold_out';
    root.innerHTML = `<section data-page="menu"><h1 data-testid="store-name">${esc(currentStore.name)}</h1><p data-testid="store-address">${esc(currentStore.address)}</p>${unavailable ? '<p class="notice" data-testid="business-status">sold_out</p>' : ''}<div id="products">${currentStore.products.map(p => `<article data-product-id="${p.id}"><div class="row"><div><h2>${esc(p.name)}</h2><p class="muted">规格不同，价格不同</p><span data-testid="display-price">${money(Math.min(...p.variants.map(v => v.price_fen)))} 起</span></div><button ${unavailable ? 'disabled' : ''}>${mt ? '选规格' : '选择口味'}</button></div></article>`).join('')}</div><section class="cart" data-testid="cart" data-owner="${config.fault === 'cart_not_owned' ? 'someone_else' : esc(config.session)}"><strong>本次测试购物篮</strong><div id="cart-items"></div><button id="checkout">${mt ? '去结算' : '确认购物袋'}</button></section></section>`;
    if (config.fault === 'cart_not_owned') document.getElementById('cart-items').innerHTML = '<p>已有其他使用者的购物车，禁止覆盖</p>';
    for (const a of root.querySelectorAll('[data-product-id]')) a.querySelector('button').onclick = () => variantDialog(currentStore.products.find(p => p.id === a.dataset.productId));
    document.getElementById('checkout').onclick = checkout;
    renderCart();
  }
  function variantDialog(product) {
    const d = document.createElement('dialog');
    d.innerHTML = `<h2>${esc(product.name)}</h2>${mt ? `<select aria-label="规格">${product.variants.map(v => `<option>${esc(v.name)}</option>`).join('')}</select>` : `<fieldset><legend>请选择规格</legend>${product.variants.map((v,i) => `<label><input type="radio" name="variant" value="${esc(v.name)}" ${i === 0 ? 'checked' : ''}>${esc(v.name)}</label>`).join('')}</fieldset>`}<p><label>数量 <input aria-label="数量" type="number" min="1" max="9" value="1"></label></p><button id="confirm-variant">${mt ? '加入购物车' : '加入购物袋'}</button>`;
    root.appendChild(d); d.showModal();
    d.querySelector('#confirm-variant').onclick = () => {
      const variant = mt ? d.querySelector('select').value : d.querySelector('input[name="variant"]:checked').value;
      const quantity = Number(d.querySelector('[aria-label="数量"]').value);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9) return;
      cart.push({product_id:product.id,name:product.name,variant,quantity});
      d.close(); d.remove(); renderCart();
    };
  }
  function renderCart() {
    const el = document.getElementById('cart-items');
    if (el && config.fault !== 'cart_not_owned') el.innerHTML = cart.map(i => `<p data-cart-product="${i.product_id}"><span data-field="name">${esc(i.name)}</span> / <span data-field="variant">${esc(i.variant)}</span> × <span data-field="quantity">${i.quantity}</span></p>`).join('');
  }
  async function checkout() {
    if (!cart.length) return;
    if (config.fault === 'minimum_not_met') { root.innerHTML = '<section data-page="checkout"><h1>结算</h1><p data-testid="business-status">minimum_not_met</p><p class="notice">未达起送门槛，还差 10 元。本任务不能自动凑单。</p></section>'; return; }
    root.innerHTML = '<section data-page="loading"><h1>正在计算报价…</h1></section>';
    const response = await fetch('/fixtures/quote', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:config.platform,store_id:currentStore.id,items:cart,fault:config.fault})});
    const q = await response.json();
    await new Promise(r => setTimeout(r,180));
    root.innerHTML = `<section data-page="checkout" data-quote-ready="true"><h1>${mt ? '确认订单' : '核对配送与商品'}</h1><h2 data-testid="store-name">${esc(currentStore.name)}</h2><p data-testid="store-address">${esc(currentStore.address)}</p><div class="card" id="cart-items"></div><div class="card"><dl><dt>商品小计</dt><dd>${money(q.subtotal)}</dd><dt>包装费（另计）</dt><dd data-testid="${mt ? 'mt-packaging' : 'tb-box-fee'}">${money(q.packaging)}</dd>${config.fault === 'missing_fee' ? '<dt>配送费明细暂未展示</dt><dd>未知</dd>' : `<dt>配送费（另计）</dt><dd data-testid="${mt ? 'mt-delivery' : 'tb-shipping-fee'}">${money(q.delivery)}</dd>`}<dt>自动使用已有优惠</dt><dd>-${money(q.discount)}</dd></dl><hr><div class="row"><strong>${mt ? '应付' : '实付款'}</strong><span class="price" data-testid="${mt ? 'mt-payable' : 'tb-payment-total'}">${money(q.total)}</span></div></div><p class="muted">本页价格包含可见费用，不代表已支付。</p><button disabled data-testid="place-order">模拟提交订单（禁止操作）</button></section>`;
    renderCart();
    window.__fixtureState = { cart, session: config.session, stage: 'checkout' };
  }
  window.__restoreOwnedCart = session => {
    if (session !== config.session || config.fault === 'cart_not_owned') return false;
    cart = []; window.__fixtureState = {cart,session,stage:'restored'}; return true;
  };
  home();
})();
