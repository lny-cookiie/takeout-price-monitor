import { randomUUID } from 'node:crypto';
import type { SqliteStore } from './sqlite-store.js';
import type { ModelAudit } from './model.js';
import { BUSINESS_VERSION, digest, itemGate, liveSources, meals, normalize, platformNames, safeDate, storeGate, type Candidate, type Mapping, type Meal, type OrderImport, type Plan, type Profile, type Target } from '../domain/competition.js';
import { PLATFORMS, TENANT, type Platform, type QuoteReview, type Slot, type Task } from '../domain/contracts.js';
import type { RunInfo } from '../application/ports.js';
import { comparisonRows, summarizeBatch } from '../application/comparison.js';
import type { AndroidSources } from '../adapters/android-source.js';
import { jdBrandKey, matchesJdStore, validateJdShelfResult, type JdRunInput, type JdSavedRunInput, type JdSavedStore, type JdStoreInput } from '../domain/jd-shelf.js';
import type { AttemptResult } from '../domain/contracts.js';
import { catalogEligible, catalogKey, parseCatalog, type CatalogEntry, type CatalogImport } from '../domain/monitor-catalog.js';
import {publicPageMap} from '../domain/page-ontology.js';

type Row = Record<string,unknown>;
const read = <T>(value: unknown): T => JSON.parse(String(value)) as T;
type Table = 'market_targets' | 'market_mappings' | 'market_profiles' | 'market_plans' | 'market_orders' | 'market_candidates';
type StoredPlan = Plan & { revision: number };
export class CompetitionStore {
  constructor(readonly legacy: SqliteStore, private sources: AndroidSources) {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS market_brands(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS market_stores(id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES market_brands(id), payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE IF NOT EXISTS market_targets(id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES market_stores(id), payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE IF NOT EXISTS market_mappings(id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES market_targets(id), platform TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE INDEX IF NOT EXISTS market_mapping_lookup ON market_mappings(target_id,platform);
      CREATE TABLE IF NOT EXISTS market_orders(id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES market_targets(id), payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE IF NOT EXISTS market_profiles(id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE IF NOT EXISTS market_plans(id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE IF NOT EXISTS market_candidates(id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE IF NOT EXISTS market_jd_stores(id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE INDEX IF NOT EXISTS market_saved_shelf ON slots(json_extract(task_json,'$.shelf.input.savedStoreId'),due_at DESC)
        WHERE json_type(task_json,'$.shelf.input.savedStoreId')='text';
      CREATE TABLE IF NOT EXISTS market_audit(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
      INSERT OR IGNORE INTO migrations VALUES(2);
      CREATE TABLE IF NOT EXISTS market_quote_reviews(id INTEGER PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES observations(id), payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE INDEX IF NOT EXISTS market_quote_review_lookup ON market_quote_reviews(observation_id,id DESC);
      INSERT OR IGNORE INTO migrations VALUES(3);
      CREATE TABLE IF NOT EXISTS monitor_catalog(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE IF NOT EXISTS monitor_catalog_imports(id TEXT PRIMARY KEY,at TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));
      INSERT OR IGNORE INTO migrations VALUES(5);
      CREATE TABLE IF NOT EXISTS page_map_versions(id TEXT PRIMARY KEY,at TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));
      INSERT OR IGNORE INTO migrations VALUES(6);

      CREATE TABLE IF NOT EXISTS screenshot_batches(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,city TEXT NOT NULL DEFAULT '',brand TEXT NOT NULL DEFAULT '',store TEXT NOT NULL DEFAULT '',item TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open');
      CREATE TABLE IF NOT EXISTS screenshot_quotes(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,platform TEXT NOT NULL,created_at TEXT NOT NULL,source_filename TEXT NOT NULL DEFAULT '',evidence_id TEXT NOT NULL,image_sha256 TEXT NOT NULL,store_name TEXT,city TEXT,brand TEXT,item_name TEXT,spec TEXT,quantity INTEGER,payable_fen INTEGER,subtotal_fen INTEGER,packaging_fen INTEGER,delivery_fen INTEGER,discount_fen INTEGER,coupons_json TEXT NOT NULL DEFAULT '[]',raw_json TEXT NOT NULL DEFAULT '{}',confidence TEXT NOT NULL DEFAULT 'low',review_status TEXT NOT NULL DEFAULT 'auto',issues_json TEXT NOT NULL DEFAULT '[]',error TEXT,UNIQUE(batch_id,platform));
      CREATE INDEX IF NOT EXISTS screenshot_quote_batch ON screenshot_quotes(batch_id);
      CREATE INDEX IF NOT EXISTS screenshot_quote_time ON screenshot_quotes(created_at DESC);
      INSERT OR IGNORE INTO migrations VALUES(7);
      COMMIT;
    `);
    for(const platform of PLATFORMS){const source=this.sources.get(platform);if(source){const map=publicPageMap(platform,source);this.db.prepare('INSERT OR IGNORE INTO page_map_versions VALUES(?,?,?)').run(map.mapVersion,new Date().toISOString(),JSON.stringify(map));}}
  }
  private get db() { return this.legacy.db; }
  catalog():CatalogEntry[] {return this.db.prepare('SELECT payload FROM monitor_catalog ORDER BY rowid DESC').all().map(r=>read<CatalogEntry>(r.payload));}
  pageMaps(){return this.db.prepare('SELECT payload,at FROM page_map_versions ORDER BY at DESC LIMIT 100').all().map(r=>({...read<ReturnType<typeof publicPageMap>>(r.payload),registeredAt:String(r.at)}));}
  importCatalog(input:CatalogImport) {
    const records=parseCatalog(input), at=new Date().toISOString(), batch=digest([input.source,input.sourceVersion??null,records]);
    const sourceVersion=input.sourceVersion??batch.slice(0,12);
    const entries=records.map(row=>({...row,id:catalogKey(row,input.source),revision:digest(row),savedStoreId:digest([normalize(row.city).replace(/市$/,''),normalize(row.district),jdBrandKey(row.brand),normalize(row.storeName)]),
      source:input.source,sourceVersion,importedAt:at} satisfies CatalogEntry));
    if(input.mode==='preview')return {entries,imported:0,duplicate:false,sourceVersion};
    if(this.db.prepare('SELECT id FROM monitor_catalog_imports WHERE id=?').get(batch))return {entries:entries.map(e=>this.catalog().find(v=>v.id===e.id)??e),imported:0,duplicate:true,sourceVersion};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const e of entries) {
        const saved=this.saveJdStore(e), anchor=this.jdIdentity(saved.id)?.store, prior=this.catalog().find(v=>v.id===e.id);
        const supply={store:{key:e.storeId??saved.id,brand:e.brand,name:e.storeName,city:e.city,address:anchor?.address??''},
          item:{key:e.skuId??e.id,name:e.itemName,kind:'single' as const,spec:e.spec,options:e.options??[],parts:null}};
        const brandId=digest(['jd',normalize(e.brand)]), storeId=digest(['jd',supply.store.key]);
        const target:Target={id:e.id,revision:digest(supply),supply,reference:'catalog:'+batch};
        this.db.prepare('INSERT OR IGNORE INTO market_brands VALUES(?,?)').run(brandId,e.brand);
        this.db.prepare('INSERT OR IGNORE INTO market_stores VALUES(?,?,?)').run(storeId,brandId,JSON.stringify(supply.store));
        if(!prior || prior.revision!==e.revision)this.db.prepare('INSERT INTO market_targets VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET store_id=excluded.store_id,payload=excluded.payload').run(e.id,storeId,JSON.stringify(target));
        this.db.prepare('INSERT INTO monitor_catalog VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(e.id,JSON.stringify(e));
      }
      this.db.prepare('INSERT INTO monitor_catalog_imports VALUES(?,?,?)').run(batch,at,JSON.stringify({source:input.source,sourceVersion,records}));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return {entries,imported:entries.length,duplicate:false,sourceVersion};
  }
  private resolvedCatalog(id:string) {
    const entry=this.catalog().find(e=>e.id===id);
    if(!entry)return null;
    const row=this.db.prepare(`SELECT result_json FROM slots WHERE json_extract(task_json,'$.live.target.id')=?
      AND json_extract(task_json,'$.specified.catalogRevision')=? AND json_type(result_json,'$.resolvedLive.mapping')='object'
      ORDER BY due_at DESC LIMIT 1`).get(id,entry.revision);
    return row?read<AttemptResult>(row.result_json).resolvedLive??null:null;
  }
  list<T>(table: Table, limit = 1000): T[] {
    return (this.db.prepare('SELECT payload FROM '+table+' ORDER BY rowid DESC LIMIT ?').all(limit) as Row[]).map(r=>read<T>(r.payload));
  }
  get<T>(table: Table,id: string): T {
    const row = this.db.prepare('SELECT payload FROM '+table+' WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('找不到所选记录');
    return read<T>(row.payload);
  }
  importOrders(orders: OrderImport[]) {
    let imported = 0, duplicates = 0;
    const targets = new Set<string>();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const input of orders) {
        const order = {...input, paidAt:input.paidAt ? safeDate(input.paidAt) : null};
        if (order.actualPaidFen !== null && !order.paidAt) throw new Error('实际支付金额需要对应的支付时间');
        const key = digest(order.key);
        const previous = this.db.prepare('SELECT payload FROM market_orders WHERE id=?').get(key);
        if (previous) {
          const old = read<{record: OrderImport}>(previous.payload);
          if (digest(old.record) !== digest(order)) throw new Error('订单行键已存在且内容不同，请检查导出版本');
          duplicates++; continue;
        }
        const { store, item } = order.supply;
        const storeId = digest(['jd',store.key]);
        const id = digest([storeId,item.key]);
        const knownStore=this.db.prepare('SELECT payload FROM market_stores WHERE id=?').get(storeId);
        const priorStore=knownStore ? read<Target['supply']['store']>(knownStore.payload) : null;
        if (priorStore) order.supply={...order.supply,store:{...store,brand:store.brand || priorStore.brand,city:store.city || priorStore.city,address:store.address || priorStore.address}};
        const existing = this.db.prepare('SELECT payload FROM market_targets WHERE id=?').get(id);
        if (existing) {
          const target = read<Target>(existing.payload);
          const original = target.supply;
          order.supply = {...order.supply,item:{...item,spec:item.spec || original.item.spec,options:item.options ?? original.item.options,parts:item.parts ?? original.item.parts}};
        }
        const finalBrandId = digest(['jd',normalize(order.supply.store.brand) || store.key]);
        const target: Target = { id, revision:digest(order.supply), supply:order.supply, reference:order.reference };
        this.db.prepare('INSERT OR IGNORE INTO market_brands VALUES(?,?)').run(finalBrandId,order.supply.store.brand);
        this.db.prepare('INSERT INTO market_stores VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET brand_id=excluded.brand_id,payload=excluded.payload').run(storeId,finalBrandId,JSON.stringify(order.supply.store));
        this.db.prepare('INSERT INTO market_targets VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,storeId,JSON.stringify(target));
        this.db.prepare('INSERT INTO market_orders VALUES(?,?,?)').run(key,id,JSON.stringify({targetId:id,priceKind:'actual_paid',source:'JD_ORDER_IMPORT',record:input.paidAt ? {...input,paidAt:order.paidAt} : input}));
        targets.add(id); imported++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return {imported,duplicates,targetIds:[...targets]};
  }
  currentTarget(id: string): Target {
    const resolved=this.resolvedCatalog(id);
    if(resolved)return resolved.target;
    const t = this.get<Target>('market_targets',id);
    const row = this.db.prepare('SELECT payload FROM market_stores WHERE id=(SELECT store_id FROM market_targets WHERE id=?)').get(id)!;
    const supply = {...t.supply,store:read<Target['supply']['store']>(row.payload)};
    return {...t,supply,revision:digest(supply)};
  }
  mappingCurrent(task: Task) {
    if(task.specified)return this.catalog().some(e=>e.id===task.live?.target.id && e.revision===task.specified!.catalogRevision && catalogEligible(e));
    const live=task.live;
    if (!live?.mapping) return false;
    if (task.jdShelfParent) {
      const row=this.db.prepare("SELECT result_json FROM slots WHERE id=? AND run_id=? AND state='completed'").get(task.jdShelfParent,task.run_id);
      const picked=row?.result_json ? read<AttemptResult>(row.result_json).shelf?.selected.find(item=>item.key===task.jdItemKey) : undefined;
      return !!picked && live.target.reference===picked.evidence.id && live.target.revision===digest(picked.supply) &&
        digest(live.mapping.candidate.supply)===live.target.revision && live.mapping.id===digest([task.jdShelfParent,picked.key,picked.evidence.id]);
    }
    const current=this.currentTarget(live.target.id);
    return current.revision===live.target.revision && this.mapping(current,task.platform,task.entry_point)?.id===live.mapping.id;
  }
  saveCandidate(c: Candidate) {
    this.db.prepare('INSERT INTO market_candidates VALUES(?,?)').run(c.reference,JSON.stringify(c));
    return c;
  }
  addMapping(mapping: Mapping) {
    this.db.prepare('INSERT INTO market_mappings VALUES(?,?,?,?)').run(mapping.id,mapping.targetId,mapping.candidate.platform,JSON.stringify(mapping));
    return mapping;
  }
  decide(id: string, verified: boolean, minutes?: number) {
    const m = this.get<Mapping>('market_mappings',id);
    const t = this.currentTarget(m.targetId);
    if (m.status !== 'proposed') throw new Error('此映射已处理，请生成新版本');
    if (verified && (m.targetRevision !== t.revision || m.store.relation !== 'exact' || m.item.relation !== 'exact' || m.store.missing.length || m.item.missing.length ||
        storeGate(t.supply,m.candidate.supply) || itemGate(t.supply,m.candidate.supply))) throw new Error('地址或规格尚未核实为一致，不能确认');
    const next: Mapping = {...m,status:verified ? 'verified' : 'rejected',reviewedAt:new Date().toISOString(),reviewMinutes:minutes};
    this.db.prepare('UPDATE market_mappings SET payload=? WHERE id=?').run(JSON.stringify(next),id);
    return next;
  }
  mapping(target: Target, platform: Platform, entry?: string): Mapping | null {
    const resolved=platform==='jd'?this.resolvedCatalog(target.id)?.mapping:null;
    if(resolved?.targetRevision===target.revision && resolved.candidate.entry===(entry??this.sources.get(platform)?.entry))return resolved;
    const row = this.db.prepare(`SELECT payload FROM market_mappings WHERE target_id=? AND platform=? AND
      json_extract(payload,'$.targetRevision')=? AND json_extract(payload,'$.candidate.entry')=? AND
      json_extract(payload,'$.status')='verified' ORDER BY json_extract(payload,'$.reviewedAt') DESC,rowid DESC LIMIT 1`).get(target.id,platform,target.revision,entry ?? this.sources.get(platform)?.entry ?? '');
    return row ? read<Mapping>(row.payload) : null;
  }
  saveProfile(profile: Profile) {
    if (!/^[\w-]+$/.test(profile.id)) throw new Error('分层编号只接受字母、数字、下划线和短横线');
    if (Boolean(profile.checkedAt)!==Boolean(profile.validUntil)) throw new Error('请同时填写资格核对时间和有效截止时间');
    if (profile.checkedAt && profile.validUntil) {
      profile={...profile,checkedAt:safeDate(profile.checkedAt),validUntil:safeDate(profile.validUntil)};
      if (Date.parse(profile.validUntil!)<=Date.parse(profile.checkedAt!)) throw new Error('有效截止时间需晚于资格核对时间');
    }
    const storeQuals=profile.storeQualifications ?? [];
    if (new Set(storeQuals.map(q=>JSON.stringify([q.storeKey,q.platform]))).size!==storeQuals.length) throw new Error('同一门店在同一平台只能登记一项资格');
    this.db.prepare('INSERT INTO market_profiles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(profile.id,JSON.stringify(profile));
    return profile;
  }
  savePlan(plan: Plan) {
    if (!/^[\w-]+$/.test(plan.id) || new Set(plan.targetIds).size !== plan.targetIds.length || !Object.keys(plan.times).length ||
      !Number.isFinite(Date.parse(plan.startDate+'T00:00:00Z')) || new Date(plan.startDate+'T00:00:00Z').toISOString().slice(0,10) !== plan.startDate)
      throw new Error('请检查计划日期、用餐时段和所选商品，至少填写一个采集时间。');
    this.loadPlanInputs(plan);
    const old = this.db.prepare('SELECT payload FROM market_plans WHERE id=?').get(plan.id);
    const previous = old ? read<StoredPlan>(old.payload) : null;
    if (previous && digest({...previous,revision:0}) === digest({...plan,revision:0})) return previous;
    const next = {...plan,revision:(previous?.revision ?? 0)+1};
    this.legacy.cancelSchedule('market_'+plan.id);
    this.db.prepare('INSERT INTO market_plans VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(plan.id,JSON.stringify(next));
    return next;
  }
  private loadPlanInputs(plan: Plan) {
    const profile = this.get<Profile>('market_profiles',plan.profileId);
    const targets = plan.targetIds.map(id=>this.currentTarget(id));
    if (targets.some(t=>!t.supply.store.city || normalize(t.supply.store.city) !== normalize(profile.city))) throw new Error('配送城市必须与所选门店的城市一致。');
    return {profile,targets};
  }
  private enqueue(plan: StoredPlan, meal: Meal, due: Date, key: string | null, onlyPlatform?:Platform) {
    const id = key ?? randomUUID(), {profile,targets} = this.loadPlanInputs(plan);
    const platforms=onlyPlatform ? [onlyPlatform] : PLATFORMS;
    const tasks = targets.flatMap((target,i) => {
      const dueAt = new Date(due.getTime()+i*(key ? 600_000 : 300_000));
      const group = id+'_g'+i;
      const eligibility:Profile['eligibility']={};
      for (const platform of PLATFORMS) {
        const account=profile.eligibility[platform];
        if (!account) continue;
        const verified=profile.storeQualifications?.find(q=>q.platform===platform && q.storeKey===target.supply.store.key);
        eligibility[platform]={...account,storeCustomer:verified?.evidence ? verified.customer : 'unknown',storeEvidence:verified?.evidence,storeKey:verified?.storeKey};
      }
      const resolvedProfile={...profile,eligibility,storeQualifications:undefined};
      return platforms.map(platform => {
        const source = this.sources.get(platform);
        const mapping = this.mapping(target,platform,source?.entry);
        const context = {target,mapping,profile:resolvedProfile,planName:plan.name,meal,quantity:plan.quantity,couponPolicy:'page_applied',sourceRevision:source ? digest(source) : null} as const;
        return {
          contract_version:BUSINESS_VERSION,tenant_id:TENANT,source_id:liveSources[platform],slot_id:group+'_'+platform,run_id:id,comparison_group_id:group,
          platform,store_id:target.supply.store.key,basket_id:target.id,scenario_id:digest([resolvedProfile,plan.quantity,mapping?.id,context.sourceRevision,meal]),
          entry_point:source?.entry ?? mapping?.candidate.entry ?? 'unconfigured',account_ref:source?.account ?? platform+'_pending',
          device_ref:source?.device ?? platform+'_pending',delivery_point_id:profile.point,due_at:dueAt.toISOString(),
          deadline_at:new Date(dueAt.getTime()+300_000).toISOString(),data_mode:'live',fault:'none',max_attempts:onlyPlatform ? 1 : 2,timeout_seconds:240,
          requested_fields:['checkout_payable','delivery_fee','packaging_fee'],required_fields:['checkout_payable'],
          allowed_actions:['browse','select_variant','modify_owned_test_cart','read_checkout'],live:context
        } satisfies Task;
      });
    });
    const label=plan.name+(onlyPlatform ? ' · '+platformNames[onlyPlatform] : '')+' · '+meals[meal];
    this.legacy.createRun({id,scenario:'competition',created_at:due.toISOString(),label,schedule_key:key},tasks);
    return id;
  }
  runNow(id: string, meal: Meal, onlyPlatform?:Platform) {
    if (onlyPlatform && !this.sources.permitted(onlyPlatform)) throw new Error('live_source_not_ready');
    return this.enqueue(this.get<StoredPlan>('market_plans',id),meal,new Date(),null,onlyPlatform);
  }
  retryGroupPlatform(runId:string, platform:Platform) {
    const slot=this.legacy.snapshot(runId).slots.find(s=>s.task.platform===platform);
    if (!slot) throw new Error('找不到该平台的采集任务');
    if (!this.sources.permitted(platform)) throw new Error('live_source_not_ready');
    if (!(slot.state==='completed' && slot.result && ['failed','blocked'].includes(slot.result.status)) && !['interrupted','source_blocked'].includes(slot.state)) throw new Error('只有已结束的失败任务可以重试');
    const paused=this.db.prepare('SELECT 1 FROM paused_resources WHERE key IN (?,?)').get(`account:${slot.task.platform}:${slot.task.account_ref}`,`device:${slot.task.device_ref}`);
    if (paused) throw new Error('设备或账号仍处于隔离状态');
    const needsConfirmation=slot.state==='interrupted' || !!slot.result && !['untouched','restored'].includes(slot.result.cleanup);
    const confirmed=this.db.prepare("SELECT 1 FROM events WHERE slot_id=? AND json_extract(payload,'$.code')='cart_empty_confirmed_by_user' AND json_extract(payload,'$.at')>=? LIMIT 1")
      .get(slot.task.slot_id,slot.result?.finished_at ?? '');
    if (needsConfirmation && !confirmed) throw new Error('购物车状态未确认，不能重试');
    const now=new Date(), task={...slot.task,due_at:now.toISOString(),deadline_at:new Date(+now+900_000).toISOString()};
    const result=this.db.prepare("UPDATE slots SET state='queued',due_at=?,deadline_at=?,task_json=?,result_json=NULL,next_attempt_at=NULL WHERE id=? AND state IN ('completed','interrupted','source_blocked')")
      .run(task.due_at,task.deadline_at,JSON.stringify(task),task.slot_id);
    if (!result.changes) throw new Error('任务状态已变化');
  }
  saveJdStore(input:JdStoreInput):JdSavedStore {
    const id=digest([normalize(input.city).replace(/市$/,''),normalize(input.district),jdBrandKey(input.brand),normalize(input.storeName)]);
    const record={...input,id};
    this.db.prepare('INSERT INTO market_jd_stores VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(id,JSON.stringify(record));
    return this.jdStore(id)!;
  }
  private jdStore(id:string):JdSavedStore|undefined {
    const row=this.db.prepare('SELECT payload FROM market_jd_stores WHERE id=?').get(id);
    return row ? read<JdSavedStore>(row.payload) : undefined;
  }
  private jdIdentity(id:string) {
    const entry=this.sources.get('jd')?.entry;
    if (!entry) return undefined;
    const observed=this.db.prepare(`SELECT result_json,task_json FROM slots WHERE json_extract(task_json,'$.jdOrigin.savedStoreId')=?
      AND json_extract(task_json,'$.entry_point')=? AND json_type(result_json,'$.resolvedLive.mapping')='object' ORDER BY due_at DESC LIMIT 1`).get(id,entry);
    if(observed){const r=read<AttemptResult>(observed.result_json);if(r.observation?.details)return {store:r.resolvedLive!.target.supply.store,evidence:r.observation.details.storeEvidence,sourceRevision:r.resolvedLive!.sourceRevision};}
    const row=this.db.prepare(`SELECT result_json,task_json FROM slots WHERE json_type(task_json,'$.shelf.input.savedStoreId')='text'
      AND json_extract(task_json,'$.shelf.input.savedStoreId')=? AND json_extract(task_json,'$.entry_point')=?
      AND state='completed' AND json_type(result_json,'$.shelf')='object' ORDER BY due_at DESC LIMIT 1`).get(id,entry);
    const shelf=row ? read<AttemptResult>(row.result_json).shelf : undefined;
    return shelf ? {store:shelf.store,evidence:shelf.evidence,sourceRevision:read<Task>(row!.task_json).shelf?.sourceRevision??null} : undefined;
  }
  jdStores():JdSavedStore[] {
    return this.db.prepare('SELECT payload FROM market_jd_stores ORDER BY rowid DESC').all().map(row=>{
      const store=read<JdSavedStore>(row.payload);
      return {...store,verified:this.jdIdentity(store.id)};
    });
  }
  startSavedJdRun(input:JdSavedRunInput) {
    if (this.run(input.requestId)) {
      const old=this.legacy.snapshot(input.requestId).slots.find(slot=>slot.task.shelf)?.task.shelf?.input;
      if (old?.savedStoreId===input.savedStoreId && old.profileId===input.profileId) return input.requestId;
      throw new Error('jd_request_conflict');
    }
    const saved=this.jdStore(input.savedStoreId);
    if (!saved) throw new Error('jd_saved_store_missing');
    const anchor=this.jdIdentity(saved.id)?.store;
    const pilot=this.sources.get('jd')?.jdShelf?.pilot;
    const reviewed=pilot?.storeId===saved.id ? pilot : undefined;
    const {city,district,brand,storeName}=saved;
    return this.startJdRun({...input,city,district,brand,storeName,businessAddress:anchor?.address ?? reviewed?.address,
      verifiedStoreKey:anchor?.key,verifiedStoreName:anchor?.name ?? reviewed?.name});
  }
  startSpecifiedRun(input:{requestId:string;targetId:string;profileId:string;couponCheckoutConsent?:{reference:string};platforms?:Platform[]}) {
    const existing=this.run(input.requestId);
    if(existing) {
      const t=this.legacy.snapshot(existing.id).slots[0]?.task;
      if(t?.specified && t.live?.target.id===input.targetId && t.live.profile.id===input.profileId&&t.specified.couponCheckoutConsent?.reference===input.couponCheckoutConsent?.reference)return existing.id;
      throw new Error('jd_request_conflict');
    }
    const entry=this.catalog().find(e=>e.id===input.targetId);
    if(!entry || !catalogEligible(entry))throw new Error('请选择包销标记为是的商品，或明确登记的试采商品');
    const target=this.currentTarget(entry.id), profile=this.get<Profile>('market_profiles',input.profileId);
    if(normalize(profile.city).replace(/市$/,'')!==normalize(entry.city).replace(/市$/,''))throw new Error('配送城市必须与门店城市一致');
    const source=this.sources.get('jd'), now=new Date(), identity=this.jdIdentity(entry.savedStoreId),anchor=identity?.store;
    // 用户确认同城门店价差很小：领券结算授权按品牌+城市生效，不再要求与登记门店编号一致。
    if(input.couponCheckoutConsent&&entry.source!=='trial')throw new Error('领券结算授权只适用于已登记的本机试采门店');
    const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',hour:'numeric',hourCycle:'h23'}).format(now));
    const meal:Meal=hour<16?'lunch':hour<21?'dinner':'night';
    const pilot=source?.jdShelf?.pilot, reviewed=pilot?.storeId===entry.savedStoreId?pilot:undefined;
    const origin:JdRunInput={requestId:input.requestId,profileId:profile.id,savedStoreId:entry.savedStoreId,city:entry.city,district:entry.district,brand:entry.brand,storeName:entry.storeName,
      businessAddress:anchor?.address??reviewed?.address??(target.supply.store.address||undefined),verifiedStoreKey:anchor?.key,verifiedStoreName:anchor?.name??reviewed?.name,
      ...(identity?.sourceRevision&&source?{verifiedContext:{store:identity.store,evidence:identity.evidence,sourceRevision:identity.sourceRevision}}:{})};
    const selected=input.platforms ?? ['jd'];
    const account=profile.eligibility.jd, qualification=profile.storeQualifications?.find(q=>q.platform==='jd'&&q.storeKey===target.supply.store.key);
    const resolvedProfile={...profile,storeQualifications:undefined,eligibility:{jd:account?{...account,storeCustomer:qualification?.customer??'unknown',storeEvidence:qualification?.evidence,storeKey:qualification?.storeKey}:undefined}};
    const task:Task={contract_version:BUSINESS_VERSION,tenant_id:TENANT,source_id:liveSources.jd,slot_id:input.requestId+'_jd',run_id:input.requestId,comparison_group_id:input.requestId,
      platform:'jd',store_id:entry.storeId??entry.savedStoreId,basket_id:target.id,scenario_id:digest([resolvedProfile,entry.revision,source?.entry]),entry_point:source?.entry??'unconfigured',
      account_ref:source?.account??'jd_pending',device_ref:source?.device??'jd_pending',delivery_point_id:profile.point,due_at:now.toISOString(),deadline_at:new Date(+now+(selected.length>1?900_000:210_000)).toISOString(),
      data_mode:'live',fault:'none',max_attempts:1,timeout_seconds:180,requested_fields:['checkout_payable','delivery_fee','packaging_fee'],required_fields:['checkout_payable'],
      allowed_actions:['browse','select_variant','modify_owned_test_cart','read_checkout'],jdOrigin:origin,
      specified:{catalogRevision:entry.revision,source:entry.source,sourceVersion:entry.sourceVersion,...(input.couponCheckoutConsent?{couponCheckoutConsent:{reference:input.couponCheckoutConsent.reference,confirmedAt:now.toISOString()}}:{})},
      live:{target,mapping:this.mapping(target,'jd',source?.entry),profile:resolvedProfile,planName:'指定单品采集',meal,quantity:1,couponPolicy:input.couponCheckoutConsent?'claim_on_checkout':'page_applied',sourceRevision:source?digest(source):null}};
    const peers=selected.filter(p=>p!=='jd').map(platform=>{
      const peerSource=this.sources.get(platform);
      const mapping=this.mapping(target,platform,peerSource?.entry);
      const peerAccount=profile.eligibility[platform];
      const qualification=profile.storeQualifications?.find(q=>q.platform===platform && q.storeKey===mapping?.candidate.supply.store.key);
      const peerProfile={...profile,storeQualifications:undefined,eligibility:{...profile.eligibility,[platform]:peerAccount?{...peerAccount,storeCustomer:qualification?.evidence?qualification.customer:'unknown' as const,storeEvidence:qualification?.evidence,storeKey:qualification?.storeKey}:undefined}};
      return {...task,slot_id:input.requestId+'_'+platform,platform,source_id:liveSources[platform],
        store_id:target.supply.store.key,entry_point:peerSource?.entry??'unconfigured',
        account_ref:peerSource?.account??platform+'_pending',device_ref:peerSource?.device??platform+'_pending',
        deadline_at:new Date(+now+900_000).toISOString(),timeout_seconds:240,
        jdOrigin:undefined,specified:undefined,
        live:{target,mapping,profile:peerProfile,planName:'指定单品采集',meal,quantity:1,couponPolicy:'page_applied',sourceRevision:peerSource?digest(peerSource):null}} satisfies Task;
    });
    this.legacy.createRun({id:input.requestId,scenario:'competition',created_at:now.toISOString(),label:(entry.source==='trial'?'单品试采':'包销品采集')+' · '+entry.itemName,schedule_key:null},[...(selected.includes('jd')?[task]:[]),...peers]);
    return input.requestId;
  }
  startJdRun(input:JdRunInput) {
    const id=input.requestId;
    const existing=this.run(id);
    if (existing) {
      const slot=this.legacy.snapshot(id).slots.find(s=>s.task.shelf);
      if (!slot || digest(slot.task.shelf!.input)!==digest(input)) throw new Error('jd_request_conflict');
      return id;
    }
    const profile=this.get<Profile>('market_profiles',input.profileId);
    if (normalize(profile.city).replace(/市$/,'')!==normalize(input.city).replace(/市$/,'')) throw new Error('配送地址所在城市必须与门店城市一致');
    const source=this.sources.get('jd'), now=new Date();
    const branch=input.savedStoreId ?? digest([input.city,input.district,input.brand,input.storeName,input.businessAddress]);
    const task:Task={
      contract_version:BUSINESS_VERSION,tenant_id:TENANT,source_id:liveSources.jd,slot_id:id+'_shelf',run_id:id,comparison_group_id:id+'_shelf',
      platform:'jd',store_id:branch,basket_id:'jd-shelf:'+branch,scenario_id:digest([profile,source?.entry]),
      entry_point:source?.entry ?? 'unconfigured',account_ref:source?.account ?? 'jd_pending',device_ref:source?.device ?? 'jd_pending',
      delivery_point_id:profile.point,due_at:now.toISOString(),deadline_at:new Date(+now+25*60_000).toISOString(),
      data_mode:'live',fault:'none',max_attempts:1,timeout_seconds:240,requested_fields:[],required_fields:[],allowed_actions:['browse'],
      shelf:{input,profile,sourceRevision:source ? digest(source) : ''}
    };
    const label=source?.jdShelf?.pilot?.directSingle ? '京东单品试采' : '京东爆品';
    this.legacy.createRun({id,scenario:'competition',created_at:now.toISOString(),label:label+' · '+input.storeName,schedule_key:null},[task]);
    return id;
  }
  jdQuoteTasks(task:Task,result:AttemptResult):Task[] {
    if (!task.shelf || !result.shelf) return [];
    const shelf=validateJdShelfResult(result.shelf), {input,profile,sourceRevision}=task.shelf;
    if (!matchesJdStore(input,shelf.store,shelf.district)) throw new Error('invalid_shelf_store');
    const {shelf:_discovery,...base}=task;
    const now=new Date(), hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(now));
    const meal:Meal=hour<16 ? 'lunch' : hour<21 ? 'dinner' : 'night';
    const account=profile.eligibility.jd;
    const storeQualification=profile.storeQualifications?.find(q=>q.platform==='jd' && q.storeKey===shelf.store.key && q.evidence);
    const resolved:Profile={...profile,storeQualifications:undefined,eligibility:account ? {jd:{...account,
      storeCustomer:storeQualification?.customer ?? 'unknown',storeEvidence:storeQualification?.evidence}} : {}};
    return shelf.selected.map((picked,index)=>{
      const group=task.run_id+'_hot_'+(index+1), at=picked.evidence.captured_at;
      const target:Target={id:digest(['jd',picked.supply.store.key,picked.supply.item.key]),revision:digest(picked.supply),supply:picked.supply,reference:picked.evidence.id};
      const exact={relation:'exact',reason:'本次京东货架已核对',missing:[]} as const;
      const mapping:Mapping={id:digest([task.slot_id,picked.key,picked.evidence.id]),targetId:target.id,targetRevision:target.revision,
        candidate:{platform:'jd',entry:task.entry_point,supply:picked.supply,reference:picked.evidence.id,evidence:picked.evidence},
        store:{...exact,missing:[]},item:{...exact,missing:[]},status:'verified',proposedAt:at,reviewedAt:at};
      return {...base,slot_id:group+'_jd',comparison_group_id:group,store_id:shelf.store.key,basket_id:target.id,
        scenario_id:digest([resolved,mapping.id,sourceRevision,meal]),due_at:new Date(+now+index).toISOString(),
        requested_fields:['checkout_payable','delivery_fee','packaging_fee'],required_fields:['checkout_payable'],
        allowed_actions:['browse','select_variant','modify_owned_test_cart','read_checkout'],
        jdShelfParent:task.slot_id,jdOrigin:input,jdItemKey:picked.key,
        live:{target,mapping,profile:resolved,planName:'京东爆品',meal,quantity:1,couponPolicy:'page_applied',sourceRevision}
      };
    });
  }
  run(id:string) {
    return this.db.prepare('SELECT id,scenario,created_at,label,schedule_key FROM runs WHERE id=? AND tenant_id=?').get(id,TENANT) as unknown as RunInfo | undefined;
  }
  runDetails(id:string) {
    const run=this.run(id);
    if (!run || run.scenario!=='competition') return null;
    const {slots,attempts,events}=this.legacy.snapshot(id);
    const journal=this.legacy.attemptSteps(id);
    const quoteHistory=this.legacy.quoteSnapshots(id);
    const state=slots.some(s=>s.state==='running') ? 'running' : slots.some(s=>s.state==='queued') ? 'queued' :
      slots.some(s=>s.state==='interrupted') ? 'interrupted' : 'completed';
    const start=Date.parse(run.created_at);
    const finish=Math.max(start,...attempts.flatMap(a=>a.result ? [Date.parse(a.result.finished_at)] : []),
      ...[...journal.values()].flat().map(step=>Date.parse(step.at)),...events.map(e=>Date.parse(e.at)));
    const first=attempts.length ? Math.min(...attempts.map(a=>Date.parse(a.started_at))) : null;
    const terminal=state==='completed' || state==='interrupted';
    return {run,state,elapsedMs:terminal ? finish-start : null,queueMs:first===null ? null : Math.max(0,first-start),
      executionMs:terminal && first!==null ? Math.max(0,finish-first) : null,shelf:slots.find(s=>s.task.shelf)?.result?.shelf ?? null,
      slots:slots.map(s=>{
        const live=s.result?.resolvedLive??s.task.live, account=live?.profile.eligibility[s.task.platform];
        const conditions=account?.evidence ? [
          account.platformCustomer==='new' ? '平台新客' : account.platformCustomer==='existing' ? '平台老客' : '',
          account.storeCustomer==='new' && account.storeEvidence ? '门店新客' : account.storeCustomer==='existing' && account.storeEvidence ? '门店老客' : '',
          [account.memberSegment,account.memberProduct,account.memberTier].filter(Boolean).join(' ')
        ].filter(Boolean).join(' · ') : '';
        const attemptRows=attempts.filter(a=>a.slot_id===s.task.slot_id).map(a=>({id:a.id,number:a.number,startedAt:a.started_at,
          status:a.result?.status ?? (s.state==='interrupted' ? 'interrupted' : 'running'),error:a.result?.error_code ?? (s.state==='interrupted' ? 'process_interrupted' : null),
          executionMs:a.result?.cost.execution_ms ?? null,
          steps:journal.get(a.id) ?? [],legacyTrace:journal.has(a.id) ? [] : a.result?.trace ?? []}));
        return {id:s.task.slot_id,kind:s.task.shelf ? 'shelf' : 'quote',item:s.task.live?.target.supply.item.name ?? null,
          itemKey:s.task.jdItemKey ?? null,spec:s.task.live?.target.supply.item.spec ?? null,platform:s.task.platform,state:s.state,
          status:s.state==='completed' ? s.result?.status ?? null : null,error:s.block_reason ?? s.result?.error_code ??
            (['window_missed','interrupted','source_blocked'].includes(s.state) ? events.find(e=>e.slot_id===s.task.slot_id)?.code ?? s.state : null),
          cleanup:s.result?.cleanup??null,quoteReadyAt:s.result?.quoteReadyAt??null,timings:s.result?.timings??null,pageMap:s.result?.pageMap??null,
          quoteMs:s.result?.quoteReadyAt?Date.parse(s.result.quoteReadyAt)-start:null,
          context:live ? {couponPolicy:live.couponPolicy,couponConsent:s.task.specified?.couponCheckoutConsent?.reference??null,entry:s.task.entry_point==='unconfigured' ? null : s.task.entry_point,store:live.target.supply.store.name,
            address:live.target.supply.store.address || null,user:conditions || null,delivery:live.profile.point || null,
            quantity:live.quantity,options:live.target.supply.item.options ?? []} : null,
          menuPrices:s.result?.market?.prices ?? [],menuPriceReason:s.result?.menuPriceReason ?? null,availability:s.result?.availability ?? null,
          observation:s.result?.observation ?? null,proof:s.result?.evidence ?? null,attempts:attemptRows,
          // 历史尝试的报价快照：新记录来自 quote_snapshots，旧任务回退到单条 observation。
          quotes:(()=>{
            const history=quoteHistory.get(s.task.slot_id) ?? [];
            if(history.length)return history.map(q=>({attemptId:q.attemptId,createdAt:q.createdAt,amountFen:q.observation.amount_fen,quoteValid:q.observation.quote_valid,
              observedAt:q.observation.observed_at,rawValue:q.observation.raw_value,evidenceRefs:q.observation.evidence_refs}));
            const o=s.result?.observation;
            return o?[{attemptId:o.attempt_id,createdAt:o.collected_at,amountFen:o.amount_fen,quoteValid:o.quote_valid,observedAt:o.observed_at,
              rawValue:o.raw_value,evidenceRefs:o.evidence_refs}]:[];
          })()};
      })};
  }
  materialize(now: Date) {
    for (const p of this.list<StoredPlan>('market_plans').filter(p=>p.enabled)) {
      for (let d=0;d<p.days;d++) {
        const date = new Date(Date.parse(p.startDate+'T00:00:00Z')+d*86_400_000).toISOString().slice(0,10);
        for (const [meal,time] of Object.entries(p.times) as [Meal,string][]) {
          const due = new Date(date+'T'+time+':00+08:00');
          if (+due>+now) continue;
          const key = 'market_'+p.id+':'+p.revision+':'+date+':'+meal;
          if (this.db.prepare('SELECT id FROM runs WHERE id=?').get(key)) continue;
          // Materialize missed slots too, so a stopped process cannot improve coverage.
          try { this.enqueue(p,meal,due,key); } catch(e) { console.error('monitor_plan_invalid',p.id,(e as Error).message); }
        }
      }
    }
  }
  recentRuns(mode: 'live'|'synthetic', includeShelf=true): RunInfo[] {
    const operator = mode==='live' ? '=' : '<>';
    const shelfFilter=includeShelf ? '' : " AND NOT EXISTS(SELECT 1 FROM slots WHERE run_id=runs.id AND json_type(task_json,'$.shelf')='object')";
    return (this.db.prepare("SELECT id,scenario,created_at,label,schedule_key FROM runs WHERE scenario "+operator+" 'competition'"+shelfFilter+
      " ORDER BY created_at DESC,rowid DESC LIMIT 60").all() as unknown as RunInfo[]);
  }
  reviewQuote(observationId:string,decision:QuoteReview['decision'],note:string,minutes:number|null) {
    if (!this.db.prepare("SELECT id FROM observations WHERE id=? AND origin='observed'").get(observationId)) throw new Error('找不到可复核的实际报价');
    if (decision==='disputed' && !note.trim()) throw new Error('请填写发现的差异');
    const review:QuoteReview={observationId,decision,note:note.trim(),minutes,reviewedAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO market_quote_reviews(observation_id,payload) VALUES(?,?)').run(observationId,JSON.stringify(review));
    return review;
  }
  slots(runId: string): Slot[] {
    const query=this.db.prepare('SELECT payload FROM market_quote_reviews WHERE observation_id=? ORDER BY id DESC LIMIT 1');
    return this.legacy.snapshot(runId).slots.map(original=>{
      const slot=original.result?.resolvedLive?{...original,task:{...original.task,live:original.result.resolvedLive}}:original;
      const obs=slot.result?.observation;
      if (!obs || obs.value_origin!=='observed') return slot;
      const review=query.get(obs.observation_id);
      return {...slot,review:review ? read<QuoteReview>(review.payload) : null};
    });
  }
  catalogQuotes(id:string) {
    const entry=this.catalog().find(e=>e.id===id);
    if(!entry)throw new Error('找不到清单商品');
    const runs=this.db.prepare(`SELECT DISTINCT run_id,due_at FROM slots WHERE json_extract(task_json,'$.live.target.id')=? ORDER BY due_at DESC LIMIT 30`).all(id);
    const target=this.currentTarget(id);
    const latest=runs.find(r=>this.legacy.snapshot(String(r.run_id)).slots.some(s=>s.task.live?.target.id===id && s.task.live.target.revision===target.revision))?.run_id as string|undefined;
    const slots=latest?this.slots(latest).filter(s=>s.task.live?.target.id===id):[];
    return {entry,rows:comparisonRows(slots),run:latest?this.runDetails(latest):null,
      history:runs.map(r=>this.run(String(r.run_id))).filter(Boolean)};
  }

  createScreenshotBatch(input:{city?:string;brand?:string;store?:string;item?:string}) {
    const id=randomUUID(), at=new Date().toISOString();
    this.db.prepare('INSERT INTO screenshot_batches(id,created_at,city,brand,store,item) VALUES(?,?,?,?,?,?)')
      .run(id,at,input.city??'',input.brand??'',input.store??'',input.item??'');
    return this.screenshotBatch(id)!;
  }
  screenshotBatch(id:string) {
    const row=this.db.prepare('SELECT * FROM screenshot_batches WHERE id=?').get(id);
    if(!row)return null;
    const quotes=this.db.prepare('SELECT * FROM screenshot_quotes WHERE batch_id=? ORDER BY created_at').all(id).map(r=>this.screenshotQuoteRow(r));
    return {batch:{id:String(row.id),createdAt:String(row.created_at),city:String(row.city),brand:String(row.brand),store:String(row.store),item:String(row.item),status:String(row.status)},quotes};
  }
  screenshotBatches(limit=30) {
    return this.db.prepare('SELECT * FROM screenshot_batches ORDER BY created_at DESC LIMIT ?').all(limit).map(r=>({
      id:String(r.id),createdAt:String(r.created_at),city:String(r.city),brand:String(r.brand),store:String(r.store),item:String(r.item),status:String(r.status),
      count:Number(this.db.prepare('SELECT COUNT(*) n FROM screenshot_quotes WHERE batch_id=?').get(String(r.id))?.n??0),
    }));
  }
  saveScreenshotQuote(record: Record<string,unknown>) {
    const id=String(record.id),batchId=String(record.batchId),platform=String(record.platform),createdAt=String(record.createdAt);
    const filename=String(record.sourceFilename??''),evidenceId=String(record.evidenceId),sha=String(record.imageSha256);
    const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
    const text=(v:unknown)=>typeof v==='string'?v:null;
    this.db.prepare('INSERT INTO screenshot_quotes(id,batch_id,platform,created_at,source_filename,evidence_id,image_sha256,store_name,city,brand,item_name,spec,quantity,payable_fen,subtotal_fen,packaging_fen,delivery_fen,discount_fen,coupons_json,raw_json,confidence,review_status,issues_json,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,batchId,platform,createdAt,filename,evidenceId,sha,
        text(record.storeName),text(record.city),text(record.brand),text(record.itemName),text(record.spec),num(record.quantity),
        num(record.payableFen),num(record.subtotalFen),num(record.packagingFen),num(record.deliveryFen),num(record.discountFen),
        JSON.stringify(record.coupons??[]),JSON.stringify(record.raw??{}),String(record.confidence??'low'),String(record.reviewStatus??'auto'),
        JSON.stringify(record.issues??[]),text(record.error));
    return this.screenshotBatch(batchId);
  }
  updateScreenshotQuote(id:string, patch:Record<string,unknown>) {
    const existing=this.db.prepare('SELECT * FROM screenshot_quotes WHERE id=?').get(id);
    if(!existing)return null;
    const allowed=['store_name','city','brand','item_name','spec','quantity','payable_fen','subtotal_fen','packaging_fen','delivery_fen','discount_fen','review_status'];
    for(const key of allowed){if(Object.prototype.hasOwnProperty.call(patch,key))this.db.prepare('UPDATE screenshot_quotes SET '+key+'=? WHERE id=?').run(patch[key] as never,id);}
    return this.screenshotBatch(String(existing.batch_id));
  }
  deleteScreenshotQuote(id:string) {
    const row=this.db.prepare('SELECT batch_id FROM screenshot_quotes WHERE id=?').get(id);
    if(!row)return null;
    this.db.prepare('DELETE FROM screenshot_quotes WHERE id=?').run(id);
    return this.screenshotBatch(String(row.batch_id));
  }
  screenshotLedger(limit=500) {
    return this.db.prepare('SELECT * FROM screenshot_quotes ORDER BY created_at DESC LIMIT ?').all(limit).map(r=>this.screenshotQuoteRow(r));
  }
  autoLedger(limit=500) {
    const rows=this.db.prepare(`SELECT o.payload observation_json,o.observed_at,s.task_json,o.platform,o.amount_fen FROM observations o JOIN slots s ON s.id=o.slot_id ORDER BY o.observed_at DESC LIMIT ?`).all(limit);
    return rows.map(r=>{
      let observation:any={},task:any={};try{observation=read<any>(r.observation_json);task=read<any>(r.task_json);}catch{}
      const supply=task.live?.target?.supply??{},item=supply.item??{},store=supply.store??{};
      return {id:String(observation.observation_id??''),source:'auto',batchId:String(task.run_id??''),platform:String(r.platform),createdAt:String(r.observed_at),
        city:String(store.city??''),brand:String(store.brand??''),storeName:String(store.name??''),itemName:String(item.name??''),spec:String(item.spec??''),
        quantity:1,payableFen:Number(r.amount_fen),subtotalFen:null,packagingFen:observation.components?.packaging_fee?.amount_fen??null,
        deliveryFen:observation.components?.delivery_fee?.amount_fen??null,discountFen:null,coupons:[],reviewStatus:'auto',
        confidence:observation.detail_complete?'high':'medium',issues:Object.keys(observation.missing_reasons??{}),evidenceId:String(observation.evidence_refs?.[0]?.id??''),error:null};
    });
  }
  screenshotQuoteRow(r:Row) {
    const parse=(v:unknown,fallback:unknown)=>{try{return JSON.parse(String(v));}catch{return fallback;}};
    return {id:String(r.id),source:'screenshot',batchId:String(r.batch_id),platform:String(r.platform),createdAt:String(r.created_at),sourceFilename:String(r.source_filename),
      evidenceId:String(r.evidence_id),imageSha256:String(r.image_sha256),storeName:r.store_name??null,city:r.city??null,brand:r.brand??null,itemName:r.item_name??null,
      spec:r.spec??null,quantity:r.quantity??null,payableFen:r.payable_fen??null,subtotalFen:r.subtotal_fen??null,packagingFen:r.packaging_fen??null,
      deliveryFen:r.delivery_fen??null,discountFen:r.discount_fen??null,coupons:parse(r.coupons_json,[]),raw:parse(r.raw_json,{}),
      confidence:String(r.confidence),reviewStatus:String(r.review_status),issues:parse(r.issues_json,[]),error:r.error??null};
  }
  dbStatus(evidenceRoot:string) {
    const count=(table:string)=>Number(this.db.prepare('SELECT COUNT(*) n FROM '+table).get()?.n??0);
    const size=Number(this.db.prepare('PRAGMA page_count').get()?.page_count??0)*Number(this.db.prepare('PRAGMA page_size').get()?.page_size??0);
    let evidenceCount=0,evidenceBytes=0;
    try{const fs=require('node:fs');for(const f of fs.readdirSync(evidenceRoot)){const st=fs.statSync(evidenceRoot+'/'+f);if(f.endsWith('.png')){evidenceCount++;evidenceBytes+=st.size;}}}catch{}
    return {databaseBytes:size,tables:{runs:count('runs'),slots:count('slots'),observations:count('observations'),quoteSnapshots:count('quote_snapshots'),catalog:count('monitor_catalog'),screenshotBatches:count('screenshot_batches'),screenshotQuotes:count('screenshot_quotes')},
      latestRuns:this.db.prepare('SELECT id,label,created_at FROM runs ORDER BY created_at DESC LIMIT 5').all().map(r=>({id:String(r.id),label:String(r.label),createdAt:String(r.created_at)})),
      latestQuote:this.db.prepare('SELECT MAX(observed_at) at FROM observations').get()?.at??null,
      paused:this.db.prepare('SELECT key,code FROM paused_resources').all(),evidence:{files:evidenceCount,bytes:evidenceBytes}};
  }

  recordModel(row: ModelAudit) {
    this.db.prepare('INSERT INTO market_audit(scope,at,payload) VALUES(?,?,?)').run(row.scope,new Date().toISOString(),JSON.stringify(row));
  }
  modelCalls(scope?: string, limit = 60): ModelAudit[] {
    const rows = scope ? this.db.prepare('SELECT payload FROM market_audit WHERE scope=? ORDER BY id DESC LIMIT ?').all(scope,limit) :
      this.db.prepare('SELECT payload FROM market_audit ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(r=>read<ModelAudit>(r.payload));
  }
  cost(scope: string) {
    const calls = this.modelCalls(scope);
    return calls.length && calls.every(c=>c.yuan !== null) ? calls.reduce((n,c)=>n+c.yuan!,0) : null;
  }
  trialReport() {
    return this.list<StoredPlan>('market_plans',30).map(plan => {
      const prefix = 'market_'+plan.id+':'+plan.revision+':';
      const runs = this.db.prepare('SELECT id FROM runs WHERE substr(schedule_key,1,length(?))=?').all(prefix,prefix);
      const slots = runs.flatMap(r=>this.slots(String(r.id)));
      const attempts = runs.flatMap(r=>this.legacy.snapshot(String(r.id)).attempts);
      const finished = attempts.flatMap(a=>a.result ?? []);
      const modelCost = finished.filter(r=>r.cost.model_yuan!==null).reduce((n,r)=>n+r.cost.model_yuan!,0);
      const costKnown = finished.length > 0 && attempts.every(a=>!this.modelCalls(a.id).length || (!!a.result && a.result.cost.model_yuan!==null)) && finished.some(r=>r.cost.model_yuan!==null);
      const stats = summarizeBatch(slots,comparisonRows(slots));
      const mappingIds = new Set(slots.flatMap(s=>s.task.live?.mapping?.id ?? []));
      const review = [...mappingIds].map(id=>this.get<Mapping>('market_mappings',id).reviewMinutes);
      review.push(...slots.flatMap(slot=>slot.review ? [slot.review.minutes ?? undefined] : []));
      return {id:plan.id,name:plan.name,runs:runs.length,expected:plan.days*Object.keys(plan.times).length*plan.targetIds.length*PLATFORMS.length,
        stats,executionMinutes:finished.reduce((n,r)=>n+r.cost.execution_ms,0)/60_000,manualMinutes:review.length && review.every(v=>v!==undefined) ? review.reduce<number>((n,v)=>n+(v ?? 0),0) : null,
        modelCost:costKnown ? modelCost : null,modelCostPerQuote:costKnown && stats.quoted ? modelCost/stats.quoted : null};
    });
  }
}
