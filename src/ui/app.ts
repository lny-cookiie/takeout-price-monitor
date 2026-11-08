import type { Candidate, Eligibility, OrderImport, Plan, Profile } from '../domain/competition.js';
import type { Platform } from '../domain/contracts.js';
import { type Batch, type Page, type Records, type Workspace, button, comparison, h, idAttr, label, pages, quoteDetails, reason } from './presentation.js';
import { jdCsvTemplate, parseOrderCsv } from './jd-import.js';
import { type CollectionRun, renderRun } from './jd-runs.js';
import { candidateForm, dataRecords, mappingReview, settings, type ImportFile } from './settings.js';

const app=document.querySelector<HTMLDivElement>('#app')!;
const dialog=document.querySelector<HTMLDialogElement>('#detail-dialog')!;
const toast=document.querySelector<HTMLDivElement>('#toast')!;
let ws:Workspace, batch:Batch|undefined, records:Records|undefined;
let page:Page='compare', section='targets', mode:'live'|'synthetic'='live', menu=false, advanced=false, requestId=0;
let plan:Plan|undefined, profile:Profile|undefined, deviceReport='',modelReport='',testing=false;
let imported:ImportFile|null=null, selectedCandidate:Candidate|null=null;
let recordRunId='', recordsSelection='', runReport:CollectionRun|undefined, runError='', recordsRequest=0;
let runRequest:{id:string; recordsRequest:number}|undefined;
let jdSubmitting=false, pendingJdRequest:{fields:string;id:string}|undefined;
let selectedJdStore='';
let toastTimer:ReturnType<typeof setTimeout>;
const filters=new URLSearchParams();
function notify(text:string) { const error=dialog.open && dialog.querySelector<HTMLElement>('[data-dialog-error]'); if (error) {error.textContent=text;return;} toast.textContent=text;clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.textContent='',5500); }
function clearFilters() { for (const k of [...filters.keys()]) filters.delete(k); }
function query() { const q=new URLSearchParams(filters);q.set('mode',mode);return q; }
async function api<T>(url:string,method='GET',body?:unknown):Promise<T> {
  const response=await fetch(url,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok) {
    const b=await response.json().catch(()=>({}));
    throw new Error(reason(b.error ?? '请求失败，请稍后重试。'));
  }
  return response.json() as Promise<T>;
}
async function workspace() { ws=await api('/api/workspace'); }
async function refreshComparison() {
  const id=++requestId;
  try {
    const data=await api<Batch>('/api/comparisons?'+query());
    if(id===requestId) { batch=data;if(page==='compare')render(); }
  } catch(e) { notify((e as Error).message); }
}
async function refreshRecords() {
  const request=++recordsRequest;
  const selection=recordRunId;
  const search=selection ? '?'+new URLSearchParams({runId:selection}) : '';
  try {
    const result=await api<Records>('/api/market/records'+search);
    if(request!==recordsRequest)return;
    records=result;recordsSelection=selection;
    if(page!=='records')return;
    render();
    if(section==='collection')await refreshRun();
  } catch(e) {
    if(request===recordsRequest && page==='records')notify((e as Error).message);
  }
}
function expectedRunId() { return recordRunId || (recordsSelection===recordRunId ? records?.run?.id ?? '' : ''); }
function runDetailMarkup() {
  const expected=expectedRunId();
  const issue=runError ? `<p class="notice" role="status">暂时无法读取最新进度。 ${h(runError)}</p>` : '';
  if(runReport && runReport.run.id===expected)return issue+renderRun(ws,runReport);
  if(issue)return issue;
  return expected || recordsSelection!==recordRunId ? '<section class="panel"><div class="panel-body"><p class="muted" role="status">正在读取采集进度…</p></div></section>' : '';
}
function updateRunDetail() {
  const region=app.querySelector<HTMLElement>('[data-run-detail]');
  if(!region)return;
  const opened=new Set(Array.from(region.querySelectorAll<HTMLDetailsElement>('details[open]'),el=>el.dataset.detailKey));
  const focused=region.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLDetailsElement>('details')?.dataset.detailKey : undefined;
  region.innerHTML=runDetailMarkup();
  for(const details of region.querySelectorAll<HTMLDetailsElement>('details[data-detail-key]')) {
    if(opened.has(details.dataset.detailKey))details.open=true;
    if(focused && details.dataset.detailKey===focused)details.querySelector('summary')?.focus({preventScroll:true});
  }
}
async function refreshRun() {
  const id=expectedRunId();
  if(!id || page!=='records' || section!=='collection' || (runRequest?.id===id && runRequest.recordsRequest===recordsRequest))return;
  const request={id,recordsRequest};
  runRequest=request;
  const current=()=>runRequest===request && request.recordsRequest===recordsRequest && expectedRunId()===id && page==='records' && section==='collection';
  try {
    const result=await api<CollectionRun>('/api/market/runs/'+encodeURIComponent(id));
    if(!current())return;
    const changed=runError || JSON.stringify(runReport)!==JSON.stringify(result);
    runReport=result;
    runError='';
    if(changed)updateRunDetail();
  } catch(e) {
    if(!current())return;
    const message=(e as Error).message;
    if(runError!==message) {
      runError=message;
      updateRunDetail();
    }
  } finally {
    if(runRequest===request)runRequest=undefined;
  }
}
function navigate(next:Page,tab?:string) {
  page=next;section=tab ?? (next==='settings'?'targets':'collection');render();
  if(next==='compare') void refreshComparison();
  if(next==='records') void refreshRecords();
}
function render() {
  if(!ws)return;
  app.innerHTML=`<header class="header"><div class="header-inner"><span class="brand">外卖竞争监测</span><nav aria-label="主要导航">
    ${Object.entries(pages).map(([id,t])=>`<button data-action="nav" ${idAttr(id)} ${id===page?'aria-current="page"':''}>${t}</button>`).join('')}${ws.ueWorkspacePath?`<a href="${h(ws.ueWorkspacePath)}" style="align-self:center;padding:8px 16px">包销 UE 工作台</a>`:''}</nav></div></header>
    <main class="content">${page==='compare'?comparison(ws,batch,mode,query(),menu,advanced):page==='settings'?settings(ws,section,profile,plan,jdSubmitting,selectedJdStore):dataRecords(ws,section,records,imported,modelReport,deviceReport,recordRunId,runDetailMarkup(),recordsSelection===recordRunId && !runReport?.slots.some(slot=>slot.kind==='shelf'))}</main>`;
}
function showDialog(title:string,body:string) {
  dialog.innerHTML=`<div class="dialog-head"><h2 id="dialog-title">${h(title)}</h2>${button('close-dialog','关闭')}</div><div class="dialog-body"><p data-dialog-error class="problem" role="alert"></p>${body}</div>`;
  if(!dialog.open)dialog.showModal();
}
function download(name:string,value:string,type:string) {
  const url=URL.createObjectURL(new Blob([value],{type}));
  const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
}
const orderTemplate: {records:OrderImport[]}={records:[{
  key:'示例-订单行-1',supply:{store:{key:'示例门店ID',brand:'示例品牌',name:'示例门店',city:'示例城市',address:'示例营业地址'},
    item:{key:'示例SKU',name:'示例商品',kind:'single',spec:'500ml',options:[],parts:null}},
  paidAt:null,actualPaidFen:null,reference:'请替换为实际导出记录编号'
}]};
async function act(el:HTMLButtonElement) {
  const id=el.dataset.id ?? '', action=el.dataset.action;
  switch(action) {
    case 'nav': navigate(id as Page);return;
    case 'jd-nav': navigate('settings','jd');return;
    case 'profile-nav': navigate('settings','profiles');return;
    case 'connection-nav': navigate('records','connection');return;
    case 'collection-nav': navigate('records','collection');return;
    case 'import-nav': navigate('records','orders');return;
    case 'section': section=id;render();if(page==='records' && section==='collection')await refreshRecords();return;
    case 'mode': mode=id as typeof mode;clearFilters();batch=undefined;render();await refreshComparison();return;
    case 'open-demo': mode='synthetic';menu=false;clearFilters();batch=undefined;navigate('compare');return;
    case 'advanced-filters': advanced=!advanced;render();return;
    case 'clear-filter': clearFilters();await refreshComparison();return;
    case 'quote': {
      const row=batch?.rows[Number(el.dataset.index)],p=el.dataset.platform as Platform;
      if(row)showDialog(label(ws,p)+' · '+row.item,quoteDetails(row,p));
      return;
    }
    case 'close-dialog': dialog.close();return;
    case 'candidate': {
      const t=ws.targets.find(t=>t.id===id);
      selectedCandidate=null;
      if(t)showDialog('识别平台候选',candidateForm(ws,t));
      return;
    }
    case 'read-candidate': {
      const form=dialog.querySelector<HTMLFormElement>('form[data-form=candidate]');
      if(!form)return;
      const platform=new FormData(form).get('platform');
      const c=await api<Candidate>('/api/candidates/device','POST',{platform});
      selectedCandidate=c;
      const {store,item}=c.supply;
      const values:Record<string,string>={entry:c.entry,reference:c.reference,brand:store.brand,city:store.city,store:store.name,address:store.address,
        item:item.name,spec:item.spec,kind:item.kind,options:item.options?.join('、') ?? '',
        parts:item.parts?.map(p=>p.name+' | '+p.spec+' | '+p.quantity).join('\n') ?? ''};
      for(const [key,value] of Object.entries(values)) {
        const control=form.elements.namedItem(key) as HTMLInputElement|null;
        if(control)control.value=value;
      }
      const checked=form.elements.namedItem('optionsKnown') as HTMLInputElement|null;
      if (checked) checked.checked=item.options!==null;
      const notice=form.querySelector('output');
      if(notice)notice.textContent='已读取手机页面，请核对识别出的内容及证据。';
      return;
    }
    case 'mapping': showDialog('确认同店同品',mappingReview(ws,id));return;
    case 'reject': await api('/api/mappings/'+id+'/decision','PUT',{verified:false});await workspace();render();return;
    case 'edit-profile': case 'new-profile': profile=ws.profiles.find(p=>p.id===id);render();return;
    case 'edit-plan': case 'new-plan': plan=ws.plans.find(p=>p.id===id);render();return;
    case 'order-template': download('京东订单导入模板.csv',jdCsvTemplate(),'text/csv;charset=utf-8');return;
    case 'order-template-json': download('京东订单导入模板.json',JSON.stringify(orderTemplate,null,2),'application/json;charset=utf-8');return;
    case 'confirm-import': {
      if(!imported)return;
      if(imported.payload.records.some(r=>r.key?.startsWith('示例-')))throw new Error('请先用实际资料替换模板示例。');
      const r=await api<{imported:number;duplicates:number}>('/api/imports/jd-orders','POST',imported.payload);
      imported=null;await workspace();await refreshRecords();notify('已导入 '+r.imported+' 条，重复记录 '+r.duplicates+' 条。');return;
    }
    case 'fixture-run': {
      const {run_id}=await api<{run_id:string}>('/api/runs','POST',{scenario:'baseline'});
      if (page==='compare' && mode==='synthetic') {
        clearFilters();menu=false;filters.set('run',run_id);await refreshComparison();
      }
      notify('模拟采集已开始，报价会陆续出现。');return;
    }
    case 'records-refresh': await refreshRecords();return;
    case 'model-test': {
      if(testing)return;
      testing=true;modelReport='正在测试文本、图片和定位。';render();
      try { await api('/api/model/test','POST',{});modelReport='文本、图片理解和页面定位已通过连接测试。'; }
      catch(e){modelReport=(e as Error).message;}
      finally{testing=false;}
      await refreshRecords();return;
    }
    case 'devices': {
      const r=await api<{adb:boolean;connected:number;error:string|null;devices:{serial:string;state:string}[];
        platforms:{platform:Platform;configured:boolean;connected:boolean;actualVersion:string|null;expectedVersion:string|null}[]}>('/api/devices');
      const statuses:Record<string,string>={device:'已连接',unauthorized:'等待手机确认 USB 调试',offline:'离线',recovery:'恢复模式',sideload:'安装模式'};
      deviceReport=r.error ? reason(r.error) : `ADB 已连接 ${r.connected} 台设备。`+
        r.devices.map(d=>d.serial+' '+(statuses[d.state] ?? d.state)+'。').join('')+
        r.platforms.filter(p=>p.configured).map(p=>label(ws,p.platform)+(p.connected ?
          p.actualVersion===p.expectedVersion?'应用版本一致。':`当前版本 ${p.actualVersion ?? '未识别'}，登记版本 ${p.expectedVersion}。`:'指定设备未连接。')).join('');
      render();return;
    }
  }
}
function parseParts(value:string) {
  return value.split(/\r?\n/).filter(x=>x.trim()).map(row=>{
    const [name,spec,qty]=row.split('|').map(x=>x.trim());
    if(!name || !spec || !Number.isInteger(Number(qty)) || Number(qty)<1)throw new Error('每项套餐内容需填写名称、规格和数量，用 | 分隔。');
    return {name,spec,quantity:Number(qty)};
  });
}
async function submit(form:HTMLFormElement) {
  const f=new FormData(form), v=(key:string)=>String(f.get(key) ?? '').trim(), id=form.dataset.id ?? '';
  switch(form.dataset.form) {
    case 'device-control': {
      const r=await api<{nodes:{resource:string|null;enabled:boolean}[]}>('/api/devices/control','POST',{platform:v('platform'),text:v('text')});
      const out=form.querySelector('output');
      if(out)out.textContent=r.nodes.length===1 ? r.nodes[0]?.resource ?? '已找到文字，页面未提供资源编号。' :
        r.nodes.length ? '找到多个控件，请使用更明确的文字。' : '当前页面没有这段控件文字。';
      return;
    }
    case 'candidate': {
      const kind=v('kind'), platform=v('platform'), entry=v('entry'), reference=v('reference');
      const supply={store:{key:selectedCandidate?.supply.store.key ?? v('store')+' / '+v('address'),brand:v('brand'),name:v('store'),city:v('city'),address:v('address')},
        item:{key:selectedCandidate?.supply.item.key ?? v('item')+' / '+v('spec'),name:v('item'),spec:v('spec'),kind,
          options:f.has('optionsKnown') ? v('options').split('、').map(x=>x.trim()).filter(Boolean) : null,parts:kind==='set'?parseParts(v('parts')):null}};
      await api('/api/matches/propose','POST',{targetId:id,candidates:[{platform,entry,supply,reference}],
        ...(selectedCandidate?.reference===reference && selectedCandidate.platform===platform ? {deviceEvidenceId:selectedCandidate.evidence?.id} : {})});
      dialog.close();await workspace();render();notify('已生成匹配建议。');return;
    }
    case 'quote-review':
      await api('/api/market/quotes/'+id+'/review','PUT',{decision:v('decision'),note:v('note'),...(v('minutes')?{minutes:Number(v('minutes'))}:{})});
      dialog.close();await refreshComparison();notify('已保存复核结果。');return;
    case 'review':
      await api('/api/mappings/'+id+'/decision','PUT',{verified:true,...(v('minutes')?{minutes:Number(v('minutes'))}:{})});
      dialog.close();await workspace();render();notify('已确认对应关系。');return;
    case 'profile': {
      const eligibility:Profile['eligibility']={};
      for(const p of ws.platforms) {
        const k=p.id,accountRef=v(k+'-account');
        if(!accountRef) {
          if (v(k+'-platform')!=='unknown' || ['segment','product','tier','benefits','proof'].some(field=>v(k+'-'+field))) {
            throw new Error('已填写'+p.name+'的账号信息，请补上接入时登记的测试账号名称。');
          }
          continue;
        }
        eligibility[k]={accountRef,platformCustomer:v(k+'-platform') as Eligibility['platformCustomer'],storeCustomer:'unknown',
          memberSegment:v(k+'-segment'),memberProduct:v(k+'-product'),memberTier:v(k+'-tier'),benefits:v(k+'-benefits').split('、').filter(Boolean),evidence:v(k+'-proof')};
      }
      const stores=[...new Map(ws.targets.map(t=>[t.supply.store.key,t.supply.store])).values()];
      const storeQualifications=stores.flatMap((store,i)=>ws.platforms.flatMap(platform=>{
        const customer=v('shop-'+i+'-'+platform.id),evidence=v('shop-proof-'+i+'-'+platform.id);
        return customer!=='unknown' || evidence ? [{storeKey:store.key,platform:platform.id,customer,evidence}] : [];
      }));
      await api('/api/market/profiles','PUT',{id:profile?.id ?? crypto.randomUUID(),name:v('name'),city:v('city'),point:v('point'),eligibility,storeQualifications,
        ...(v('checkedAt')?{checkedAt:v('checkedAt')+':00+08:00'}:{}),...(v('validUntil')?{validUntil:v('validUntil')+':00+08:00'}:{})});
      profile=undefined;break;
    }
    case 'plan': {
      const times=Object.fromEntries(Object.keys(ws.meals).flatMap(k=>v(k)?[[k,v(k)]]:[]));
      await api('/api/market/plans','PUT',{id:plan?.id ?? crypto.randomUUID(),name:v('name'),targetIds:f.getAll('target'),profileId:v('profileId'),
        quantity:Number(v('quantity')),startDate:v('startDate'),days:Number(v('days')),times,enabled:f.has('enabled')});
      plan=undefined;break;
    }
    case 'run': {
      const platform=v('platform');
      const r=await api<{run:string}>('/api/market/runs','POST',{planId:id,meal:v('meal'),...(platform ? {platform} : {})});
      clearFilters();filters.set('run',r.run);mode='live';batch=undefined;navigate('compare');return;
    }
    case 'jd-store': {
      const saved=await api<{id:string}>('/api/market/jd-stores','POST',{city:v('city'),district:v('district'),brand:v('brand'),storeName:v('storeName')});
      selectedJdStore=saved.id;
      break;
    }
    case 'jd-run': {
      if(jdSubmitting)return;
      const data={savedStoreId:v('savedStoreId'),profileId:v('profileId')};
      const error=form.querySelector<HTMLElement>('[data-jd-error]');
      const start=form.querySelector<HTMLButtonElement>('button[type=submit],button:not([type])');
      const fields=JSON.stringify(data);
      if(pendingJdRequest?.fields!==fields)pendingJdRequest={fields,id:crypto.randomUUID()};
      if(error)error.textContent='';
      if(start)start.textContent='正在提交…';
      jdSubmitting=true;
      try {
        const r=await api<{runId:string;status:string}>('/api/market/jd-runs','POST',{requestId:pendingJdRequest.id,...data});
        pendingJdRequest=undefined;
        recordRunId=r.runId;runReport=undefined;runError='';
        navigate('records','collection');
      } catch(e) {
        const message=(e as Error).message;
        if(error?.isConnected)error.textContent=message;
        else notify(message);
      } finally {
        jdSubmitting=false;
        if(start)start.textContent='开始采集';
        if(!form.isConnected && page==='settings' && section==='jd')render();
      }
      return;
    }
  }
  await workspace();render();notify('已保存。');
}
document.addEventListener('click',event=>{
  const el=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if(!el || el.disabled)return;
  el.disabled=true;void act(el).catch(e=>notify(e.message)).finally(()=>el.disabled=false);
});
document.addEventListener('submit',event=>{
  const form=event.target as HTMLFormElement;
  if(!form.dataset.form)return;
  event.preventDefault();
  const b=form.querySelector<HTMLButtonElement>('button:not([type=button])');
  if(b?.disabled)return;
  if(b)b.disabled=true;
  void submit(form).catch(e=>notify(e.message)).finally(()=>{if(b)b.disabled=false;});
});
document.addEventListener('change',event=>{
  const control=event.target as HTMLInputElement|HTMLSelectElement;
  if(page==='settings' && section==='jd' && control.name==='savedStoreId') {
    selectedJdStore=control.value;
    const saved=ws.jdStores?.find(store=>store.id===selectedJdStore);
    const status=app.querySelector('[data-jd-store-status]');
    if(status)status.textContent=saved?.verified ? '营业地址已核对 · '+saved.verified.store.address : '首次采集时会核对分店和营业地址。';
    return;
  }
  if(page==='records' && section==='collection' && control.name==='recordsRun') {
    recordRunId=control.value;runReport=undefined;runError='';
    updateRunDetail();
    void refreshRecords();
    return;
  }
  if(control.id==='order-file' && control instanceof HTMLInputElement) {
    const file=control.files?.[0];
    if(!file)return;
    if(file.size>1_500_000){notify('每次最多导入 1.5 MB。');return;}
    void file.text().then(text=>{
      const payload=file.name.toLowerCase().endsWith('.csv') ? parseOrderCsv(text) : JSON.parse(text.replace(/^\uFEFF/,''));
      if(!Array.isArray(payload.records) || !payload.records.length || payload.records.some((r:unknown)=>!r || typeof r!=='object'))throw new Error('文件需要包含 records 数组。');
      imported={name:file.name,payload};render();
    }).catch(e=>{imported=null;render();notify(e.message);});
    return;
  }
  if(dialog.open && control.name==='platform') {
    const p=ws.platforms.find(p=>p.id===control.value), entry=dialog.querySelector<HTMLInputElement>('[name=entry]');
    selectedCandidate=null;if(entry && p)entry.value=p.entry ?? p.defaultEntry;
    return;
  }
  if(page!=='compare' || dialog.open || !['run','date','city','brand','store','item','spec','meal','profile','priceMode'].includes(control.name))return;
  if(control.name==='priceMode'){menu=control.value==='menu';render();return;}
  if(control.name==='date' || control.name==='meal')filters.delete('run');
  if(control.name==='run') {filters.delete('date');filters.delete('meal');}
  const hierarchy=['city','brand','store','item','spec'];
  if(hierarchy.includes(control.name))for(const k of hierarchy.slice(hierarchy.indexOf(control.name)+1))filters.delete(k);
  if(control.value)filters.set(control.name,control.value);else filters.delete(control.name);
  void refreshComparison();
});
setInterval(()=>{
  if(page==='compare' && batch?.stats.pending && !dialog.open && !['INPUT','SELECT'].includes(document.activeElement?.tagName ?? ''))void refreshComparison();
  if(page==='records' && section==='collection' && (!runReport || runReport.state==='queued' || runReport.state==='running'))void refreshRun();
},3000);
void workspace().then(refreshComparison).catch(e=>{app.innerHTML=`<main class="content"><h1>无法连接工作台</h1><p class="muted">${h(e.message)}</p></main>`;});
