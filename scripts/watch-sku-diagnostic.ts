import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import type {AndroidSource} from '../src/adapters/android-source.js';
import type {CollectionRun} from '../src/ui/jd-runs.js';
const source=(JSON.parse(await readFile('.runtime/android-sources.json','utf8')) as AndroidSource[]).find(s=>s.platform==='jd')!,run=promisify(execFile);
const base='http://127.0.0.1:4318',end=Date.now()+180_000;
const waiting=(report:CollectionRun)=>{const steps=report.slots[0]?.attempts[0]?.steps??[],started=steps.findLast(s=>s.phase==='sku_match'&&s.state==='started');return report.state==='running'&&started&&!steps.some(s=>s.phase==='sku_match'&&s.state!=='started')&&!steps.some(s=>s.phase==='cart_add_intent')&&Date.now()-Date.parse(started.at)>10_000;};
while(Date.now()<end){
  const records=await (await fetch(base+'/api/market/records')).json() as {run?:{id:string}};
  if(records.run){const id=records.run.id,report=await (await fetch(base+'/api/market/runs/'+id)).json() as CollectionRun;
    if(waiting(report)){
      const {stdout:window}=await run(process.env.MIDSCENE_ADB_PATH??'adb',['-s',source.device,'shell','dumpsys','window','windows'],{timeout:4000,windowsHide:true});
      if(!window.split(/\r?\n/).some(line=>/mCurrentFocus/.test(line)&&line.includes(source.package)))throw new Error('当前前台不是京东，未保存诊断图片');
      const {stdout}=await run(process.env.MIDSCENE_ADB_PATH??'adb',['-s',source.device,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:20_000_000,timeout:8000,windowsHide:true});
      const after=await (await fetch(base+'/api/market/runs/'+id)).json() as CollectionRun;
      if(waiting(after)){const meta=await sharp(stdout).metadata(),image=await sharp(stdout).extract({left:0,top:Math.round(meta.height!*.25),width:meta.width!,height:Math.round(meta.height!*.66)}).png().toBuffer();
        const file=`artifacts/specified-pilot/${id}-sku-diagnostic.png`;await writeFile(file,image);console.log(JSON.stringify({id,file,phase:'sku_match',readOnly:true}));break;}
    }
  }
  await new Promise(ok=>setTimeout(ok,1000));
}
