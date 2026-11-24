// 首次设置页：检查环境、发现手机、导入清单并记录选择。不保存平台密码。
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let lastStatus = null;

function toast(message) {
  const box = $('setup-toast');
  box.textContent = message;
  clearTimeout(box._timer);
  box._timer = setTimeout(() => { box.textContent = ''; }, 3600);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || '请求失败');
  return data;
}

function statusCard(kind, title, detail) {
  return `<div class="status-card ${kind}"><strong>${esc(title)}</strong><span>${detail}</span></div>`;
}

function renderStatus(data) {
  lastStatus = data;
  const model = data.model || {};
  const adb = data.adb || {};
  const platforms = data.platforms || [];
  const modelCard = model.configured
    ? statusCard('ok', '本地模型已配置', `模型名称：${esc(model.model || '未知')}；启动器会自动启动模型服务。`)
    : statusCard('bad', '本地模型未配置', '请确认安装包里的模型目录完整，或者联系管理员。');
  const adbCard = !adb.adb
    ? statusCard('warn', '未找到 ADB', '只使用截图识别可以继续；自动采集需要安装包里的 ADB。')
    : adb.connected
      ? statusCard('ok', '手机已连接', `发现 ${adb.connected} 台已授权设备。`)
      : statusCard('warn', '手机尚未连接', '需要自动采集时再连接；截图识别不需要手机。');
  const configCards = platforms.map((p) => statusCard(p.configured ? 'ok' : 'warn', p.name,
    p.configured ? `已配置；登记版本 ${esc(p.expectedVersion || '未登记')}` : '未配置自动采集，仍可使用截图识别。')).join('');
  $('status-cards').innerHTML = modelCard + adbCard + configCards;
  $('status-tip').textContent = data.completed
    ? `这台电脑已经完成过设置，保存于 ${data.setup?.at ? new Date(data.setup.at).toLocaleString('zh-CN', { hour12: false }) : '未知时间'}。可以重新检查或直接进入工具。`
    : '环境检查不会修改手机和平台账号。确认无误后继续选择使用方式。';
  if (data.completed) {
    $('finish-state').textContent = '这台电脑已经完成过设置';
    document.querySelectorAll('.setup-progress span').forEach((el) => el.classList.add('on'));
  }
}

async function loadStatus() {
  try { renderStatus(await api('/api/setup/status')); }
  catch (error) { $('status-cards').innerHTML = `<p class="muted">检查失败：${esc(error.message)}</p>`; }
}

async function checkPhone() {
  $('phone-box').innerHTML = '<p class="muted">正在读取手机和 App 版本…</p>';
  try {
    const data = await api('/api/setup/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!data.devices?.length) {
      $('phone-box').innerHTML = '<p class="muted">没有发现手机。请用 USB 线连接手机，打开开发者选项里的 USB 调试，并在手机上点允许。</p>';
      return;
    }
    $('phone-box').innerHTML = `<p class="muted smalltext">选中要使用的手机；只显示当前连接状态，不会代替你登录平台。</p>
      <div class="status-grid">${data.devices.map((d) => `<div class="status-card ${d.state === 'device' ? 'ok' : 'warn'}"><strong>${esc(d.serial)}</strong><span>状态：${esc(d.state)}</span></div>`).join('')}
      ${(data.platforms || []).map((p) => `<div class="status-card ${!p.configured ? 'warn' : p.versionMatch ? 'ok' : 'bad'}"><strong>${esc(p.name)}</strong><span>${!p.configured ? '未配置自动采集' : `登记版本 ${esc(p.expectedVersion)}；手机版本 ${esc(p.actualVersion || '未读到')}；${p.versionMatch ? '版本一致' : '版本不一致，自动采集暂不可用'}`}</span></div>`).join('')}</div>`;
  } catch (error) { $('phone-box').innerHTML = `<p class="muted">检查手机失败：${esc(error.message)}</p>`; }
}

async function importCatalog(file) {
  if (!file) return;
  $('catalog-state').textContent = '正在校验…';
  try {
    const csv = await file.text();
    await api('/api/market/catalog/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'preview', source: 'trial', csv }) });
    const result = await api('/api/market/catalog/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'commit', source: 'trial', csv }) });
    const count = result.imported ?? result.count ?? result.entries?.length ?? '若干';
    $('catalog-state').textContent = `已导入 ${count} 条商品`;
    await loadStatus();
  } catch (error) { $('catalog-state').textContent = '导入失败：' + error.message; }
}

async function finish() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'screenshot';
  const address = $('setup-address').value.trim();
  $('finish-setup').disabled = true;
  $('finish-state').textContent = '正在保存…';
  try {
    await api('/api/setup/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, address }) });
    $('finish-state').textContent = '设置完成，正在进入工具…';
    location.href = '/bd';
  } catch (error) {
    $('finish-state').textContent = '';
    $('finish-setup').disabled = false;
    toast('保存失败：' + error.message);
  }
}

$('refresh-status').addEventListener('click', loadStatus);
$('check-phone').addEventListener('click', checkPhone);
$('catalog-file').addEventListener('change', (event) => importCatalog(event.target.files?.[0]));
$('finish-setup').addEventListener('click', finish);
loadStatus();
