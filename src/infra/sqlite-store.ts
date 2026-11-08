import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { checkResult, TENANT, validateTask, type Task, type Slot, type Platform, type AttemptResult, type Observation, type AttemptStep, type StepUpdate } from '../domain/contracts.js';
import type { CollectionStore, RunInfo, Schedule, Snapshot, Claimed, Event } from '../application/ports.js';

type Row = Record<string, unknown>;
const json = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const accountKey = (t: Task) => `account:${t.platform}:${t.account_ref}`;
const deviceKey = (t: Task) => `device:${t.device_ref}`;
const safeStepText=(value:string)=>value.slice(0,500).replace(/https?:\/\/\S+/gi,'[链接已隐藏]')
  .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[手机号已隐藏]').replace(/<[^>]*>/g,'');
function safeStepValue(value:unknown, depth=0):unknown {
  if (typeof value==='string') return safeStepText(value);
  if (typeof value==='boolean' || (typeof value==='number' && Number.isFinite(value))) return value;
  if (!value || typeof value!=='object' || depth>=4) return null;
  if (Array.isArray(value)) return value.slice(0,30).map(item=>safeStepValue(item,depth+1));
  return Object.fromEntries(Object.entries(value).slice(0,30)
    .filter(([key])=>/^[a-zA-Z_][a-zA-Z_0-9]{0,60}$/.test(key) && !/password|cookie|credential|auth|token|xml|prompt|serial|recipient|delivery_?address|raw_?screen/i.test(key))
    .map(([key,item])=>[key,safeStepValue(item,depth+1)]));
}
export class SqliteStore implements CollectionStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scenario TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT NOT NULL, schedule_key TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), platform TEXT NOT NULL, state TEXT NOT NULL, due_at TEXT NOT NULL, deadline_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, task_json TEXT NOT NULL CHECK(json_valid(task_json)), result_json TEXT);
      CREATE INDEX IF NOT EXISTS slot_queue ON slots(platform,state,due_at);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES slots(id), number INTEGER NOT NULL, started_at TEXT NOT NULL, result_json TEXT, UNIQUE(slot_id,number));
      CREATE TABLE IF NOT EXISTS attempt_steps(attempt_id TEXT NOT NULL REFERENCES attempts(id), seq INTEGER NOT NULL, phase TEXT NOT NULL,
        state TEXT NOT NULL, at TEXT NOT NULL, elapsed_ms INTEGER, data_json TEXT, error_code TEXT, evidence_json TEXT NOT NULL,
        PRIMARY KEY(attempt_id,seq));
      INSERT OR IGNORE INTO migrations VALUES(4);
      CREATE TABLE IF NOT EXISTS locks(key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paused_resources(key TEXT PRIMARY KEY, code TEXT NOT NULL, paused_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY, slot_id TEXT NOT NULL UNIQUE REFERENCES slots(id), tenant_id TEXT NOT NULL, platform TEXT NOT NULL, store_id TEXT NOT NULL, basket_id TEXT NOT NULL, scenario_id TEXT NOT NULL, origin TEXT NOT NULL, observed_at TEXT NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen>=0), payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE INDEX IF NOT EXISTS observation_history ON observations(tenant_id,platform,store_id,basket_id,scenario_id,origin,observed_at);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), slot_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);
    for (const s of [ { id: 'lunch', meal: '午市', time: '11:30', enabled: false, scenario: 'baseline' }, { id: 'dinner', meal: '晚市', time: '17:30', enabled: false, scenario: 'baseline' }, { id: 'night', meal: '夜宵', time: '21:30', enabled: false, scenario: 'baseline' } ].map(s => ({...s,enabled_since:null,revision:1})) as Schedule[]) this.db.prepare('INSERT OR IGNORE INTO schedules VALUES(?,?)').run(s.id, JSON.stringify(s));
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(task: Task, kind: string, code: string, details: Record<string, unknown> = {}) {
    const e: Event = { id: randomUUID(), run_id: task.run_id, slot_id: task.slot_id, platform: task.platform, kind, code, at: new Date().toISOString(), details };
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(e.id,e.run_id,e.slot_id,JSON.stringify(e));
  }
  private pauseReason(task: Task): string | undefined {
    const row=this.db.prepare('SELECT code FROM paused_resources WHERE key IN (?,?) ORDER BY paused_at,key LIMIT 1').get(accountKey(task),deviceKey(task));
    return row?.code as string | undefined;
  }
  private blockSlot(task: Task, reason: string, details: Record<string,unknown> = {}) {
    this.db.prepare("UPDATE slots SET state='source_blocked',next_attempt_at=NULL WHERE id=?").run(task.slot_id);
    this.event(task,'collection',reason,details);
  }
  createRun(run: RunInfo, tasks: Task[]): boolean {
    tasks.forEach(validateTask);
    return this.transaction(() => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO runs VALUES(?,?,?,?,?,?)').run(run.id,TENANT,run.scenario,run.created_at,run.label,run.schedule_key);
      if (!inserted.changes) return false;
      const insert = this.db.prepare("INSERT INTO slots(id,run_id,platform,state,due_at,deadline_at,task_json) VALUES(?,?,?,'queued',?,?,?)");
      for (const t of tasks) {
        insert.run(t.slot_id,run.id,t.platform,t.due_at,t.deadline_at,JSON.stringify(t));
        const reason=this.pauseReason(t);
        if (reason) this.blockSlot(t,reason);
      }
      return true;
    });
  }
  expire(now: string): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM slots WHERE state='queued' AND deadline_at<?").all(now) as Row[];
      for (const row of rows) {
        this.db.prepare("UPDATE slots SET state='window_missed' WHERE id=?").run(String(row.id));
        this.event(json<Task>(row.task_json),'collection','window_missed');
      }
    });
  }
  claim(platform: Platform, now: string, mode: Task['data_mode'] = 'synthetic'): Claimed | null {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM slots WHERE state='queued' AND platform=? AND json_extract(task_json,'$.data_mode')=? AND due_at<=? AND deadline_at>? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY due_at,id LIMIT 100").all(platform,mode,now,now,now) as Row[];
      for (const r of rows) {
        const task = json<Task>(r.task_json);
        const keys = [accountKey(task),deviceKey(task)];
        const reason=this.pauseReason(task);
        if (reason) { this.blockSlot(task,reason); continue; }
        if (keys.some(k => this.db.prepare('SELECT key FROM locks WHERE key=?').get(k))) continue;
        const attemptId = randomUUID(), attemptNumber = Number(r.attempts) + 1;
        for (const k of keys) this.db.prepare('INSERT INTO locks VALUES(?,?)').run(k,attemptId);
        this.db.prepare("UPDATE slots SET state='running',attempts=? WHERE id=?").run(attemptNumber,task.slot_id);
        this.db.prepare('INSERT INTO attempts(id,slot_id,number,started_at) VALUES(?,?,?,?)').run(attemptId,task.slot_id,attemptNumber,now);
        return { task, attempt_id: attemptId, attempt_number: attemptNumber };
      }
      return null;
    });
  }
  recordStep(claim:Claimed,event:StepUpdate):void {
    if (!this.db.prepare('SELECT 1 FROM locks WHERE attempt_id=?').get(claim.attempt_id)) throw new Error('lease_lost');
    this.writeStep(claim.attempt_id,event);
  }
  private writeStep(attemptId:string,event:Omit<StepUpdate,'state'> & {state:AttemptStep['state']}) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(event.phase)) throw new Error('invalid_step_phase');
    const at=new Date().toISOString();
    const latest=event.state==='started' ? undefined : this.db.prepare('SELECT state,at FROM attempt_steps WHERE attempt_id=? AND phase=? ORDER BY seq DESC LIMIT 1').get(attemptId,event.phase);
    const elapsed=latest?.state==='started' ? Math.max(0,Date.parse(at)-Date.parse(String(latest.at))) : null;
    const ids=(event.evidenceIds ?? []).filter(id=>/^[a-f0-9-]{36}$/.test(id)).slice(0,30);
    const error=event.errorCode && /^[a-z][a-z0-9_]{0,100}$/.test(event.errorCode) ? event.errorCode : event.errorCode ? 'step_failed' : null;
    const data=event.data ? JSON.stringify(safeStepValue(event.data)) : null;
    this.db.prepare(`INSERT INTO attempt_steps SELECT ?,coalesce(max(seq),0)+1,?,?,?,?,?,?,? FROM attempt_steps WHERE attempt_id=?`)
      .run(attemptId,event.phase,event.state,at,elapsed,data,error,JSON.stringify(ids),attemptId);
  }
  private closeOpenSteps(attemptId:string,state:AttemptStep['state'],errorCode?:string) {
    const rows=this.db.prepare(`SELECT phase FROM attempt_steps AS a WHERE attempt_id=? AND state='started'
      AND seq=(SELECT max(seq) FROM attempt_steps AS b WHERE a.attempt_id=b.attempt_id AND a.phase=b.phase)`).all(attemptId);
    for (const {phase} of rows) this.writeStep(attemptId,{phase:String(phase),state,errorCode});
  }
  attemptSteps(runId:string) {
    const byAttempt=new Map<string,AttemptStep[]>();
    const rows=this.db.prepare(`SELECT a.* FROM attempt_steps a JOIN attempts b ON a.attempt_id=b.id JOIN slots s ON b.slot_id=s.id
      WHERE s.run_id=? ORDER BY a.attempt_id,a.seq`).all(runId);
    for (const r of rows) {
      const id=String(r.attempt_id), list=byAttempt.get(id) ?? [];
      list.push({phase:String(r.phase),state:r.state as AttemptStep['state'],at:String(r.at),elapsedMs:r.elapsed_ms===null ? null : Number(r.elapsed_ms),
        data:r.data_json===null ? null : json(r.data_json),errorCode:r.error_code===null ? null : String(r.error_code),evidenceIds:json(r.evidence_json)});
      byAttempt.set(id,list);
    }
    return byAttempt;
  }
  finish(claim: Claimed, result: AttemptResult, retryAt: string | null, following:Task[]=[]): void {
    const { task, attempt_id: aid } = claim;
    checkResult(task,result);
    if (following.length!==(result.shelf?.selected.length ?? 0) || following.length && (!task.shelf || retryAt ||
      following.some((t,i)=>t.jdShelfParent!==task.slot_id || t.run_id!==task.run_id || t.shelf || t.jdItemKey!==result.shelf!.selected[i]?.key)))
      throw new Error('invalid_shelf_following');
    following.forEach(validateTask);
    this.transaction(() => {
      const row = this.db.prepare('SELECT result_json FROM attempts WHERE id=? AND slot_id=?').get(aid,task.slot_id) as Row | undefined;
      if (!row || row.result_json !== null) return; // At-most-one publish per claimed attempt.
      if (!this.db.prepare('SELECT key FROM locks WHERE attempt_id=?').get(aid)) throw new Error('lease_lost');
      this.closeOpenSteps(aid,result.status==='blocked' ? 'blocked' : ['failed','unavailable'].includes(result.status) ? 'failed' : 'succeeded',result.error_code ?? undefined);
      const o = result.observation;
      if (o && o.attempt_id!==aid) throw new Error('observation_attempt_mismatch');
      if (o && o.quote_valid) {
        const previous = this.db.prepare('SELECT payload FROM observations WHERE tenant_id=? AND platform=? AND store_id=? AND basket_id=? AND scenario_id=? AND origin=? ORDER BY observed_at DESC LIMIT 1').get(TENANT,o.platform,o.store_id,o.basket_id,o.scenario_id,o.value_origin) as Row | undefined;
        this.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(o.observation_id,task.slot_id,TENANT,o.platform,o.store_id,o.basket_id,o.scenario_id,o.value_origin,o.observed_at,o.amount_fen,JSON.stringify(o));
        if (previous) {
          const before = json<Observation>(previous.payload);
          if (before.amount_fen !== o.amount_fen) this.event(task,'business','price_changed',{ before_fen: before.amount_fen, after_fen: o.amount_fen, delta_fen: o.amount_fen-before.amount_fen, before_observation_id: before.observation_id, after_observation_id: o.observation_id });
        }
      }
      const quarantine=result.cleanup==='quarantined';
      const pause=quarantine || ['captcha_required','access_restricted','rate_limited','cart_not_owned'].includes(result.error_code ?? '');
      const retry=pause ? null : retryAt;
      this.db.prepare('UPDATE attempts SET result_json=? WHERE id=?').run(JSON.stringify(result),aid);
      this.db.prepare('UPDATE slots SET state=?,result_json=?,next_attempt_at=? WHERE id=?').run(retry ? 'queued' : 'completed',JSON.stringify(result),retry,task.slot_id);
      const insert=this.db.prepare("INSERT INTO slots(id,run_id,platform,state,due_at,deadline_at,task_json) VALUES(?,?,?,'queued',?,?,?)");
      for (const t of following) {
        insert.run(t.slot_id,t.run_id,t.platform,t.due_at,t.deadline_at,JSON.stringify(t));
        const reason=this.pauseReason(t);
        if (reason) this.blockSlot(t,reason);
      }
      if (result.status !== 'success') this.event(task,result.status === 'unavailable' ? 'business' : 'collection',result.error_code ?? result.status,{ status: result.status, retry_scheduled: Boolean(retry) });
      if (pause) this.pauseScope(task,'scope_paused_after_'+(result.error_code ?? 'cleanup_failed'),quarantine && task.data_mode==='live');
      this.db.prepare('DELETE FROM locks WHERE attempt_id=?').run(aid);
    });
  }
  private pauseScope(task: Task, code: string, pauseDevice: boolean): void {
    const at=new Date().toISOString();
    const insert=this.db.prepare('INSERT OR IGNORE INTO paused_resources VALUES(?,?,?)');
    insert.run(accountKey(task),code,at);
    if (pauseDevice) insert.run(deviceKey(task),code,at);
    for (const r of this.db.prepare("SELECT task_json FROM slots WHERE state='queued'").all()) {
      const t=json<Task>(r.task_json);
      if (accountKey(t)===accountKey(task) || (pauseDevice && deviceKey(t)===deviceKey(task)))
        this.blockSlot(t,code,{caused_by_slot_id:task.slot_id});
    }
  }
  resetFixtureSessions(): void {
    // Only an explicit manual test can reset owned synthetic sessions. Live scopes are never changed.
    this.db.prepare('DELETE FROM paused_resources WHERE key IN (?,?)').run('account:meituan:fixture_meituan_wallet_1','account:taobao_instant:fixture_taobao_instant_wallet_1');
  }
  recoverInterrupted(): number {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT task_json FROM slots WHERE state='running'").all() as Row[];
      for (const r of rows) {
        const t = json<Task>(r.task_json);
        const attempt=this.db.prepare('SELECT id FROM attempts WHERE slot_id=? AND result_json IS NULL ORDER BY number DESC LIMIT 1').get(t.slot_id);
        if (attempt) this.closeOpenSteps(String(attempt.id),'interrupted','process_interrupted');
        this.db.prepare("UPDATE slots SET state='interrupted' WHERE id=?").run(t.slot_id);
        if (t.data_mode==='live' && !t.shelf) this.pauseScope(t,'process_interrupted',true);
        this.event(t,'collection','process_interrupted');
      }
      this.db.exec('DELETE FROM locks');
      return rows.length;
    });
  }
  async withDevice<T>(platform: Platform, account: string, device: string, action: () => Promise<T>) {
    const id = randomUUID(), keys = [`account:${platform}:${account}`,`device:${device}`];
    this.transaction(() => {
      for (const key of keys) {
        if (this.db.prepare('SELECT key FROM paused_resources WHERE key=?').get(key)) throw new Error('设备或账号已暂停，需要核对运行记录');
        if (this.db.prepare('SELECT key FROM locks WHERE key=?').get(key)) throw new Error('设备正在采集，请稍后读取');
        this.db.prepare('INSERT INTO locks VALUES(?,?)').run(key,id);
      }
    });
    try { return await action(); }
    finally { this.db.prepare('DELETE FROM locks WHERE attempt_id=?').run(id); }
  }
  schedules(): Schedule[] { return (this.db.prepare('SELECT payload FROM schedules ORDER BY id').all() as Row[]).map(r => json<Schedule>(r.payload)); }
  saveSchedule(s: Schedule): void { this.db.prepare('INSERT INTO schedules VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(s.id,JSON.stringify(s)); }
  cancelSchedule(id: string): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT s.task_json FROM slots s JOIN runs r ON r.id=s.run_id WHERE substr(r.schedule_key,1,length(?))=? AND s.state='queued'").all(id+':',id+':') as Row[];
      for (const r of rows) {
        const t = json<Task>(r.task_json);
        this.db.prepare("UPDATE slots SET state='cancelled' WHERE id=?").run(t.slot_id);
        this.event(t,'collection','schedule_cancelled');
      }
    });
  }
  snapshot(runId?: string): Snapshot {
    const runs = (this.db.prepare('SELECT * FROM runs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50').all(TENANT) as Row[]).map(r => ({ id: String(r.id), scenario: String(r.scenario), created_at: String(r.created_at), label: String(r.label), schedule_key: r.schedule_key as string | null })) as RunInfo[];
    const selected = runId ?? runs[0]?.id ?? null;
    const rows = selected ? this.db.prepare('SELECT * FROM slots WHERE run_id=? ORDER BY due_at,platform,id').all(selected) as Row[] : [];
    const slots: Slot[] = rows.map(r => ({ task: json<Task>(r.task_json), state: String(r.state), attempts: Number(r.attempts), result: r.result_json ? json<AttemptResult>(r.result_json) : null, next_attempt_at: r.next_attempt_at as string | null }));
    const events = selected ? (this.db.prepare('SELECT payload FROM events WHERE run_id=? ORDER BY rowid DESC').all(selected) as Row[]).map(r => json<Event>(r.payload)) : [];
    const latestEvents = new Map(events.slice().reverse().map(e=>[e.slot_id,e.code]));
    for (const slot of slots) {
      if (slot.state==='source_blocked' || slot.state==='interrupted') slot.block_reason=latestEvents.get(slot.task.slot_id);
    }
    const observations = selected ? (this.db.prepare('SELECT o.payload FROM observations o JOIN slots s ON s.id=o.slot_id WHERE s.run_id=?').all(selected) as Row[]).map(r => json<Observation>(r.payload)) : [];
    const attempts = selected ? (this.db.prepare('SELECT a.* FROM attempts a JOIN slots s ON a.slot_id=s.id WHERE s.run_id=? ORDER BY a.started_at').all(selected) as Row[]).map(r => ({ id: String(r.id), slot_id: String(r.slot_id), number: Number(r.number), result: r.result_json ? json<AttemptResult>(r.result_json) : null, started_at: String(r.started_at) })) : [];
    return { runs, selected_run_id: selected, slots, events, observations, schedules: this.schedules(), attempts };
  }
  close(): void { this.db.close(); }
}
