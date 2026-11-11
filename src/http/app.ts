import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../infra/sqlite-store.js';
import { BrowserPool } from '../infra/browser.js';
import { EvidenceStore } from '../infra/evidence.js';
import { sourceFingerprint } from '../infra/fingerprint.js';
import { meituanCollector, taobaoCollector } from '../adapters/fixture-collector.js';
import { Scheduler, scenarioLabels } from '../application/scheduler.js';
import { summarize } from '../application/summary.js';
import { STORES, fixtureQuote } from '../domain/catalog.js';
import { SCENARIOS, PLATFORMS, FIXTURE_PLATFORMS, type Scenario, type Platform, type Fault, type Collector } from '../domain/contracts.js';
import { CompetitionStore } from '../infra/competition-store.js';
import { ModelGateway, modelConfig, type ModelConfig } from '../infra/model.js';
import { AndroidSources } from '../adapters/android-source.js';
import { androidCollector } from '../adapters/android-collector.js';
import { findJdMenuItem, openJdStore, returnToJdMenu, scanJdShelf } from '../adapters/jd-shelf-collector.js';
import type { AndroidTransport } from '../adapters/android-transport.js';
import { competitionApi } from './competition-api.js';
import { fixtureHtml } from '../fixtures/html.js';

async function body(req: IncomingMessage, limit = 32_768): Promise<Record<string,unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('json_required');
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('request_too_large'); chunks.push(c); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json_body');
  return value as Record<string,unknown>;
}
export async function createApplication(options: { root?: string; dataDir?: string; port?: number; startScheduler?: boolean; model?: ModelConfig | null; androidTransport?:AndroidTransport } = {}) {
  const root = resolve(options.root ?? process.cwd()), dataDir = resolve(options.dataDir ?? join(root,'.runtime'));
  await mkdir(dataDir,{ recursive:true });
  if (!process.env.MIDSCENE_RUN_DIR) process.env.MIDSCENE_RUN_DIR = join(dataDir,'midscene');
  const store = new SqliteStore(join(dataDir,'observatory.sqlite'));
  const sources = await AndroidSources.load(join(dataDir,'android-sources.json'));
  const market = new CompetitionStore(store,sources);
  let config: ModelConfig|null = options.model ?? null, configError: string|null = null;
  if (options.model === undefined) {
    try { config=modelConfig(); } catch { configError='模型服务地址格式有误，请检查本地 .env 配置'; }
  }
  const model = new ModelGateway(config,row=>market.recordModel(row),configError);
  const recovered = store.recoverInterrupted();
  const browser = new BrowserPool(), evidence = new EvidenceStore(join(dataDir,'evidence'));
  let scheduler: Scheduler;
  let baseUrl = '';
  const business = competitionApi(market,sources,model,evidence,()=>scheduler.tick());
  const reply = (res: ServerResponse, code: number, data: unknown, type = 'application/json; charset=utf-8') => {
    res.writeHead(code,{ 'Content-Type':type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin', 'X-Frame-Options':'DENY', 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data));
  };
  const server = createServer((req,res) => {
    void (async () => {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { reply(res,403,{ error:'loopback_host_required' }); return; }
      const url = new URL(req.url ?? '/',`http://${host}`), method = req.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/favicon.ico') { reply(res,204,'','image/x-icon'); return; }
      if (!['GET','POST','PUT'].includes(method)) { reply(res,405,{error:'method_not_allowed'}); return; }
      if (method !== 'GET' && req.headers.origin && req.headers.origin !== url.origin) { reply(res,403,{error:'origin_not_allowed'}); return; }
      if (await business(method,url,limit=>body(req,limit),(status,data,type)=>{
        if (type?.startsWith('text/csv')) res.setHeader('Content-Disposition','attachment; filename="takeout-comparison.csv"');
        reply(res,status,data,type);
      })) return;
      if (method === 'GET' && url.pathname === '/api/state') {
        const snapshot = store.snapshot(url.searchParams.get('run') ?? market.recentRuns('synthetic')[0]?.id ?? 'no_fixture_run');
        let report: Record<string,unknown> | null = null;
        try { report = JSON.parse(await readFile(join(root,'artifacts','verification.json'),'utf8')) as Record<string,unknown>; } catch { /* No test evidence yet. */ }
        const current = sourceFingerprint(root);
        reply(res,200,{ ...snapshot, summary:summarize(snapshot), stores:STORES, version:'0.3.1', mode:'synthetic', timezone:'Asia/Shanghai', scenario_labels:scenarioLabels,
          verification: report ? {...report, matches_current_source: report.source_hash === current} : null,
          sources:[ { platform:'meituan', status:'pending', label:'真实入口未验证，未启用' }, { platform:'taobao_instant', status:'restricted', label:'许可前置条件未满足，未启用' } ],
          limitations:['真实美团和淘宝闪购入口未接通','AI 模型未配置，当前为固定浏览器流程','京东真实数据未导入，三平台比较未验收','本地单用户应用；无生产多租户认证'], recovered_interrupted:recovered }); return;
      }
      if (method === 'POST' && url.pathname === '/api/runs') {
        const b = await body(req);
        if (Object.keys(b).some(k => !['scenario','delay_seconds'].includes(k)) || !SCENARIOS.includes(b.scenario as Scenario) || (b.delay_seconds !== undefined && typeof b.delay_seconds !== 'number')) throw new Error('invalid_run_request');
        const active = market.recentRuns('synthetic').slice(0,2).some(r=>store.snapshot(r.id).slots.some(s=>['running','queued'].includes(s.state)));
        if (active) { reply(res,409,{error:'run_in_progress'}); return; }
        const id = scheduler.createManual(b.scenario as Scenario,(b.delay_seconds ?? 0) as number);
        scheduler.tick(); reply(res,201,{ run_id:id }); return;
      }
      const schedule = /^\/api\/schedules\/(lunch|dinner|night)$/.exec(url.pathname);
      if (method === 'PUT' && schedule) {
        const b = await body(req);
        if (Object.keys(b).some(k => !['time','enabled'].includes(k)) || typeof b.time !== 'string' || typeof b.enabled !== 'boolean') throw new Error('invalid_schedule');
        scheduler.updateSchedule(schedule[1]!,b.time,b.enabled); scheduler.tick(); reply(res,200,{ok:true}); return;
      }
      const proof = /^\/api\/evidence\/([a-f0-9-]{36})\.(png|json)$/.exec(url.pathname);
      if (method === 'GET' && proof) { reply(res,200,await evidence.read(proof[1]!,proof[2]!),proof[2] === 'png' ? 'image/png' : 'application/json; charset=utf-8'); return; }
      const fixture = /^\/fixtures\/(meituan|taobao_instant)$/.exec(url.pathname);
      if (method === 'GET' && fixture) {
        const faults = ['none','missing_fee','sold_out','captcha','schema_changed','minimum_not_met','network_once','cart_not_owned','price_change','zero_quote'];
        const fault = url.searchParams.get('fault') ?? 'none', session = url.searchParams.get('session') ?? randomUUID();
        if (!faults.includes(fault) || !/^[a-f0-9-]{36}$/.test(session)) throw new Error('invalid_fixture_request');
        if (fault === 'network_once' && url.searchParams.get('attempt') === '1') { reply(res,503,'<html lang="zh-CN"><body><h1>模拟网络暂时故障</h1><p>network_error：本次返回 HTTP 503，下次正常访问。</p></body></html>','text/html; charset=utf-8'); return; }
        reply(res,200,fixtureHtml(fixture[1] as Platform,fault as Fault,session),'text/html; charset=utf-8'); return;
      }
      if (method === 'POST' && url.pathname === '/fixtures/quote') {
        const b = await body(req), storeRow = STORES.find(s => s.id === b.store_id);
        if (!storeRow || !FIXTURE_PLATFORMS.some(p=>p===b.platform) || !Array.isArray(b.items) || b.items.length < 1 || b.items.length > 10) throw new Error('invalid_fixture_basket');
        const items = b.items as { product_id:string; variant:string; quantity:number }[];
        if (items.some(i => !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 9)) throw new Error('invalid_quantity');
        reply(res,200,fixtureQuote(b.platform as Platform,storeRow,items,b.fault as Fault)); return;
      }
      if (url.pathname==='/' ) { res.writeHead(302, {'Location':'/bd'}); res.end(); return; }
      const files: Record<string,[string,string]> = { '/collection.css':['collection.css','text/css; charset=utf-8'], '/ue':['ue.html','text/html; charset=utf-8'], '/ue/':['ue.html','text/html; charset=utf-8'], '/ue.js':['ue.js','text/javascript; charset=utf-8'], '/ue.css':['ue.css','text/css; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'], '/styles.css':['styles.css','text/css; charset=utf-8'], '/fixture.js':['fixture.js','text/javascript; charset=utf-8'], '/bd':['bd.html','text/html; charset=utf-8'], '/bd/':['bd.html','text/html; charset=utf-8'], '/bd.js':['bd.js','text/javascript; charset=utf-8'], '/bd.css':['bd.css','text/css; charset=utf-8'] };
      if (method === 'GET' && files[url.pathname]) {
        const [file,type] = files[url.pathname]!;
        reply(res,200,await readFile(join(root,'public',file)),type); return;
      }
      reply(res,404,{error:'not_found'});
    })().catch(e => { if (!res.headersSent) reply(res,e instanceof SyntaxError ? 400 : (e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400,{error:(e as Error).message.slice(0,180)}); else res.end(); });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  await new Promise<void>((ok,no) => { server.once('error',no); server.listen(options.port ?? 4318,'127.0.0.1',() => { server.off('error',no); ok(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen_failed');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const android=PLATFORMS.map((platform):Collector=>{
    const adapter=androidCollector(platform,sources,model,evidence,id=>market.cost(id),options.androidTransport,task=>market.mappingCurrent(task),{openJdStore,findJdMenuItem,returnToJdMenu});
    if (platform!=='jd') return adapter;
    return {...adapter,async collect(task,attemptId,signal,attemptNumber,emit) {
      if (!task.shelf) return adapter.collect(task,attemptId,signal,attemptNumber,emit);
      const source=sources.get('jd'), account=task.shelf.profile.eligibility.jd;
      const reason=!source || !sources.permitted('jd') ? 'live_source_not_ready' : !source.jdShelf ? 'jd_shelf_not_configured' :
        source.jdShelf.pilot && source.jdShelf.pilot.storeId!==task.shelf.input.savedStoreId ? 'jd_pilot_store_scope' :
        source.point!==task.shelf.profile.point || !account?.evidence || account.accountRef!==source.account ? 'profile_unverified' :
        !model.status.configured ? 'model_not_configured' : null;
      if (source && !reason) {
        const result=await scanJdShelf(task,attemptId,signal,emit,source,model,evidence,options.androidTransport);
        result.cost.model_yuan=market.cost(attemptId);
        return result;
      }
      const at=new Date().toISOString(), error=reason ?? 'live_source_not_ready';
      emit?.({phase:'source_check',state:'started'});
      emit?.({phase:'source_check',state:'blocked',errorCode:error});
      return {status:'blocked',error_code:error,availability:'unknown',observation:null,trace:[{phase:'source_check',at,note:error}],evidence:null,
        started_at:at,finished_at:at,cleanup:'untouched',cost:{model_yuan:null,execution_ms:0}};
    }};
  });
  scheduler = new Scheduler(store,[meituanCollector(baseUrl,browser,evidence),taobaoCollector(baseUrl,browser,evidence),...android],750,
    now=>market.materialize(now),(task,result)=>market.jdQuoteTasks(task,result));
  if (options.startScheduler !== false) scheduler.start();
  return { baseUrl, store, scheduler, server, dataDir,
    async close() { await scheduler.stop(); await browser.close(); await new Promise<void>((ok,no) => server.close(e => e ? no(e) : ok())); store.close(); }
  };
}
