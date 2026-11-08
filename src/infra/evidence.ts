import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Evidence } from '../domain/contracts.js';
import { redactSensitive } from '../domain/competition.js';
export class EvidenceStore {
  constructor(readonly root: string) {}
  async capture(page: Page, id: string, stage: string): Promise<Evidence> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid_evidence_id');
    const text = await page.locator('body').innerText({ timeout: 2000 });
    if (text.trim().length < 30) throw new Error('evidence_unavailable');
    const captured = new Date().toISOString();
    const png = await page.screenshot({ fullPage: true, timeout: 5000, animations: 'disabled' });
    if (!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('evidence_unavailable');
    return this.save(id, stage, png, text, 'synthetic', captured);
  }
  async save(id: string, stage: string, png: Buffer, text: string, mode: 'synthetic' | 'live', captured = new Date().toISOString()): Promise<Evidence> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid_evidence_id');
    if (!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('evidence_unavailable');
    await mkdir(this.root,{ recursive: true });
    const sha256 = createHash('sha256').update(png).digest('hex');
    await writeFile(join(this.root,`${id}.png`),png,{ flag: 'wx' });
    await writeFile(join(this.root,`${id}.json`),JSON.stringify({ data_mode: mode, captured_at: captured, page_stage: stage, text: redactSensitive(text), sha256 },null,2),{ flag: 'wx' });
    return { id, sha256, screenshot: `/api/evidence/${id}.png`, text_file: `/api/evidence/${id}.json`, captured_at: captured, page_stage: stage };
  }
  async read(id: string, extension: string): Promise<Buffer> {
    if (!/^[a-f0-9-]{36}$/.test(id) || !['png','json'].includes(extension)) throw new Error('invalid_evidence_id');
    return readFile(join(this.root,`${id}.${extension}`));
  }
}
