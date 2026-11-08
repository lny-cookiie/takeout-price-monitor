import { FIXTURE_PLATFORMS } from '../domain/contracts.js';
import type { Snapshot } from './ports.js';
export function summarize(data: Snapshot) {
  return FIXTURE_PLATFORMS.map(platform => {
    const slots = data.slots.filter(s => s.task.platform === platform);
    const valid = slots.filter(s => s.result?.observation?.quote_valid).length;
    const unavailable = slots.filter(s => s.result?.status === 'unavailable').length;
    return { platform, planned:slots.length, valid_quotes:valid, unavailable, determined:valid+unavailable,
      blocked:slots.filter(s => s.state === 'source_blocked' || s.result?.status === 'blocked').length,
      failed:slots.filter(s => ['window_missed','interrupted'].includes(s.state) || (s.state === 'completed' && s.result?.status === 'failed')).length,
      waiting:slots.filter(s => s.state === 'queued').length, running:slots.filter(s => s.state === 'running').length,
      partial:slots.filter(s => s.result?.status === 'partial').length,
      coverage:slots.length ? valid/slots.length : 0,
      attempts:data.attempts.filter(a => slots.some(s => s.task.slot_id === a.slot_id)).length
    };
  });
}
