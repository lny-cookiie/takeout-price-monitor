import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {deviceInventory,installedAppVersion,prepareAndroidDisplay} from '../src/adapters/android-transport.js';
import {modelConfig} from '../src/infra/model.js';
import type {AndroidSource} from '../src/adapters/android-source.js';
const run=promisify(execFile),path='.runtime/android-sources.json';
const sources=JSON.parse(await readFile(path,'utf8')) as AndroidSource[];
const jd=sources.find(s=>s.platform==='jd');if(!jd)throw new Error('京东入口未登记');
const inventory=await deviceInventory();
const selected=inventory.devices.find(d=>d.serial===jd.device);
const summary:Record<string,unknown>={connected:selected?.state==='device',deviceState:selected?.state??'absent'};
if(selected?.state==='device'){
  summary.appVersion=await installedAppVersion(jd.device,jd.package);
  try{await prepareAndroidDisplay(async args=>(await run(process.env.MIDSCENE_ADB_PATH??'adb',['-s',jd.device,'shell',...args],{windowsHide:true,timeout:5000})).stdout,AbortSignal.timeout(12_000));summary.unlocked=true;}catch(e){summary.unlocked=false;summary.displayError=(e as Error).message;}
}
const cfg=modelConfig();summary.model=cfg?.model??null;
if(cfg){summary.modelPort=new URL(cfg.baseUrl).port;try{const r=await fetch(cfg.baseUrl+'/models',{headers:{Authorization:'Bearer '+cfg.key},signal:AbortSignal.timeout(4000)});summary.modelReachable=r.ok;}catch{summary.modelReachable=false;}}
if(process.argv.includes('--register-local-pilot')){
  if(!summary.connected||!summary.unlocked||summary.appVersion!==jd.appVersion)throw new Error('手机或版本未通过检查，未变更来源登记');
  jd.access={...jd.access,reviewedBy:'项目负责人（聊天中确认的京东员工）',reference:'用户明确授权本机麦当劳天津鞍山西道店单品试采；仅此设备和已登记账号，不代表平台生产书面许可。2026-11-08复测',expiresAt:new Date(Date.now()+12*3600_000).toISOString()};
  await writeFile(path,JSON.stringify(sources,null,2));summary.localPilotRegistered=true;
}
console.log(JSON.stringify(summary));
