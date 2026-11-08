import { chromium, type Browser } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export function executablePath(): string | undefined {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured) {
    if (!existsSync(configured)) throw new Error('配置的 Chromium 不存在');
    return configured;
  }
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA,'ms-playwright');
  if (cache && existsSync(cache)) {
    for (const dir of readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => Number(b.split('-')[1])-Number(a.split('-')[1]))) {
      for (const sub of ['chrome-win64','chrome-win']) {
        const p = join(cache,dir,sub,'chrome.exe');
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('未找到独立测试 Chromium，请运行 npm run browser:install');
}
export class BrowserPool {
  private pending: Promise<Browser> | undefined;
  get(): Promise<Browser> {
    this.pending ??= chromium.launch({ headless: true, executablePath: executablePath() }).then(b => {
      b.on('disconnected',() => { this.pending = undefined; }); return b;
    }).catch(e => { this.pending = undefined; throw e; });
    return this.pending;
  }
  async close(): Promise<void> { const b = await this.pending; this.pending = undefined; await b?.close(); }
}
