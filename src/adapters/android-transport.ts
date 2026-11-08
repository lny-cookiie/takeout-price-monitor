import { execFile } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { AndroidDevice } from '@midscene/android';
import type { UITreeSnapshot } from '@midscene/core';
import { CollectionError } from '../domain/contracts.js';
import { AndroidUiTreeReader } from './android-uitree.js';
import type { AndroidSource } from './android-source.js';

const run=promisify(execFile);
const adb=()=>process.env.MIDSCENE_ADB_PATH || 'adb';
export async function requireAndroidForeground(shell:()=>Promise<string>,target:string,signal:AbortSignal){
  for(let attempt=0;attempt<3;attempt++){
    signal.throwIfAborted();
    const dump=await shell(),line=dump.split(/\r?\n/).find(value=>/mCurrentFocus=Window/.test(value));
    const component=line?/[a-zA-Z][\w.]*(?:\.[\w.]+)+\/[\w.$]+/.exec(line)?.[0]:undefined;
    if(component?.split('/')[0]===target)return;
    if(component)throw new CollectionError('target_app_not_foreground','blocked');
    if(attempt<2)await wait(150,undefined,{signal});
  }
  throw new CollectionError('foreground_state_unknown','blocked');
}
export async function deviceInventory(signal?:AbortSignal) {
  try {
    const {stdout}=await run(adb(),['devices'],{timeout:5000,windowsHide:true,signal});
    const devices=stdout.split(/\r?\n/).flatMap(line=>{
      const result=/^([A-Za-z0-9_.:-]{1,80})\s+(device|unauthorized|offline|recovery|sideload)\s*$/.exec(line);
      return result ? [{serial:result[1]!,state:result[2]!}] : [];
    });
    return {adb:true,devices,connected:devices.filter(d=>d.state==='device').length,error:null};
  } catch(e) {
    const installed=(e as NodeJS.ErrnoException).code!=='ENOENT';
    return {adb:installed,devices:[],connected:0,error:installed ? 'adb_failed' : 'adb_unavailable'};
  }
}
export async function installedAppVersion(serial:string,packageName:string,signal?:AbortSignal) {
  const {stdout}=await run(adb(),['-s',serial,'shell','dumpsys','package',packageName],{timeout:8000,windowsHide:true,signal});
  return /^\s*versionName=(.+)$/m.exec(stdout)?.[1]?.trim() ?? null;
}
export interface AndroidSession {
  getUITree():Promise<UITreeSnapshot>;
  size():Promise<{width:number;height:number}>;
  launch(reset?:boolean):Promise<void>;
  tap(x:number,y:number):Promise<void>;
  search(text:string,signal:AbortSignal,submit?:boolean):Promise<void>;
  swipe?(from:{x:number;y:number},to:{x:number;y:number},signal:AbortSignal):Promise<void>;
  back():Promise<void>;
  screenshot(signal:AbortSignal):Promise<Buffer>;
  close():Promise<void>;
}
export type AndroidTransport = (source:AndroidSource,signal:AbortSignal)=>Promise<AndroidSession>;

export async function prepareAndroidDisplay(shell: (args:string[])=>Promise<string>,signal:AbortSignal) {
  const awake = async () => {
    signal.throwIfAborted();
    const power=await shell(['dumpsys','power']);
    return /^\s*mWakefulness(?:Raw)?=Awake\s*$/m.test(power);
  };
  let isAwake=await awake();
  if (!isAwake) {
    signal.throwIfAborted();
    await shell(['input','keyevent','KEYCODE_WAKEUP']);
  }
  const deadline=Date.now()+3500;
  do {
    if (!isAwake) isAwake=await awake();
    if (isAwake) {
      signal.throwIfAborted();
      const policy=await shell(['dumpsys','window','policy']);
      const screen=/^\s*screenState=(SCREEN_STATE_\w+)\s*$/m.exec(policy)?.[1];
      if (!screen || screen==='SCREEN_STATE_ON') {
        const showing=/^[ \t]*KeyguardServiceDelegate:?[ \t]*\r?\n[ \t]*showing=(true|false)[ \t]*\r?$/m.exec(policy)?.[1]
          ?? /^\s*(?:mShowingLockscreen|mKeyguardShowing|mIsShowing)=(true|false)\s*$/m.exec(policy)?.[1];
        if (showing==='true') throw new CollectionError('device_screen_locked','blocked');
        if (showing!=='false') throw new CollectionError('device_lock_state_unknown','blocked');
        return;
      }
    }
    await wait(200,undefined,{signal});
  } while (Date.now()<deadline);
  throw new CollectionError('device_wake_failed');
}

export const connectAndroid:AndroidTransport=async (source,signal)=>{
  const status=await deviceInventory(signal);
  if (status.error) throw new CollectionError(status.error);
  const selected=status.devices.find(d=>d.serial===source.device);
  if (selected?.state==='unauthorized') throw new CollectionError('device_unauthorized','blocked');
  if (selected?.state!=='device') throw new CollectionError('device_unavailable');
  const args=['-s',source.device];
  const version=await installedAppVersion(source.device,source.package,signal);
  if (version!==source.appVersion) throw new CollectionError('app_version_changed','blocked');
  signal.throwIfAborted();
  const device=new AndroidDevice(source.device,{exposeRunAdbShellAction:false,alwaysRefreshScreenInfo:false});
  // 常驻读屏：u2 server 单次读取 0.1-0.3 秒，明显快于 uiautomator dump（每次约 2.7 秒）。
  // 服务不可用或初始化失败时静默回退到 Midscene 的 dump 链路，保证功能不受影响。
  let treeReader: Promise<AndroidUiTreeReader|null>|null=null;
  const getTreeReader=()=>treeReader ??= AndroidUiTreeReader.create({serial:source.device,adbPath:adb()}).catch(()=>null);
  const beforeInput=()=>{
    // Cart restoration owns a separate deadline after collection is cancelled.
    const inputSignal=AbortSignal.timeout(5000);
    return requireAndroidForeground(async()=>{
      const {stdout}=await run(adb(),[...args,'shell','dumpsys','window'],{timeout:4000,windowsHide:true,signal:inputSignal});return stdout;
    },source.package,inputSignal);
  };
  return {
    getUITree:async()=>{
      const reader=await getTreeReader();
      if(reader){
        try{return await reader.read();}
        catch{/* 常驻服务异常时回退到原始 dump 链路 */}
      }
      return device.getUITree();
    },
    size:()=>device.size(),
    async launch(reset=false){
      await prepareAndroidDisplay(async command=>{
        const {stdout}=await run(adb(),[...args,'shell',...command],{timeout:4000,windowsHide:true,signal});
        return stdout;
      },signal);
      signal.throwIfAborted();
      if(reset)await device.terminate(source.package);
      signal.throwIfAborted();
      await device.launch(source.package);
    },
    async tap(x,y){await beforeInput();await device.inputPrimitives.pointer.tap({x,y});},
    async swipe(from,to,signal) {
      signal.throwIfAborted();
      await beforeInput();
      await device.inputPrimitives.touch.swipe(from,to,{duration:450});
    },
    async search(text,signal,submit=true) {
      await beforeInput();
      await device.inputPrimitives.keyboard.typeText(text,{replace:true,autoDismissKeyboard:false});
      signal.throwIfAborted();
      if (submit){await beforeInput();await device.inputPrimitives.keyboard.keyboardPress('Enter');}
    },
    async back(){await beforeInput();await device.back();},
    async screenshot(signal) {
      // Standard Android screencap respects protected windows.
      const {stdout}=await run(adb(),[...args,'exec-out','screencap','-p'],{encoding:'buffer',timeout:8000,maxBuffer:20_000_000,windowsHide:true,signal});
      return stdout;
    },
    async close() {
      await run(adb(),[...args,'shell','rm','-f','/sdcard/midscene_window_dump.xml'],{timeout:4000,windowsHide:true}).catch(()=>undefined);
      await device.destroy().catch(()=>undefined);
    }
  };
};
