import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {resolveLazyAssetPath} from '../../../host/src/binary-resolver';
import {createHash} from 'node:crypto';
export async function serveImpact({fixture,profile,kernel,label,wpConfig}:{fixture:string;profile:string;kernel:string;label:string;wpConfig:string}) {
  const manifest=JSON.parse(await readFile(resolve(fixture,'manifest.json'),'utf8'));
  const exact=new Map([
    ['/kernel.wasm',resolve(kernel)],['/wordpress.vfs.zst',manifest.image],['/fpm.wasm',resolve(fixture,manifest.arms[label])],
    ['/impact-browser.mjs',resolve('tools/common-memory-program/impact/browser.mjs')],
    ['/impact-shared.mjs',resolve('tools/common-memory-program/impact/shared.mjs')],
  ]);
  const requests:Array<{path:string;bytes?:number;sha256?:string;error?:string}>=[];
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cache-Control','no-store');
    const path=new URL(req.url!,'http://localhost').pathname;
    try{
      if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Shared memory impact</title><script type="module" src="/impact-browser.mjs"></script>');return;}
      if(path==='/config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({wpConfig}));return;}
      let file=exact.get(path);
      if(!file&&/^\/(?:binaries\/|assets\/programs\/|@kandelo-lazy\/assets\/)/.test(path)) {
        // Use the same guarded resolver as ordinary host lazy reads. The
        // guest still verifies the image-owned asset size and digest.
        file=resolveLazyAssetPath(path.replace(/^\/@kandelo-lazy\//,'/'));
      }
      if(!file){
        const base=resolve(path.startsWith('/artifacts/')?profile:'tools/common-memory-program/survey');
        file=resolve(base,path.startsWith('/artifacts/')?path.slice(11):path.slice(1));
        if(!file.startsWith(base+sep)||!file.endsWith('.mjs'))throw Error('unknown fixture path');
      }
      const bytes=await readFile(file);requests.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
      res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');
      res.setHeader('Content-Length',bytes.length);res.end(bytes);
    }catch(error){requests.push({path,error:String(error)});res.writeHead(404).end(String(error));}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  return{url:'http://127.0.0.1:'+(server.address()as any).port,requests,close:()=>new Promise<void>(r=>server.close(()=>r()))};
}
