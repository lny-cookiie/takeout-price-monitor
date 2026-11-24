import { mkdir, readFile, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createApplication } from './http/app.js';
const dataDir = resolve(process.env.DATA_DIR ?? '.runtime');
await mkdir(dataDir,{recursive:true});
const lockPath = join(dataDir,'process.lock');
async function acquire() {
  try { const f = await open(lockPath,'wx'); await f.writeFile(String(process.pid)); await f.close(); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const pid = Number(await readFile(lockPath,'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('进程锁无效，请先人工确认没有旧采集器运行');
    try { process.kill(pid,0); throw new Error(`数据目录正被进程 ${pid} 使用，不能并发启动`); }
    catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
    await unlink(lockPath); const f = await open(lockPath,'wx'); await f.writeFile(String(process.pid)); await f.close();
  }
}
await acquire();
try {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  const app = await createApplication({dataDir,port,host});
  console.log(`包销 UE 与外卖竞争监测 v0.4.4 · ${app.baseUrl}`);
  let stopping = false;
  const stop = () => { if (stopping) return; stopping=true; void app.close().then(() => unlink(lockPath)).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); }); };
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
} catch(e) { await unlink(lockPath).catch(() => {}); throw e; }
