import test from 'node:test';
import assert from 'node:assert/strict';
import {withDeviceLock,deviceQueueLength} from '../src/adapters/device-lock.js';

test('等待设备期间取消的任务不会在拿锁后操作手机',async()=>{
  let release!:()=>void, started!:()=>void, touched=false;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const first=withDeviceLock('first',async()=>{started();await held;});
  await ready;
  const controller=new AbortController();
  const second=withDeviceLock('second',async()=>{touched=true;},controller.signal);
  controller.abort(); release();
  await first;
  await assert.rejects(second,{name:'AbortError'});
  assert.equal(touched,false);
  assert.equal(deviceQueueLength(),0);
});
