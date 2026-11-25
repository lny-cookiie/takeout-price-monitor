// 管理员审核：输入本机审核码，查看 BD 提交的配置并批准或驳回。
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let pending = null;

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
function pin() { return $('admin-pin').value.trim(); }

async function load() {
  $('admin-state').textContent = '读取中…';
  try {
    const data = await api('/api/admin/pending?pin=' + encodeURIComponent(pin()));
    pending = data.submission;
    if (!pending || pending.status !== 'pending') {
      $('pending-box').innerHTML = '<p class="muted">当前没有待审核的配置。</p>';
      $('admin-state').textContent = '没有待审核项';
      return;
    }
    $('pending-box').innerHTML = `<div class="status-grid">
      <div class="status-card"><strong>手机序列号</strong><span>${esc(pending.serial)}</span></div>
      <div class="status-card"><strong>城市</strong><span>${esc(pending.city)}</span></div>
      <div class="status-card"><strong>配送地址</strong><span>${esc(pending.address)}</span></div>
    </div><div class="bd-actions" style="margin-top:14px"><button type="button" class="primary" id="approve">审核通过</button><button type="button" class="secondary" id="reject">驳回</button></div>`;
    $('admin-state').textContent = '等待管理员决定';
    $('approve').addEventListener('click', () => decide('approve'));
    $('reject').addEventListener('click', () => decide('reject'));
  } catch (error) { $('admin-state').textContent = '读取失败：' + error.message; }
}

async function decide(action) {
  if (!window.confirm(action === 'approve' ? '确认这份配置已核对，允许该 BD 使用自动采集？' : '确认驳回这份配置？')) return;
  try {
    const data = await api('/api/admin/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: pin() }) });
    toast(action === 'approve' ? '审核通过，请用托盘菜单重启服务' : '已驳回');
    $('admin-state').textContent = data.message || data.status || '已处理';
    await load();
  } catch (error) { toast('操作失败：' + error.message); }
}

$('load-pending').addEventListener('click', load);
