import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {classifyForeground} from '../src/adapters/android-page.js';
import type {AndroidSource} from '../src/adapters/android-source.js';
const file=process.argv[2];if(!file)throw new Error('需要本轮计划路径');
const source=(JSON.parse(await readFile('.runtime/android-sources.json','utf8')) as AndroidSource[]).find(s=>s.platform==='jd')!;
const run=promisify(execFile),events:{at:string;kind:string;activity:string|null}[]=[],begun=Date.now();let samples=0,foreignSamples=0,unknownSamples=0,last='';
while(Date.now()-begun<45*60_000){
  const plan=JSON.parse(await readFile(file,'utf8')) as {plan:{state:string}[]};
  if(plan.plan.every(p=>!['running','planned'].includes(p.state)))break;
  try{
    // This reads window metadata only. It never dumps accessibility XML or touches the screen.
    const {stdout}=await run(process.env.MIDSCENE_ADB_PATH??'adb',['-s',source.device,'shell','dumpsys','window'],{windowsHide:true,timeout:4000,maxBuffer:2_000_000});
    const focus=stdout.split(/\r?\n/).find(l=>/mCurrentFocus=Window/.test(l));
    const component=focus?/[a-zA-Z][\w.]*(?:\.[\w.]+)+\/[\w.$]+/.exec(focus)?.[0]:undefined;
    const packageName=component?.split('/')[0]??null,kind=classifyForeground(packageName,source.package);
    samples++;if(kind==='foreign')foreignSamples++;if(kind==='unknown')unknownSamples++;
    const activity=kind==='target'?component!.split('/')[1]!:null,key=kind+':'+activity;
    if(key!==last){events.push({at:new Date().toISOString(),kind,activity});last=key;}
  }catch{unknownSamples++;}
  await writeFile(file.replace(/\.json$/,'.foreground.json'),JSON.stringify({readOnly:true,intervalMs:5000,samples,foreignSamples,unknownSamples,events},null,2));
  await new Promise(ok=>setTimeout(ok,5000));
}
console.log(JSON.stringify({samples,foreignSamples,unknownSamples,file:file.replace(/\.json$/,'.foreground.json')}));
