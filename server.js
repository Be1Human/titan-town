import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,brotliCompressSync,constants} from 'node:zlib';

const root=path.dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.json':'application/json','.svg':'image/svg+xml'};
// Only the game page, its styles, scripts and runtime assets are public.
const PAGES=new Set(['/game.html','/style.css','/main-menu.css']);
const ASSET=/^\/assets\/(?:scenes|materials|voxel-models|prefabs|characters)\/[\w./-]+\.json$/;
const SCRIPT=/^\/(?:src|vendor)\/[\w./-]+\.js$/;

export function createGameServer({port=Number(process.env.PORT||4173),host=process.env.HOST||'127.0.0.1'}={}){
  const cache=new Map();
  const server=http.createServer(async(req,res)=>{
    try{
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:true}));return;}
      const filename=decodeURIComponent(url.pathname==='/'?'/game.html':url.pathname);
      const allowed=PAGES.has(filename)||SCRIPT.test(filename)||ASSET.test(filename);
      if(!allowed||filename.split('/').includes('..')||filename.includes('\\')){res.writeHead(404).end('Not found');return;}
      const resolved=path.resolve(root,'.'+filename);
      if(!resolved.startsWith(root+path.sep)){res.writeHead(404).end();return;}
      const info=await stat(resolved);if(!info.isFile()){res.writeHead(404).end();return;}
      let entry=cache.get(resolved);if(!entry||entry.mtime!==info.mtimeMs){entry={mtime:info.mtimeMs,body:await readFile(resolved)};cache.set(resolved,entry);}
      const mime=types[path.extname(resolved)]||'application/octet-stream';
      const headers={'Content-Type':mime,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Vary':'Accept-Encoding','ETag':`"${info.size}-${Math.round(info.mtimeMs)}"`};
      // Shared numeric solver buffers need a cross-origin isolated page.
      if(filename==='/game.html'&&url.searchParams.get('physics')?.startsWith('reference')){headers['Cross-Origin-Opener-Policy']='same-origin';headers['Cross-Origin-Embedder-Policy']='require-corp';}
      if(mime.startsWith('text/javascript'))headers['Cross-Origin-Embedder-Policy']='require-corp';
      if(req.headers['if-none-match']===headers.ETag){res.writeHead(304,headers).end();return;}
      let body=entry.body;const accept=req.headers['accept-encoding']||'';
      if(body.length>2048&&/javascript|json|text|svg/.test(mime)){
        if(accept.includes('br')){entry.br??=brotliCompressSync(body,{params:{[constants.BROTLI_PARAM_QUALITY]:4}});body=entry.br;headers['Content-Encoding']='br';}
        else if(accept.includes('gzip')){entry.gzip??=gzipSync(body,{level:4});body=entry.gzip;headers['Content-Encoding']='gzip';}
      }
      headers['Content-Length']=body.length;res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:body);
    }catch{res.writeHead(404).end('Not found');}
  });
  const currentPort=()=>server.address()?.port??port;
  return {server,port,host,listen(){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);console.log(`Titan Town ready at http://localhost:${currentPort()}`);resolve(this);});});},close(){return new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const game=createGameServer();game.listen().catch(error=>{console.error(`Cannot start Titan Town: ${error.message}`);process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>game.close().then(()=>process.exit(0)));
}
