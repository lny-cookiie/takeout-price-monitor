import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {EvidenceStore} from '../src/infra/evidence.js';

test('不同尝试的证据独立保存，可按编号读取并核对摘要',async()=>{
  const store=new EvidenceStore(await mkdtemp(join(tmpdir(),'quote-evidence-')));
  const png1=await sharp({create:{width:20,height:20,channels:3,background:'#ffffff'}}).png().toBuffer();
  const png2=await sharp({create:{width:20,height:20,channels:3,background:'#000000'}}).png().toBuffer();
  const a=await store.save(randomUUID(),'checkout',png1,'','live');
  const b=await store.save(randomUUID(),'checkout',png2,'','live');
  assert.notEqual(a.screenshot,b.screenshot);
  assert.notEqual(a.sha256,b.sha256);
  assert.equal(createHash('sha256').update(await store.read(a.id,'png')).digest('hex'),a.sha256);
  assert.deepEqual(await store.read(b.id,'png'),png2);
});
