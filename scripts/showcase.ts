// Populate the local workbench through the real scheduler and browser, not by inserting quotes.
const base=new URL(process.env.APP_URL ?? 'http://127.0.0.1:4318');
if(base.hostname!=='127.0.0.1' || base.protocol!=='http:')throw new Error('showcase_requires_loopback');
for(const scenario of ['baseline','mixed','price_change']){
  const r=await fetch(new URL('/api/runs',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario})});
  const created=await r.json();if(!r.ok)throw new Error(JSON.stringify(created));
  const deadline=Date.now()+120_000;let complete=false;
  while(Date.now()<deadline){
    const s=await(await fetch(new URL('/api/state?run='+encodeURIComponent(created.run_id),base))).json();
    if(s.slots.length===12 && s.slots.every((slot:{state:string})=>!['queued','running'].includes(slot.state))){
      console.log(scenario,'slots:',s.slots.length,'valid_quotes:',s.observations.length,'events:',s.events.length);complete=true;break;
    }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!complete)throw new Error('showcase_timeout:'+scenario);
}
console.log('Open',base.href,'— all prices are synthetic; actual browser traces are retained.');
