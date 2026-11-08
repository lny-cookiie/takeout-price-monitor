import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// UI preview is static: it does not open the collection database or start its scheduler.
const root=fileURLToPath(new URL('../public/',import.meta.url));
const port=Number(process.env.UE_PORT??4319);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('UE_PORT 无效');
const files:Record<string,[string,string]>={'/':['ue.html','text/html'], '/ue':['ue.html','text/html'],'/ue/':['ue.html','text/html'],'/ue.css':['ue.css','text/css'],'/ue.js':['ue.js','text/javascript']};
const server=createServer(async(req,res)=>{
  if(!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host??'')){res.writeHead(403);res.end();return;}
  const path=new URL(req.url??'/',`http://127.0.0.1:${port}`).pathname;
  if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
  const file=files[path];
  if(req.method!=='GET'||!file){res.writeHead(404);res.end('Not found');return;}
  try{const data=await readFile(resolve(root,file[0]));res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"});res.end(data);}
  catch{res.writeHead(500);res.end('UI bundle missing. Run npm run build:ue.');}
});
server.listen(port,'127.0.0.1',()=>console.log(`包销品 UE · 本地模拟工作台 http://127.0.0.1:${port}/ue`));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
