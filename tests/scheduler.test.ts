import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/infra/sqlite-store.js';
import { tasksFor, Scheduler, dayInShanghai } from '../src/application/scheduler.js';
import { summarize } from '../src/application/summary.js';
import type { AttemptResult } from '../src/domain/contracts.js';

function fixture() { const dir=mkdtempSync(join(tmpdir(),'observatory-unit-')); return {store:new SqliteStore(join(dir,'test.sqlite')),dir}; }
const failure=():AttemptResult=>({status:'failed',error_code:'network_error',availability:'unknown',observation:null,trace:[],evidence:null,started_at:new Date().toISOString(),finished_at:new Date().toISOString(),cleanup:'untouched',cost:{model_yuan:null,execution_ms:1}});
function seed(store:SqliteStore,id='run',at=new Date(Date.now()-10_000)) {const tasks=tasksFor(id,'baseline',at,100);store.createRun({id,scenario:'baseline',created_at:at.toISOString(),label:'unit',schedule_key:null},tasks);return tasks;}
test('相同计划幂等，同账号互斥，两平台可独立执行，重试不扩大分母',()=>{
  const {store,dir}=fixture();try {
    seed(store);seed(store);assert.equal(store.snapshot().slots.length,12);
    const c=store.claim('meituan',new Date().toISOString())!;assert.ok(c);assert.equal(store.claim('meituan',new Date().toISOString()),null);
    assert.ok(store.claim('taobao_instant',new Date().toISOString()));
    store.finish(c,failure(),new Date().toISOString());store.finish(c,failure(),null);
    const retry=store.claim('meituan',new Date().toISOString())!;assert.equal(retry.task.slot_id,c.task.slot_id);assert.equal(retry.attempt_number,2);
    store.finish(retry,failure(),null);
    const view=store.snapshot();assert.equal(view.slots.length,12);assert.equal(view.attempts.filter(a=>a.slot_id===c.task.slot_id).length,2);
    assert.equal(summarize(view)[0]!.planned,6);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
test('错过餐期只留漏采；进程重启不重新加购，历史与失败不丢失',()=>{
  const {store,dir}=fixture();let reopened:SqliteStore|undefined;
  try {
    seed(store,'old',new Date(Date.now()-600_000));store.expire(new Date().toISOString());
    assert.equal(store.snapshot('old').slots.filter(s=>s.state==='window_missed').length,12);assert.equal(store.snapshot('old').attempts.length,0);
    seed(store,'active');assert.ok(store.claim('meituan',new Date().toISOString()));store.close();
    reopened=new SqliteStore(join(dir,'test.sqlite'));assert.equal(reopened.recoverInterrupted(),1);
    assert.equal(reopened.snapshot('active').slots.filter(s=>s.state==='interrupted').length,1);
    assert.equal(reopened.snapshot('old').slots.length,12);assert.equal(reopened.snapshot('active').attempts.length,1);
  } finally {reopened?.close();rmSync(dir,{recursive:true,force:true});}
});
test('上海时区、餐期配对、48 小时计划去重、关闭计划保留取消记录',()=>{
  const {store,dir}=fixture();try {
    assert.equal(dayInShanghai(new Date('2026-11-04T23:30:00Z')),'2026-11-05');
    const scheduler=new Scheduler(store,[]),s=store.schedules().find(s=>s.id==='lunch')!;
    store.saveSchedule({...s,enabled:true,enabled_since:'2026-11-05T00:00:00.000Z'});
    const now=new Date('2026-11-05T03:00:00.000Z');scheduler.materialize(now);const before=store.snapshot().runs.length;scheduler.materialize(now);assert.equal(store.snapshot().runs.length,before);
    const run=store.snapshot().runs.find(r=>r.schedule_key==='lunch:1:2026-11-05')!;const slots=store.snapshot(run.id).slots;
    assert.equal(slots.length,12);assert.equal(new Set(slots.map(s=>s.task.comparison_group_id)).size,6);
    for(const id of new Set(slots.map(s=>s.task.comparison_group_id))) assert.equal(new Set(slots.filter(s=>s.task.comparison_group_id===id).map(s=>s.task.due_at)).size,1);
    assert.equal(new Date(slots[0]!.task.due_at).toISOString(),'2026-11-05T03:30:00.000Z');
    store.cancelSchedule('lunch');assert.equal(store.snapshot(run.id).slots.filter(s=>s.state==='cancelled').length,12);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
test('访问限制暂停同会话剩余任务，业务无报价仍在计划分母',()=>{
  const {store,dir}=fixture();try {
    seed(store);const c=store.claim('meituan',new Date().toISOString())!;
    const blocked={...failure(),status:'blocked' as const,error_code:'captcha_required'};
    store.db.exec("CREATE TRIGGER fail_pause BEFORE INSERT ON paused_resources BEGIN SELECT RAISE(ABORT,'test pause write failure'); END");
    assert.throws(()=>store.finish(c,blocked,null),/test pause write failure/);
    const before=store.snapshot();
    assert.equal(before.attempts[0]?.result,null);
    assert.equal(before.slots.find(s=>s.task.slot_id===c.task.slot_id)?.state,'running');
    assert.equal(store.claim('meituan',new Date().toISOString()),null);
    store.db.exec('DROP TRIGGER fail_pause');
    store.finish(c,blocked,null);
    const s=summarize(store.snapshot())[0]!;assert.equal(s.blocked,6);assert.equal(s.planned,6);assert.equal(store.claim('meituan',new Date().toISOString()),null);
    seed(store,'future');assert.equal(store.snapshot('future').slots.filter(s=>s.task.platform==='meituan' && s.state==='source_blocked' && s.block_reason==='scope_paused_after_captcha_required').length,6);
    store.resetFixtureSessions();seed(store,'new-manual');assert.ok(store.claim('meituan',new Date().toISOString()));
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('取消比较组：排队任务标记取消并写入事件记录',()=>{
  const {store,dir}=fixture();try {
    seed(store,'cancelqueued');
    const cancelled=store.cancelQueued('cancelqueued');
    assert.equal(cancelled,12);
    const view=store.snapshot('cancelqueued');
    assert.equal(view.slots.filter(s=>s.state==='cancelled').length,12);
    assert.equal(view.events.filter(e=>e.code==='run_cancelled').length,12);
    assert.equal(store.cancelQueued('cancelqueued'),0);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('取消比较组：正在执行的采集被中止，随后按取消记录结果',async()=>{
  const {store,dir}=fixture();try {
    seed(store,'cancelrun');
    const collector={
      platform:'meituan' as const, mode:'synthetic' as const,
      collect: async () => { throw new Error('blocked collector should be interrupted'); },
      close: () => undefined,
    };
    const blocking={
      platform:'meituan' as const, mode:'synthetic' as const,
      collect: (task:unknown, attemptId:unknown, signal:AbortSignal) => new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      close: () => undefined,
    };
    const scheduler=new Scheduler(store,[blocking as never]);
    scheduler.tick(new Date());
    await new Promise(r=>setTimeout(r,30));
    const result=scheduler.cancelRun('cancelrun');
    assert.equal(result.queued,11);
    assert.equal(result.running,1);
    for (let i=0;i<40 && store.snapshot('cancelrun').slots.some(s=>s.state==='running');i++) await new Promise(r=>setTimeout(r,25));
    const view=store.snapshot('cancelrun');
    assert.equal(view.slots.filter(s=>s.state==='cancelled').length,11);
    const finished=view.slots.find(s=>s.state==='completed');
    assert.equal(finished?.result?.error_code,'cancelled');
    void collector;
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
