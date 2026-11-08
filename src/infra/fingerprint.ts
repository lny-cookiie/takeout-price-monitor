import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
export function sourceFingerprint(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): string[] => readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(join(dir,e.name)) : /\.(ts|js|css|html)$/.test(e.name) && e.name !== 'app.js' ? [join(dir,e.name)] : []);
  for (const file of [...walk(join(root,'src')),...walk(join(root,'public')),join(root,'package.json')].sort()) hash.update(relative(root,file)).update(readFileSync(file));
  return hash.digest('hex');
}
