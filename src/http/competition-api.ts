import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import { proposeMapping, rankCandidates } from '../application/matching.js';
import { PLATFORMS, type Platform } from '../domain/contracts.js';
import { array, boolean, candidateSchema, meals, number, object, orderSchema, planSchema, profileSchema, string, validator,
  enumOf, type Candidate, type Mapping, type Meal, type OrderImport, type Plan, type Profile, type Target } from '../domain/competition.js';
import { comparisonRows, csv, selectRows, summarizeBatch } from '../application/comparison.js';
import { dayInShanghai } from '../application/scheduler.js';
import { platformNames } from '../domain/competition.js';
import type { CompetitionStore } from '../infra/competition-store.js';
import type { AndroidSources } from '../adapters/android-source.js';
import { entryLabels } from '../adapters/android-source.js';
import type { EvidenceStore } from '../infra/evidence.js';
import { discoverCandidate, findDeviceControl } from '../adapters/android-collector.js';
import { deviceInventory, installedAppVersion } from '../adapters/android-transport.js';
import type { ModelGateway } from '../infra/model.js';
import { jdRunInputSchema, jdSavedRunInputSchema, jdStoreInputSchema, type JdRunInput, type JdSavedRunInput, type JdStoreInput } from '../domain/jd-shelf.js';
import { checkCatalogImport, catalogTemplate } from '../domain/monitor-catalog.js';
import {PAGE_ONTOLOGY_VERSION,businessEntities,businessRelations,quoteFieldDefinitions,supplyFieldDefinitions,fieldGovernance,publicPageMap} from '../domain/page-ontology.js';

const importCheck = validator<{records:OrderImport[]}>(object({records:array(orderSchema,500,1)}),'京东订单');
const candidateCheck = validator<{targetId:string; candidates:Candidate[]; deviceEvidenceId?:string}>(object({targetId:string(100),candidates:array(candidateSchema,30,1),deviceEvidenceId:string(36)},['targetId','candidates']),'店品候选');
const reviewCheck = validator<{verified:boolean; minutes?:number}>(object({verified:boolean,minutes:number(0,480)},['verified']),'映射确认');
const planCheck = validator<Plan>(planSchema,'监测计划');
const quoteReviewCheck=validator<{decision:'verified'|'disputed';note:string;minutes?:number}>(object({decision:{enum:['verified','disputed']},note:string(250,0),minutes:number(0,480)},['decision','note']),'报价复核');
const profileCheck = validator<Profile>(profileSchema,'配送与账号');
const jdRunCheck = validator<JdRunInput>(jdRunInputSchema,'京东爆品采集');
const jdSavedRunCheck=validator<JdSavedRunInput>(jdSavedRunInputSchema,'京东采集');
const jdStoreCheck=validator<JdStoreInput>(jdStoreInputSchema,'负责门店');
function trimFields<T extends object>(value:T):T {
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,typeof v==='string' ? v.trim() : v])) as T;
}

export function competitionApi(store: CompetitionStore, sources: AndroidSources, model: ModelGateway, evidence: EvidenceStore, tick: () => void) {
  let matching = false, testing = false;
  return async (method: string, url: URL, body: (limit?: number) => Promise<unknown>, reply: (status: number, data: unknown, type?: string) => void) => {
    const path = url.pathname;
    if(method==='GET'&&path==='/api/market/page-maps'){reply(200,{ontologyVersion:PAGE_ONTOLOGY_VERSION,entities:businessEntities,relations:businessRelations,properties:quoteFieldDefinitions,supplyProperties:supplyFieldDefinitions,rules:fieldGovernance,platforms:PLATFORMS.map(p=>publicPageMap(p,sources.get(p))),history:store.pageMaps()});return true;}
    if(method==='GET' && path==='/api/market/catalog/template.csv'){reply(200,catalogTemplate,'text/csv; charset=utf-8');return true;}
    if(method==='GET' && path==='/api/market/catalog'){reply(200,{entries:store.catalog()});return true;}
    if(method==='POST' && path==='/api/market/catalog/imports'){const input=checkCatalogImport(await body(1_500_000));reply(input.mode==='preview'?200:201,store.importCatalog(input));return true;}
    const catalogQuotes=/^\/api\/market\/catalog\/([a-f0-9]{64})\/quotes$/.exec(path);
    if(method==='GET' && catalogQuotes){reply(200,store.catalogQuotes(catalogQuotes[1]!));return true;}
    if (method==='GET' && path==='/api/workspace') {
      reply(200,{
        version:'0.4.4', ueWorkspacePath:'/ue', catalog:store.catalog(),
        platforms:PLATFORMS.map(id=>{
          const source = sources.permitted(id) ? sources.get(id) : undefined;
          return {id,name:platformNames[id],defaultEntry:entryLabels[id],...sources.status(id),...(id==='jd' ? {shelfReady:!!source?.jdShelf} : {}),
            ...(source ? {setup:{accountName:source.account,deliveryName:source.point}} : {})};
        }),
        model:model.status, sourceConfigurationError:sources.configurationError, targets:store.list<Target>('market_targets').map(t=>store.currentTarget(t.id)),
        profiles:store.list<Profile>('market_profiles'), jdStores:store.jdStores(), plans:store.list<Plan>('market_plans'),
        mappings:store.list<Mapping>('market_mappings',150), meals
      });
      return true;
    }
    if (method==='GET' && ['/api/comparisons','/api/comparisons.csv'].includes(path)) {
      const q = url.searchParams, mode = q.get('mode')==='synthetic' ? 'synthetic' : 'live';
      const requestedRun = q.get('run');
      const runs = store.recentRuns(mode,false);
      const run = requestedRun ? runs.find(r=>r.id===requestedRun) : runs.find(r=>(!q.get('date') || dayInShanghai(new Date(r.created_at))===q.get('date')) &&
        (!q.get('meal') || r.label.endsWith(' · '+meals[q.get('meal') as Meal])));
      const slots = run ? store.slots(run.id) : [];
      const all = comparisonRows(slots), rows = selectRows(all,q);
      if (path.endsWith('.csv')) reply(200,csv(rows,run,url.origin),'text/csv; charset=utf-8');
      else reply(200,{mode,run:run ?? null,runs,rows,facets:all.map(({city,brand,store,item,spec,profile,meal})=>({city,brand,store,item,spec,profile,meal})), stats:summarizeBatch(slots,all)});
      return true;
    }
    if (method==='GET' && path==='/api/market/live-progress') {
      // 采集实时进度：读取脚本写的 progress 文件，前端轮询渲染进度条
      try {
        const raw = await readFile('.runtime/live-progress.json','utf8');
        reply(200, JSON.parse(raw));
      } catch {
        reply(200, {platform:null,node:null,index:0,total:8,percent:0,state:'idle'});
      }
      return true;
    }
    if (method==='GET' && path==='/api/market/records') {
      const live = store.recentRuns('live');
      const requested=url.searchParams.get('runId') ?? url.searchParams.get('run');
      const saved=requested ? store.run(requested) : undefined;
      const selected = saved?.scenario==='competition' ? saved : live[0];
      const slots = selected ? store.slots(selected.id) : [];
      const rows = comparisonRows(slots);
      reply(200,{orders:store.list('market_orders',100),modelCalls:store.modelCalls(undefined,30),
        trial:store.trialReport(),runs:live,run:selected ?? null,slots:slots.map(s=>({platform:s.task.platform, store:s.task.live?.target.supply.store.name ?? s.task.shelf?.input.storeName,
          item:s.task.live?.target.supply.item.name, dueAt:s.task.due_at, state:s.state, status:s.state==='completed' ? s.result?.status ?? null : null, attempts:s.attempts,
          phase:s.result?.trace.filter(step=>!['stop','cleanup'].includes(step.phase)).at(-1)?.note ?? null,
          review:s.review ?? null,error:s.block_reason ?? s.result?.error_code ?? null,proof:s.result?.evidence ?? null})),stats:summarizeBatch(slots,rows)});
      return true;
    }
    if (method==='POST' && path==='/api/market/jd-stores') {
      reply(201,store.saveJdStore(trimFields(jdStoreCheck(await body()))));
      return true;
    }
    if (method==='POST' && path==='/api/market/jd-runs') {
      const request=await body();
      try {
        let runId:string;
        if(request && typeof request==='object' && 'targetId' in request) {
          const input=validator<{requestId:string;targetId:string;profileId:string;couponCheckoutConsent?:{reference:string}}>(object({requestId:{type:'string',pattern:'^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'},targetId:string(64),profileId:string(60),couponCheckoutConsent:object({reference:string(250)})},['requestId','targetId','profileId']),'指定单品采集')(request);
          runId=store.startSpecifiedRun({...input,requestId:input.requestId.toLowerCase()});
        } else if (request && typeof request==='object' && 'savedStoreId' in request) {
          const input=trimFields(jdSavedRunCheck(request));
          runId=store.startSavedJdRun({...input,requestId:input.requestId.toLowerCase()});
        } else {
          const input=trimFields(jdRunCheck(request));
          runId=store.startJdRun({...input,requestId:input.requestId.toLowerCase()});
        }
        reply(202,{runId,status:store.runDetails(runId)?.state ?? 'queued'});
        setImmediate(tick);
      } catch (error) {
        if ((error as Error).message!=='jd_request_conflict') throw error;
        reply(409,{error:'jd_request_conflict'});
      }
      return true;
    }
    const runDetails=/^\/api\/market\/runs\/([\w:-]{1,140})$/.exec(path);
    if (method==='GET' && runDetails) {
      const details=store.runDetails(runDetails[1]!);
      reply(details ? 200 : 404,details ?? {error:'run_not_found'});
      return true;
    }
    if (method==='POST' && path==='/api/imports/jd-orders') {
      reply(201,store.importOrders(importCheck(await body(1_500_000)).records)); return true;
    }
    if (method==='POST' && path==='/api/devices/control') {
      const {platform,text}=validator<{platform:Platform;text:string}>(object({platform:{type:'string',enum:[...PLATFORMS]},text:string(200)}),'控件查找')(await body());
      const source=sources.get(platform);
      if (!source || !sources.permitted(platform)) throw new Error('live_source_not_ready');
      const nodes=await store.legacy.withDevice(platform,source.account,source.device,()=>findDeviceControl(source,text));
      reply(200,{nodes});return true;
    }
    if (method==='POST' && path==='/api/candidates/device') {
      const {platform} = validator<{platform:Platform}>(object({platform:{type:'string',enum:[...PLATFORMS]}}),'读取手机候选')(await body());
      const source = sources.get(platform);
      if (!source || !sources.permitted(platform)) throw new Error('live_source_not_ready');
      const candidate = await store.legacy.withDevice(platform,source.account,source.device,()=>discoverCandidate(source,evidence));
      reply(201,store.saveCandidate(candidate));
      return true;
    }
    if (method==='POST' && path==='/api/matches/propose') {
      if (matching) { reply(409,{error:'已有一批候选正在识别'}); return true; }
      matching = true;
      try {
        const input = candidateCheck(await body(280_000));
        const target = store.currentTarget(input.targetId), proposed = [];
        for (const c of rankCandidates(target,input.candidates)) {
          if (input.deviceEvidenceId) {
            const captured = store.get<Candidate>('market_candidates',input.deviceEvidenceId);
            if (c.platform!==captured.platform || c.entry!==captured.entry || c.reference!==captured.reference) throw new Error('候选与手机证据来源不一致');
            c.evidence = captured.evidence;
          }
          proposed.push(store.addMapping(await proposeMapping(target,c,model)));
        }
        reply(201,{proposed});
      } finally { matching = false; }
      return true;
    }
    const decision = /^\/api\/mappings\/([a-f0-9-]{36})\/decision$/.exec(path);
    if (method==='PUT' && decision) {
      const b = reviewCheck(await body()); reply(200,store.decide(decision[1]!,b.verified,b.minutes)); return true;
    }
    const quoteReview=/^\/api\/market\/quotes\/([a-f0-9-]{36})\/review$/.exec(path);
    if (method==='PUT' && quoteReview) {
      const input=quoteReviewCheck(await body());
      reply(200,store.reviewQuote(quoteReview[1]!,input.decision,input.note,input.minutes ?? null));return true;
    }
    if (method==='PUT' && path==='/api/market/profiles') {
      reply(200,store.saveProfile(profileCheck(await body()))); return true;
    }
    if (method==='PUT' && path==='/api/market/plans') {
      const p = store.savePlan(planCheck(await body())); tick(); reply(200,p); return true;
    }
    if (method==='POST' && path==='/api/bd/runs') {
      // BD 采数入口：按 城市/品牌/门店/爆品 匹配已登记商品，创建真实采集任务并落库。
      const input = validator<{city:string;brand:string;store?:string;item:string;platforms:string[]}>(
        object({city:string(40),brand:string(60),store:string(120,0),item:string(80),
          platforms:array(string(30),3,1)},['city','brand','item','platforms']),'BD 采集请求')(await body(200_000));
      const norm=(v:string)=>String(v||'').replace(/\s+/g,'').replace(/[（(].*?[)）]/g,'').replace(/&/g,'');
      const cat = store.catalog();
      const hit = cat.find(e=>(!input.city || norm(e.city).includes(norm(input.city))) &&
        norm(e.brand).includes(norm(input.brand)) &&
        (!input.store || norm(e.storeName).includes(norm(input.store))) &&
        norm(e.itemName).includes(norm(input.item)));
      if (!hit) { reply(404,{error:'no_matching_catalog_entry',message:'没有匹配的已登记商品，请先在 UE 工作台导入包销品清单'}); return true; }
      const profiles = store.list<Profile>('market_profiles');
      const profile = profiles.find(p=>p.eligibility.jd) ?? profiles[0];
      if (!profile) { reply(400,{error:'no_profile',message:'没有可用的配送地址与测试账号条件'}); return true; }
      const valid = input.platforms.filter(p=>(PLATFORMS as readonly string[]).includes(p));
      if (!valid.length) { reply(400,{error:'no_valid_platform',message:'请至少选择一个有效平台'}); return true; }
      const result: {platform:string;runId?:string;state:string;message?:string}[] = [];
      for (const platform of valid) {
        if (platform === 'jd') {
          try {
            const requestId = crypto.randomUUID();
            store.startSpecifiedRun({requestId, targetId:hit.id, profileId:profile.id});
            result.push({platform, runId:requestId, state:'queued'});
          } catch (e) {
            result.push({platform, state:'failed', message:(e as Error).message.slice(0,160)});
          }
        } else if (platform === 'meituan') {
          try {
            const planId = createHash('sha256').update(['bd',hit.id,'meituan'].join('|')).digest('hex');
            const existingPlan = (store.list<Plan>('market_plans') as Plan[]).find(p=>p.id===planId);
            if (!existingPlan) {
              store.savePlan({id:planId, name:`BD 美团采集 · ${hit.itemName}`, targetIds:[hit.id], profileId:profile.id,
                quantity:1, startDate:new Date().toISOString().slice(0,10), days:1,
                times:{lunch:'11:00',dinner:'17:00',night:'21:00'}, enabled:true});
            }
            const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',hour:'numeric',hourCycle:'h23'}).format(new Date()));
            const meal = (hour<16?'lunch':hour<21?'dinner':'night') as 'lunch'|'dinner'|'night';
            const run = store.runNow(planId, meal, 'meituan');
            result.push({platform, runId:String(run), state:'queued'});
          } catch (e) {
            result.push({platform, state:'failed', message:(e as Error).message.slice(0,160)});
          }
        } else {
          // 淘宝闪购的真实采集链路尚未接入调度器，明确返回未接入，不返回假数据。
          result.push({platform, state:'not_integrated', message:'淘宝闪购的采集链路尚未接入调度，暂不能从这里发起'});
        }
      }
      tick();
      reply(201,{matched:{id:hit.id,storeName:hit.storeName,itemName:hit.itemName,city:hit.city},profile:{id:profile.id,name:profile.name},platforms:result});
      return true;
    }
    if (method==='POST' && path==='/api/market/runs') {
      const input = validator<{planId:string;meal:Meal;platform?:Platform}>(object({planId:string(60),meal:{type:'string',enum:Object.keys(meals)},
        platform:{type:'string',enum:[...PLATFORMS]}},['planId','meal']),'采集请求')(await body());
      const run = store.runNow(input.planId,input.meal,input.platform); tick(); reply(201,{run}); return true;
    }
    if (method==='GET' && path==='/api/devices') {
      const devices=await deviceInventory();
      const platforms=await Promise.all(PLATFORMS.map(async p=>{
        const configured=sources.get(p), device=configured ? devices.devices.find(d=>d.serial===configured.device):null;
        const actualVersion=configured && device?.state==='device' ? await installedAppVersion(configured.device,configured.package).catch(()=>null):null;
        return {platform:p,configured:!!configured,connected:device?.state==='device',deviceState:device?.state ?? null,
          actualVersion,expectedVersion:configured?.appVersion ?? null,sourceStatus:sources.status(p).status};
      }));
      reply(200,{...devices,platforms}); return true;
    }
    if (method==='POST' && path==='/api/model/test') {
      await body();
      if (testing) { reply(409,{error:'连接测试正在进行'}); return true; }
      testing = true;
      try { reply(200,await model.test()); }
      finally { testing = false; }
      return true;
    }
    return false;
  };
}
