import {readFile} from 'node:fs/promises';
import {connectAndroid} from '../src/adapters/android-transport.js';
import {flatten,textOf,resourceOf} from '../src/adapters/android-page.js';
import type {AndroidSource} from '../src/adapters/android-source.js';
import sharp from 'sharp';
import {mkdir,writeFile} from 'node:fs/promises';
const source=(JSON.parse(await readFile('.runtime/android-sources.json','utf8')) as AndroidSource[]).find(s=>s.platform==='jd')!;
const device=await connectAndroid(source,AbortSignal.timeout(20_000));
try{const tree=await device.getUITree();const nodes=flatten(tree.root);console.log(JSON.stringify(nodes.filter(n=>n.bounds.width>0&&n.bounds.height>0&&(/麦当劳|板烧|商家|门店|搜索|外卖|查看|购物车|已选|销量|费用|配送费|打包费|商品金额|餐盒|已优惠|应付|复选框|减少|1人份|数量/.test(textOf(n))||n.attrs.class==='android.widget.Button')&&!/1[3-9]\d{9}/.test(textOf(n))).map(n=>({text:textOf(n).slice(0,150),resource:resourceOf(n),class:n.attrs.class,clickable:n.attrs.clickable,bounds:n.bounds})),null,2));
  if(process.argv.includes('--search-evidence')&&nodes.some(n=>n.attrs.class==='android.widget.EditText'&&textOf(n)==='麦当劳')){const png=await device.screenshot(AbortSignal.timeout(8000)),meta=await sharp(png).metadata();await mkdir('artifacts/specified-pilot',{recursive:true});await writeFile('artifacts/specified-pilot/search-public.png',await sharp(png).extract({left:0,top:Math.round(meta.height!*.17),width:meta.width!,height:Math.round(meta.height!*.55)}).png().toBuffer());}
}finally{await device.close();}
