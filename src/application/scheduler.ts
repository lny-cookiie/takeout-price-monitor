import { randomUUID } from 'node:crypto';
import { checkResult, CollectionError, FIXTURE_PLATFORMS, SCENARIOS, type Collector, type Scenario, type Task, type AttemptResult, type StepSink } from '../domain/contracts.js';
import { STORES, makeTask } from '../domain/catalog.js';
import type { CollectionStore, Schedule } from './ports.js';

export const scenarioLabels: Record<Scenario,string> = { baseline: '正常采集', mixed: '异常组合', price_change: '涨价 2 元', network_retry: '网络失败后重试', cart_conflict: '购物车归属冲突', zero_quote: '真实零元语义（模拟）' };
export function dayInShanghai(date: Date): string {
  const p = new Intl.DateTimeFormat('en-CA',{ timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date);
  const part = (name: string) => p.find(t => t.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function tasksFor(runId: string, scenario: Scenario, start: Date, groupGapMs: number): Task[] {
  let group = 0;
  return STORES.flatMap(store => store.baskets.flatMap(basket => {
    const due = new Date(start.getTime()+group++*groupGapMs);
    return FIXTURE_PLATFORMS.map(platform => makeTask(runId,platform,store,basket.id,scenario,due,`${runId}_g${group}`));
  }));
}
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private working = new Map<string,Promise<void>>();
  private controllers = new Set<AbortController>();
  private stopping = false;
  constructor(private store: CollectionStore, private collectors: Collector[], readonly intervalMs = 750, private materializeLive?: (now: Date) => void,
    private following?: (task: Task,result: AttemptResult)=>Task[]) {}
  createManual(scenario: Scenario, delaySeconds = 0): string {
    if (!SCENARIOS.includes(scenario) || !Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 120) throw new Error('invalid_run_request');
    const id = randomUUID(), now = new Date();
    this.store.resetFixtureSessions();
    const start = new Date(now.getTime()+delaySeconds*1000);
    this.store.createRun({ id, scenario, created_at: now.toISOString(), label: `${scenarioLabels[scenario]} · 手动测试`, schedule_key: null },tasksFor(id,scenario,start,500));
    return id;
  }
  updateSchedule(id: string, time: string, enabled: boolean): void {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || typeof enabled !== 'boolean') throw new Error('invalid_schedule');
    const old = this.store.schedules().find(s => s.id === id);
    if (!old) throw new Error('unknown_schedule');
    if (old.time === time && old.enabled === enabled) return;
    this.store.cancelSchedule(id);
    this.store.saveSchedule({ ...old, time, enabled, enabled_since: enabled ? new Date().toISOString() : null, revision: old.revision+1 });
  }
  materialize(now: Date): void {
    for (const s of this.store.schedules().filter(s => s.enabled && s.enabled_since)) {
      for (const offset of [-1,0,1,2]) {
        const date = dayInShanghai(new Date(now.getTime()+offset*86_400_000));
        const start = new Date(`${date}T${s.time}:00+08:00`);
        if (start.getTime() < Date.parse(s.enabled_since!) || start.getTime() > now.getTime()+48*3_600_000) continue;
        const key = `${s.id}:${s.revision}:${date}`, id = `schedule_${key}`;
        this.store.createRun({ id, scenario: s.scenario, created_at: start.toISOString(), label: `${s.meal}定时 · ${date} ${s.time}`, schedule_key: key },tasksFor(id,s.scenario,start,10*60_000));
      }
    }
  }
  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.error('scheduler_tick_failed',e); } },this.intervalMs);
    this.tick();
  }
  tick(now = new Date()): void {
    if (this.stopping) return;
    this.materialize(now); this.materializeLive?.(now); this.store.expire(now.toISOString());
    for (const collector of this.collectors) {
      const workerKey = (collector.mode ?? 'synthetic') + ':' + collector.platform;
      if (this.working.has(workerKey)) continue;
      const claim = this.store.claim(collector.platform,now.toISOString(),collector.mode ?? 'synthetic');
      if (!claim) continue;
      const controller = new AbortController(); this.controllers.add(controller);
      const duration = Math.max(1,Math.min(claim.task.timeout_seconds*1000,Date.parse(claim.task.deadline_at)-Date.now()));
      const timeout = setTimeout(() => controller.abort(),duration);
      const work = (async () => {
        const audited=claim.task.data_mode==='live';
        const emit:StepSink|undefined=audited && this.store.recordStep ? event=>this.store.recordStep!(claim,event) : undefined;
        const startedAt=new Date().toISOString();
        let result: AttemptResult, children:Task[]=[];
        let collected:AttemptResult|undefined;
        let failure='collector_crashed';
        try {
          emit?.({phase:'worker',state:'started'});
          result=collected=await collector.collect(claim.task,claim.attempt_id,controller.signal,claim.attempt_number,emit);
          failure='invalid_shelf_result';
          children=this.following?.(claim.task,result) ?? [];
          failure='invalid_collection_result';
          checkResult(claim.task,result);
        } catch (e) {
          children=[];
          const at=new Date().toISOString();
          if(e instanceof CollectionError)failure=e.code;
          result={status:'failed',error_code:failure,availability:'unknown',observation:null,trace:[{phase:'stop',at,note:audited ? failure : String(e).slice(0,200)}],
            evidence:collected?.evidence??null,market:collected?.market,menuPriceReason:collected?.menuPriceReason,timings:collected?.timings,
            started_at:startedAt,finished_at:at,cleanup:collected?.cleanup??(claim.task.shelf ? 'untouched' : 'quarantined'),cost:{model_yuan:collected?.cost.model_yuan??null,execution_ms:Date.parse(at)-Date.parse(startedAt)}};
        }
        clearTimeout(timeout);
        const canRetry = result.error_code === 'network_error' && result.cleanup !== 'quarantined' && claim.attempt_number < claim.task.max_attempts && Date.parse(claim.task.deadline_at)-Date.now() > 5_000;
        try {
          emit?.({phase:'worker',state:result.status==='success' || result.status==='partial' ? 'succeeded' : result.status==='blocked' ? 'blocked' : 'failed',errorCode:result.error_code ?? undefined,
            data:{availability:result.availability,cleanup:result.cleanup},evidenceIds:result.evidence ? [result.evidence.id] : []});
          this.store.finish(claim,result,canRetry ? new Date(Date.now()+1000).toISOString() : null,children);
        } catch(e) { console.error('publish_failed',e); /* Keep the claimed slot and its locks until a controlled restart. */ }
      })().finally(() => { clearTimeout(timeout); this.controllers.delete(controller); this.working.delete(workerKey); });
      this.working.set(workerKey,work);
    }
  }
  async stop(): Promise<void> {
    this.stopping = true; clearInterval(this.timer);
    for (const c of this.controllers) c.abort();
    await Promise.allSettled(this.working.values());
  }
}
