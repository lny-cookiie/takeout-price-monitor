// 截图识别入口：创建批次、上传三平台结算截图、查看识别结果并人工修正。
const SHOT_PLATFORMS = { jd: '京东', meituan: '美团', taobao_instant: '淘宝闪购' };
const shotState = { batchId: null, batch: null, records: [] };
const $s = (id) => document.getElementById(id);
const shotMoney = (fen) => (fen == null ? '—' : '¥' + (fen / 100).toFixed(2));
const shotEsc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shotToast(message) {
  const t = $s('bd-toast');
  if (!t) return;
  t.textContent = message;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.textContent = ''; }, 3600);
}

async function shotRequest(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'HTTP ' + res.status);
  return data;
}

function renderUploadGrid() {
  const grid = $s('shot-upload-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(SHOT_PLATFORMS).map(([platform, name]) => {
    const record = shotState.records.find((r) => r.platform === platform);
    return `<article class="upload-card" data-platform="${platform}">
      <div class="upload-head"><strong>${name}</strong><span class="upload-state ${record ? 'ok' : ''}">${record ? '已识别' : '待上传'}</span></div>
      ${record ? `<div class="upload-result"><div>${shotEsc(record.storeName || '门店未识别')}</div><div>${shotEsc(record.itemName || '商品未识别')} ${record.spec ? '· ' + shotEsc(record.spec) : ''}</div><div class="upload-amount">${shotMoney(record.payableFen)}</div><a href="/api/evidence/${record.evidenceId}.png" target="_blank" rel="noopener">查看脱敏截图</a></div>`
        : `<label class="upload-picker">选择结算页截图<input type="file" accept="image/png,image/jpeg" data-shot-upload="${platform}"></label>
           <p class="muted smalltext">上传后自动识别，可能需要十几秒。</p>`}
    </article>`;
  }).join('');
  for (const input of grid.querySelectorAll('[data-shot-upload]')) {
    input.addEventListener('change', () => uploadShot(input.dataset.shotUpload, input.files?.[0]));
  }
}

async function createShotBatch() {
  const form = $s('shot-batch-form');
  const data = new FormData(form);
  const payload = Object.fromEntries([...data.entries()].map(([k, v]) => [k, String(v).trim()]));
  try {
    const batch = await shotRequest('/api/bd/screenshot-batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    shotState.batchId = batch.batch.id;
    shotState.batch = batch.batch;
    shotState.records = batch.quotes || [];
    $s('shot-batch-state').textContent = '批次已创建：' + batch.batch.id.slice(0, 8);
    renderUploadGrid();
    renderShotResult();
    await loadShotBatches();
    shotToast('批次已创建，可以上传截图了');
  } catch (error) { shotToast('创建批次失败：' + error.message); }
}

async function uploadShot(platform, file) {
  if (!shotState.batchId) {
    // 能系统做的就不留给用户：第一次上传时自动用表单信息创建批次。
    await createShotBatch();
    if (!shotState.batchId) return;
  }
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { shotToast('图片超过 8MB，请先压缩'); return; }
  const card = document.querySelector(`.upload-card[data-platform="${platform}"]`);
  if (card) card.classList.add('busy');
  const state = card?.querySelector('.upload-state');
  if (state) state.textContent = '识别中…';
  try {
    const imageBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
    const batch = await shotRequest(`/api/bd/screenshot-batches/${shotState.batchId}/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, filename: file.name, imageBase64 }),
    });
    shotState.batch = batch.batch;
    shotState.records = batch.quotes || [];
    renderUploadGrid();
    renderShotResult();
    await loadShotBatches();
    $s('shot-result-body')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    shotToast(SHOT_PLATFORMS[platform] + ' 截图识别完成');
  } catch (error) {
    shotToast(SHOT_PLATFORMS[platform] + ' 识别失败：' + error.message);
    renderUploadGrid();
  } finally { card?.classList.remove('busy'); }
}

function amountField(label, key, value, record) {
  return `<label class="shot-field"><span>${label}</span><input data-quote="${record.id}" data-field="${key}" type="number" step="0.01" value="${value == null ? '' : (value / 100).toFixed(2)}"></label>`;
}

function renderShotResult() {
  const body = $s('shot-result-body');
  if (!body) return;
  const records = shotState.records;
  if (!records.length) { body.innerHTML = '<p class="muted">还没有识别结果。上传截图后这里会出现可修正的字段。</p>'; $s('shot-result-state').textContent = '等待上传'; return; }
  $s('shot-result-state').textContent = records.length === 3 ? '三平台齐全，可以对比' : `已识别 ${records.length}/3`;
  const prices = records.filter((r) => r.payableFen != null);
  const low = prices.length ? Math.min(...prices.map((r) => r.payableFen)) : null;
  const cards = records.map((record) => {
    const delta = record.payableFen != null && low != null ? record.payableFen - low : null;
    return `<article class="shot-card" data-quote-card="${record.id}">
      <div class="shot-card-head"><strong>${SHOT_PLATFORMS[record.platform]}</strong><span class="shot-tag ${record.confidence}">${record.confidence === 'high' ? '识别置信度高' : record.confidence === 'medium' ? '部分字段待确认' : '低置信度'}</span></div>
      <div class="shot-amount">${shotMoney(record.payableFen)}<small>${delta == null ? '应付金额' : delta === 0 ? '本组最低' : '比最低高 ¥' + (delta / 100).toFixed(2)}</small></div>
      <div class="shot-edit-grid">
        <label class="shot-field"><span>门店</span><input data-quote="${record.id}" data-field="storeName" value="${shotEsc(record.storeName || '')}"></label>
        <label class="shot-field"><span>商品</span><input data-quote="${record.id}" data-field="itemName" value="${shotEsc(record.itemName || '')}"></label>
        <label class="shot-field"><span>规格</span><input data-quote="${record.id}" data-field="spec" value="${shotEsc(record.spec || '')}"></label>
        <label class="shot-field"><span>数量</span><input data-quote="${record.id}" data-field="quantity" type="number" min="1" value="${record.quantity ?? ''}"></label>
        ${amountField('应付', 'payable', record.payableFen, record)}
        ${amountField('商品小计', 'subtotal', record.subtotalFen, record)}
        ${amountField('打包费', 'packaging', record.packagingFen, record)}
        ${amountField('配送费', 'delivery', record.deliveryFen, record)}
        ${amountField('优惠', 'discount', record.discountFen, record)}
      </div>
      ${record.issues?.length ? `<p class="shot-issues">待确认：${record.issues.map(shotEsc).join('；')}</p>` : ''}
      <div class="shot-card-actions"><button type="button" class="small" data-save-quote="${record.id}">保存修正并确认</button>
        <a class="small" href="/api/evidence/${record.evidenceId}.png" target="_blank" rel="noopener">查看截图</a>
        <button type="button" class="small danger" data-delete-quote="${record.id}">删除</button></div>
    </article>`;
  }).join('');
  const compare = records.length === 3 ? `<div class="shot-compare">三平台应付：${records.map((r) => SHOT_PLATFORMS[r.platform] + ' ' + shotMoney(r.payableFen)).join('，')}。差额仅代表该截图样本，不代表平台补贴差异。</div>` : '';
  body.innerHTML = compare + `<div class="shot-grid">${cards}</div>`;
  for (const button of body.querySelectorAll('[data-save-quote]')) button.addEventListener('click', () => saveQuote(button.dataset.saveQuote));
  for (const button of body.querySelectorAll('[data-delete-quote]')) button.addEventListener('click', () => deleteQuote(button.dataset.deleteQuote));
}

async function saveQuote(id) {
  const card = document.querySelector(`[data-quote-card="${id}"]`);
  if (!card) return;
  const payload = {};
  for (const input of card.querySelectorAll('[data-quote]')) {
    const key = input.dataset.field;
    const value = input.value.trim();
    if (key === 'storeName' || key === 'itemName' || key === 'spec') payload[key] = value;
    else if (value !== '') payload[key] = Number(value);
  }
  payload.reviewStatus = 'confirmed';
  try {
    const batch = await shotRequest(`/api/bd/screenshot-quotes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    shotState.records = batch.quotes || [];
    renderShotResult();
    await loadShotBatches();
    shotToast('已保存并确认');
  } catch (error) { shotToast('保存失败：' + error.message); }
}

async function deleteQuote(id) {
  if (!window.confirm('删除这条识别记录？脱敏截图会保留在证据库。')) return;
  try {
    const batch = await shotRequest(`/api/bd/screenshot-quotes/${id}`, { method: 'DELETE' });
    shotState.batch = batch.batch;
    shotState.records = batch.quotes || [];
    renderUploadGrid();
    renderShotResult();
    await loadShotBatches();
  } catch (error) { shotToast('删除失败：' + error.message); }
}

async function loadShotBatches() {
  const box = $s('shot-batch-list');
  if (!box) return;
  try {
    const data = await shotRequest('/api/bd/screenshot-batches?limit=12');
    if (!data.batches?.length) { box.innerHTML = '<p class="muted">还没有批次。</p>'; return; }
    box.innerHTML = `<div class="batch-list">${data.batches.map((b) => `<button type="button" class="batch-row" data-open-batch="${b.id}"><span>${shotEsc(b.brand || '未填品牌')} · ${shotEsc(b.item || '未填商品')}</span><span>${b.count}/3 平台</span><small>${new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></button>`).join('')}</div>`;
    for (const button of box.querySelectorAll('[data-open-batch]')) button.addEventListener('click', () => openBatch(button.dataset.openBatch));
  } catch { box.innerHTML = '<p class="muted">批次列表读取失败。</p>'; }
}

async function openBatch(id) {
  try {
    const batch = await shotRequest('/api/bd/screenshot-batches/' + id);
    shotState.batchId = batch.batch.id;
    shotState.batch = batch.batch;
    shotState.records = batch.quotes || [];
    for (const [key, value] of Object.entries(batch.batch)) {
      const input = document.querySelector(`#shot-batch-form [name="${key}"]`);
      if (input) input.value = value;
    }
    $s('shot-batch-state').textContent = '正在查看批次：' + batch.batch.id.slice(0, 8);
    renderUploadGrid();
    renderShotResult();
  } catch (error) { shotToast('打开批次失败：' + error.message); }
}

function initScreenshots() {
  if (!$s('shot-upload-grid')) return;
  renderUploadGrid();
  loadShotBatches();
  $s('create-shot-batch')?.addEventListener('click', createShotBatch);
  $s('refresh-shot-result')?.addEventListener('click', async () => {
    if (!shotState.batchId) return;
    try {
      const batch = await shotRequest('/api/bd/screenshot-batches/' + shotState.batchId);
      shotState.batch = batch.batch;
      shotState.records = batch.quotes || [];
      renderUploadGrid();
      renderShotResult();
    } catch (error) { shotToast('刷新失败：' + error.message); }
  });
}

initScreenshots();
document.addEventListener('bd:tab', (event) => { if (event.detail === 'screenshots') loadShotBatches(); });

export { shotState };
