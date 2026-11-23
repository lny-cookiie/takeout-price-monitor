// 数据台账：合并自动采集与截图识别记录，支持筛选、证据查看、CSV 下载和数据库状态。
const ledgerState = { rows: [], stats: {} };
const $l = (id) => document.getElementById(id);
const PLATFORM_LABEL = { jd: '京东', meituan: '美团', taobao_instant: '淘宝闪购' };
const SOURCE_LABEL = { auto: '自动采集', screenshot: '截图识别' };
const escL = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const moneyL = (fen) => (fen == null || fen === '' ? '—' : '¥' + (Number(fen) / 100).toFixed(2));

function ledgerFilters() {
  const form = $l('ledger-filter');
  const data = new FormData(form);
  const params = new URLSearchParams();
  for (const [key, value] of data.entries()) {
    const text = String(value).trim();
    if (text) params.set(key, text);
  }
  return params;
}

async function loadLedger() {
  const params = ledgerFilters();
  const query = params.toString();
  const csv = $l('ledger-csv');
  if (csv) csv.href = '/api/bd/ledger.csv' + (query ? '?' + query : '');
  $l('ledger-state').textContent = '加载中…';
  try {
    const res = await fetch('/api/bd/ledger' + (query ? '?' + query : ''), { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || '读取失败');
    ledgerState.rows = data.rows || [];
    ledgerState.stats = data.stats || {};
    renderLedgerStats();
    renderLedgerRows();
    $l('ledger-state').textContent = '已更新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch (error) {
    $l('ledger-state').textContent = '读取失败';
    $l('ledger-table').querySelector('tbody').innerHTML = `<tr><td colspan="10" class="muted">加载失败：${escL(error.message)}</td></tr>`;
  }
}

function renderLedgerStats() {
  const stats = ledgerState.stats;
  const box = $l('ledger-stats');
  if (!box) return;
  box.innerHTML = `
    <div class="stat-card"><span>总记录</span><strong>${stats.auto + stats.screenshot || 0}</strong></div>
    <div class="stat-card"><span>自动采集</span><strong>${stats.auto || 0}</strong></div>
    <div class="stat-card"><span>截图识别</span><strong>${stats.screenshot || 0}</strong></div>
    <div class="stat-card"><span>关键字段齐全</span><strong>${stats.complete || 0}</strong></div>
    <div class="stat-card"><span>有证据</span><strong>${stats.evidence || 0}</strong></div>`;
}

function renderLedgerRows() {
  const body = $l('ledger-table').querySelector('tbody');
  $l('ledger-count').textContent = ledgerState.rows.length + ' 条';
  if (!ledgerState.rows.length) { body.innerHTML = '<tr><td colspan="10" class="muted">当前筛选没有记录。</td></tr>'; return; }
  body.innerHTML = ledgerState.rows.map((row) => {
    const fees = [row.packagingFen == null ? null : '打包 ' + moneyL(row.packagingFen), row.deliveryFen == null ? null : '配送 ' + moneyL(row.deliveryFen)].filter(Boolean).join(' · ') || '—';
    const review = row.reviewStatus === 'confirmed' ? '已确认' : row.reviewStatus === 'edited' ? '已修改' : row.reviewStatus === 'rejected' ? '已拒绝' : '自动识别';
    const status = row.error ? '失败' : row.confidence === 'low' ? '待核对' : review;
    return `<tr>
      <td>${new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
      <td><span class="source-badge ${row.source}">${SOURCE_LABEL[row.source] || row.source}</span></td>
      <td>${PLATFORM_LABEL[row.platform] || escL(row.platform)}</td>
      <td>${escL(row.storeName || '—')}</td>
      <td>${escL(row.itemName || '—')}${row.spec ? '<small> · ' + escL(row.spec) + '</small>' : ''}</td>
      <td>${moneyL(row.payableFen)}</td>
      <td>${escL(fees)}</td>
      <td>${moneyL(row.discountFen)}</td>
      <td>${escL(status)}</td>
      <td>${row.evidenceId ? `<a href="/api/evidence/${escL(row.evidenceId)}.png" target="_blank" rel="noopener">截图</a>` : '—'}</td>
    </tr>`;
  }).join('');
}

async function loadDbStatus() {
  const box = $l('db-status');
  if (!box) return;
  try {
    const res = await fetch('/api/bd/db-status', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || '读取失败');
    const tables = Object.entries(data.tables || {}).map(([key, value]) => `<div><span>${escL(key)}</span><strong>${Number(value).toLocaleString('zh-CN')}</strong></div>`).join('');
    box.innerHTML = `<div class="db-status-grid">
      <div><span>数据库体积</span><strong>${(data.databaseBytes / 1024 / 1024).toFixed(1)} MB</strong></div>
      <div><span>证据文件</span><strong>${Number(data.evidence?.files || 0).toLocaleString('zh-CN')} 个 / ${(Number(data.evidence?.bytes || 0) / 1024 / 1024).toFixed(0)} MB</strong></div>
      <div><span>最近报价</span><strong>${data.latestQuote ? new Date(data.latestQuote).toLocaleString('zh-CN', { hour12: false }) : '—'}</strong></div>
      <div><span>已暂停资源</span><strong>${data.paused?.length ? escL(data.paused.map((p) => p.key + '（' + p.code + '）').join('；')) : '无'}</strong></div>
    </div>
    <div class="db-table-counts">${tables}</div>
    <details class="db-recent"><summary>最近运行（${data.latestRuns?.length || 0} 次）</summary><ul>${(data.latestRuns || []).map((r) => `<li>${escL(r.label)} · ${new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}</li>`).join('')}</ul></details>`;
  } catch (error) {
    box.innerHTML = '<p class="muted">数据库状态读取失败：' + escL(error.message) + '</p>';
  }
}

function initLedger() {
  if (!$l('ledger-table')) return;
  $l('ledger-refresh')?.addEventListener('click', () => { loadLedger(); loadDbStatus(); });
  $l('apply-ledger')?.addEventListener('click', () => loadLedger());
  $l('ledger-filter')?.addEventListener('submit', (event) => { event.preventDefault(); loadLedger(); });
  loadLedger();
  loadDbStatus();
}

initLedger();
document.addEventListener('bd:tab', (event) => { if (event.detail === 'ledger') { loadLedger(); loadDbStatus(); } });
