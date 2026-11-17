import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createApplication} from '../src/http/app.js';
import {BrowserPool} from '../src/infra/browser.js';

const root=process.cwd(),dir=resolve(root,'artifacts/ue');
await mkdir(dir,{recursive:true});
const app=await createApplication({root,dataDir:await mkdtemp(join(tmpdir(),'ue-ui-')),port:0,startScheduler:false,model:null});
const pool=new BrowserPool(),browser=await pool.get();
const context=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true});
const page=await context.newPage(),errors:string[]=[],results:{name:string;passed:boolean;detail:string}[]=[];
page.on('pageerror',e=>errors.push(e.message));
const nav=async(id:string)=>{await page.locator(`.nav [data-id="${id}"]`).click();await page.locator('h1').waitFor();};
const action=(id:string)=>page.locator(`[data-action="${id}"]`);
const dialog=page.locator('#drawer');
const tableRows=()=>page.locator('main .data-table tbody tr');
const selectScope=async(key:string,value:string)=>{await page.selectOption(`[data-scope="${key}"]`,value);await page.waitForTimeout(90);};
const reset=async()=>{await page.locator('.scopebar [data-action="reset-filter"]').click();await page.waitForTimeout(90);};
async function check(name:string,fn:()=>Promise<void>){try{await fn();results.push({name,passed:true,detail:'通过'});console.log('PASS',name);}catch(e){results.push({name,passed:false,detail:String(e)});await page.screenshot({path:join(dir,'failure.png'),fullPage:true});throw e;}}
async function close(){if(await dialog.isVisible())await dialog.locator('[data-action="close"]').click();}
try{
  await page.goto(app.baseUrl+'/ue');
  await check('默认天津总览：KPI、矩阵和 12 个分组',async()=>{
    assert.equal(await page.locator('h1').textContent(),'经营总览');
    assert.match(await page.locator('.kpis').innerText(),/4,506/);
    assert.equal(await page.locator('.matrix tbody tr').count(),3);
    assert.equal(await page.locator('.matrix thead th').count(),5);
    assert.equal(await tableRows().count(),12);
    assert.match(await page.locator('main .data-table thead').innerText(),/城市 \/ 商圈/);
    assert.doesNotMatch(await page.locator('main .data-table thead').innerText(),/合同\/有效周期/);
    await page.screenshot({path:join(dir,'01-overview.png'),fullPage:true});
  });
  await check('总览矩阵筛选、分组下钻和订单凭据',async()=>{
    await page.locator('[data-action="matrix"][data-id="before|老客|午市"]').click();
    assert.equal(await tableRows().count(),1);
    await action('unit-drill').click();
    assert.equal(await page.locator('h1').textContent(),'商品诊断');
    assert.equal(await tableRows().count(),2);
    await action('sku').first().click();
    assert.match(await dialog.innerText(),/补贴前亏损/);
    assert.match(await dialog.innerText(),/平台单均收益/);
    await dialog.locator('[data-action="detail-tab"][data-id="orders"]').click();
    assert.match(await dialog.innerText(),/成交形态 · 分开统计/);
    await dialog.locator('[data-action="order"]').first().click();
    assert.match(await dialog.innerText(),/完成订单计入统计/);
    assert.match(await dialog.innerText(),/订单号：/);
    assert.match(await dialog.innerText(),/凭据编号：/);
    await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);
  });
  await check('城市、商圈、品类和流量入口贯穿各页',async()=>{
    await nav('overview');await reset();
    assert.equal(await tableRows().count(),12);
    await selectScope('city','北京');
    assert.equal(await tableRows().count(),4);
    assert.match(await page.locator('.kpis').innerText(),/858/);
    assert.match(await tableRows().first().innerText(),/北京/);
    assert.match(await tableRows().first().innerText(),/望京/);
    await selectScope('area','望京');assert.equal(await tableRows().count(),4);
    await selectScope('city','天津');assert.equal(await page.locator('[data-scope="area"]').inputValue(),'全部');
    assert.equal(await tableRows().count(),12);
    await selectScope('category','饮品');assert.equal(await tableRows().count(),4);
    await selectScope('city','全部');assert.equal(await tableRows().count(),8);
    await selectScope('category','全部');assert.equal(await tableRows().count(),24);
    await reset();assert.equal(await page.locator('[data-scope="city"]').inputValue(),'天津');assert.equal(await tableRows().count(),12);
    await selectScope('tier','一线');
    assert.equal(await page.locator('[data-scope="city"]').inputValue(),'全部');
    assert.equal(await tableRows().count(),4);
    await reset();
  });
  await check('诊断页跟随城市，诊断筛选只筛商品',async()=>{
    await nav('overview');await selectScope('city','北京');await nav('diagnosis');
    assert.equal(await tableRows().count(),4);
    assert.match(await tableRows().first().innerText(),/北京/);
    await page.locator('[data-key="diagnosis"][data-id="subsidy"]').click();await page.waitForTimeout(90);
    assert.equal(await tableRows().count(),2);
    await page.locator('[data-key="diagnosis"][data-id="全部"]').click();await page.waitForTimeout(90);
    assert.equal(await tableRows().count(),4);
    await page.screenshot({path:join(dir,'02-diagnosis-city.png'),fullPage:true});
    await nav('strategy');
    assert.equal(await page.locator('[name="sku"] option').count(),4);
    assert.match(await page.locator('.action-summary').innerText(),/北京/);
    assert.match(await page.locator('.action-summary').innerText(),/望京/);
    await nav('data');
    await page.locator('[data-action="data-tab"][data-id="catalogue"]').click();
    assert.equal(await tableRows().count(),4);
    await selectScope('category','饮品');
    assert.ok((await page.locator('[data-scope="brand"] option').allTextContents()).includes('茶小满'));
    assert.equal(await tableRows().count(),4);
    await reset();
  });
  await check('包销范围只读：无登记/编辑，非包销显示原因',async()=>{
    await nav('data');await page.locator('[data-action="data-tab"][data-id="catalogue"]').click();await reset();
    assert.equal(await tableRows().count(),24);
    assert.equal(await page.locator('[data-action="registry-edit"]').count(),0);
    assert.equal(await page.getByRole('button',{name:/登记/}).count(),0);
    assert.doesNotMatch(await page.locator('main').innerText(),/合同\/有效周期/);
    assert.match(await page.locator('main').innerText(),/未计入/);
    assert.match(await page.locator('main').innerText(),/内部清单标记为非包销/);
    assert.equal(await page.locator('[data-action="data-tab"][data-id="catalogue"]').innerText(),'示例包销范围');
    await page.screenshot({path:join(dir,'07-scope.png'),fullPage:true});
  });
  await check('成本缺失和订单不足阻止策略，零值与未知区分',async()=>{
    await nav('diagnosis');
    await page.locator('[data-action="sku"][data-id="BX009"]').click();
    assert.match(await dialog.innerText(),/食材成本缺失/);
    assert.equal(await dialog.locator('[data-action="strategy-sku"]').isDisabled(),true);await close();
    await page.locator('[data-action="sku"][data-id="BX012"]').click();
    assert.match(await dialog.innerText(),/订单不足/);
    assert.equal(await dialog.locator('[data-action="strategy-sku"]').isDisabled(),true);await close();
  });
  await check('同品报价资格和时差不符时不计算，凭据保留',async()=>{
    await page.locator('[data-action="sku"][data-id="BX002"]').click();
    await dialog.locator('[data-action="detail-tab"][data-id="competition"]').click();
    assert.match(await dialog.innerText(),/用户、会员或券资格未对齐/);
    assert.match(await dialog.innerText(),/观察时间差超过 5 分钟/);
    await dialog.locator('[data-action="quote-evidence"]').first().click();
    assert.match(await dialog.locator('pre').innerText(),/示例数据/);await close();
    await page.locator('[data-action="sku"][data-id="BX001"]').click();
    await dialog.locator('[data-action="detail-tab"][data-id="competition"]').click();
    assert.match(await dialog.innerText(),/成交形态不同/);
    await page.screenshot({path:join(dir,'03-competition-evidence.png')});await close();
  });
  await check('多品优惠分摊逐分守恒',async()=>{
    await action('allocation').click();await dialog.locator('[name="total"]').fill('0.01');
    await dialog.locator('#allocation-form button').click();
    assert.match(await dialog.locator('#allocation-result').innerText(),/0.00 \+ 0.01 \+ 0.00 = 0.01/);await close();
  });
  await check('空筛选、重置和导出当前诊断结果',async()=>{
    await page.locator('[data-search]').fill('不存在的商品');await page.waitForTimeout(350);
    assert.match(await page.locator('main').innerText(),/没有符合条件的记录/);
    await reset();
    await page.locator('[data-key="diagnosis"][data-id="subsidy"]').click();await page.waitForTimeout(90);
    const rows=await tableRows().count();
    const downloadEvent=page.waitForEvent('download');await action('export').click();const download=await downloadEvent;
    const file=join(dir,'filtered-export.csv');await download.saveAs(file);const csv=await readFile(file,'utf8');
    assert.match(csv,/示例数据/);assert.match(csv,/UE-V1-demo/);assert.equal(csv.trim().split('\r\n').length,rows+1);
    await page.locator('[data-key="diagnosis"][data-id="全部"]').click();await page.waitForTimeout(90);
  });
  await check('双角色审批、执行回填、刷新恢复和人工回滚',async()=>{
    await nav('execution');await action('task').first().click();
    assert.doesNotMatch(await dialog.innerText(),/模拟|演示/);
    await page.screenshot({path:join(dir,'08-task.png')});
    assert.equal(await dialog.locator('#execute-form button').isDisabled(),true);
    await dialog.locator('[data-role]').selectOption('业务负责人');await dialog.locator('[data-action="approve-business"]').click();
    assert.equal(await dialog.locator('#execute-form button').isDisabled(),true);
    await dialog.locator('[data-role]').selectOption('财务');await dialog.locator('[data-action="approve-finance"]').click();
    await dialog.locator('[data-role]').selectOption('运营执行');
    assert.equal(await dialog.locator('#execute-form button').isDisabled(),false);
    await dialog.locator('[name="executor"]').fill('本地测试执行人');await dialog.locator('[name="evidence"]').fill('DEMO-AFTER-CHECK');
    await dialog.locator('#execute-form button').click();
    assert.match(await dialog.innerText(),/已执行/);assert.match(await dialog.innerText(),/DEMO-AFTER-CHECK/);
    await page.screenshot({path:join(dir,'05-execution-audit.png')});await close();
    await page.reload();await page.locator('h1').waitFor();await action('task').first().click();
    assert.match(await dialog.innerText(),/DEMO-AFTER-CHECK/);
    await dialog.locator('[data-role]').selectOption('运营执行');
    await dialog.locator('[name="reason"]').fill('差评异常，恢复原配置。');
    await dialog.locator('#rollback-form [name="evidence"]').fill('DEMO-ROLLBACK-CHECK');await dialog.locator('#rollback-form button').click();
    assert.match(await dialog.innerText(),/已回滚/);assert.match(await dialog.innerText(),/DEMO-ROLLBACK-CHECK/);await close();
  });
  await check('仿真预算阻断、老客基线缺失和创建任务',async()=>{
    await nav('strategy');await page.locator('[name="sku"]').selectOption('BX001');
    assert.equal(await action('create-task').isDisabled(),false);
    await page.locator('[name="budget"]').fill('1');await page.locator('[name="budget"]').press('Tab');
    assert.match(await page.locator('main').innerText(),/情景补贴支出超过预算/);assert.equal(await action('create-task').isDisabled(),true);
    await page.locator('[name="budget"]').fill('500');await page.locator('[name="budget"]').press('Tab');
    await page.locator('[name="oldOnly"]').check();assert.match(await page.locator('main').innerText(),/缺少仅老客情景的基线/);
    await page.locator('[name="oldOnly"]').uncheck();assert.equal(await action('create-task').isDisabled(),false);
    await page.screenshot({path:join(dir,'04-simulation.png'),fullPage:true});
    await action('create-task').click();
    assert.match(await dialog.innerText(),/ACT-DEMO-002/);
    assert.match(await dialog.innerText(),/当前时间不在活动生效窗口内/);
    assert.equal(await dialog.locator('#execute-form button').isDisabled(),true);
    await dialog.locator('[name="notice"]').fill('2026-11-13T12:00');
    await dialog.locator('[name="exitRecord"]').fill('退出申请由运营当日处理。');
    await dialog.locator('#task-settings button').click();
    assert.match(await dialog.innerText(),/告知到生效时间未满 7 天/);await close();
  });
  await check('复盘不伪造实际效果，反馈回到策略页',async()=>{
    await nav('review');assert.match(await page.locator('main').innerText(),/实际订单结果未接入/);
    await page.locator('#ue-toast').evaluate(e=>e.textContent='');
    await page.screenshot({path:join(dir,'09-review.png'),fullPage:true});
    await page.locator('[name="note"]').fill('缺少完整 30 日复购，延长观察，不作因果结论。');
    await page.locator('#review-form button').click();await nav('strategy');
    assert.match(await page.locator('main').innerText(),/缺少完整 30 日复购/);
  });
  await check('六页在桌面、平板、手机无整体横向溢出',async()=>{
    for(const width of [1600,1024,390]){
      await page.setViewportSize({width,height:width===390?844:1000});
      for(const id of ['overview','diagnosis','strategy','execution','review','data']){
        await nav(id);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${id}@${width} 溢出`);
        assert.ok(await page.locator('h1').isVisible());
      }
      if(width===390){await nav('overview');await page.locator('#ue-toast').evaluate(e=>e.textContent='');await page.screenshot({path:join(dir,'06-mobile-overview.png'),fullPage:true});await action('baseline').click();assert.ok(await dialog.isVisible());assert.ok(await page.evaluate(()=>document.querySelector('dialog')!.getBoundingClientRect().right<=innerWidth+1));await page.keyboard.press('Escape');}
    }
  });
  await check('文案无演示提示，业务词保留，数据字典和旧入口可用',async()=>{
    await page.setViewportSize({width:1600,height:1100});
    for(const id of ['overview','diagnosis','strategy','execution','review','data']){
      await nav(id);const text=await page.locator('main').innerText();
      assert.doesNotMatch(text,/演示|模拟|历史快照|脱敏摘要/);
      assert.doesNotMatch(text,/\/ \d+ 条|展示 \d+ 条|共 \d+ 条/);
    }
    assert.equal(await page.locator('.demo-tag').textContent(),'示例数据');
    await nav('data');await page.screenshot({path:join(dir,'10-data-quality.png'),fullPage:true});
    await page.locator('[data-action="data-tab"][data-id="dictionary"]').click();
    assert.match(await page.locator('main').innerText(),/补贴承担/);
    assert.match(await page.locator('main').innerText(),/统计范围/);
    await page.screenshot({path:join(dir,'11-dictionary.png'),fullPage:true});
    await page.locator('[data-action="data-tab"][data-id="catalogue"]').click();
    const old=await context.newPage();await old.goto(app.baseUrl);await old.locator('a.nav-item[href="/ue"]').waitFor();await old.close();
    assert.deepEqual(errors,[]);
  });
}finally{
  const hashes:Record<string,string>={};for(const file of ['src/domain/ue.ts','src/ue/fixtures.ts','src/ue/scope.ts','src/ue/app.ts','public/ue.html','public/ue.css','public/ue.js'])hashes[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
  await writeFile(join(dir,'verification.json'),JSON.stringify({scope:'本地 UE 工作台；无真实平台采集或经营验证',at:new Date().toISOString(),results,errors,sourceHashes:hashes},null,2));
  await context.close();await pool.close();await app.close();
}
console.log(`${results.length} browser checks passed; artifacts/ue/verification.json`);
