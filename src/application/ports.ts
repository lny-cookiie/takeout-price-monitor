import type { AttemptResult, Observation, Platform, Scenario, Slot, StepUpdate, Task } from '../domain/contracts.js';
export interface RunInfo { id: string; scenario: Scenario | 'competition'; created_at: string; label: string; schedule_key: string | null }
export interface Event { id: string; run_id: string; slot_id: string; platform: Platform; kind: string; code: string; at: string; details: Record<string, unknown> }
export interface Schedule { id: string; meal: string; time: string; enabled: boolean; scenario: Scenario; enabled_since: string | null; revision: number }
export interface AttemptInfo { id: string; slot_id: string; number: number; result: AttemptResult | null; started_at: string }
export interface Snapshot { runs: RunInfo[]; selected_run_id: string | null; slots: Slot[]; events: Event[]; observations: Observation[]; schedules: Schedule[]; attempts: AttemptInfo[] }
export interface Claimed { task: Task; attempt_id: string; attempt_number: number }
export interface CollectionStore {
  createRun(run: RunInfo, tasks: Task[]): boolean;
  expire(now: string): void;
  claim(platform: Platform, now: string, mode?: Task['data_mode']): Claimed | null;
  finish(claim: Claimed, result: AttemptResult, retryAt: string | null, following?:Task[]): void;
  recordStep?(claim:Claimed,event:StepUpdate):void;
  resetFixtureSessions(): void;
  recoverInterrupted(): number;
  snapshot(runId?: string): Snapshot;
  schedules(): Schedule[];
  saveSchedule(schedule: Schedule): void;
  cancelSchedule(id: string): void;
  close(): void;
}
