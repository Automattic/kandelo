import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function serveWordPressSurvey({profile,image,artifact,wpConfig,kernel='local-binaries/source-only-v1/kernel.wasm'}) {
  const source=fileURLToPath(new URL('.',import.meta.url));
  const exact=new Map([['/kernel.wasm',resolve(kernel)],
    ['/wordpress.vfs.zst',resolve(image)],['/fpm.wasm',resolve(artifact)]]);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    res.setHeader('Cache-Control','no-store');
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>WordPress optimization survey</title><script type="module" src="/wordpress-browser.mjs"></script>');return;}
      if(path==='/config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({wpConfig}));return;}
      let file=exact.get(path);
      if(!file) {
        const root=resolve(path.startsWith('/artifacts/')?profile:source);
        file=resolve(root,path.startsWith('/artifacts/')?path.slice(11):path.slice(1));
        if(!file.startsWith(root+sep)||!file.endsWith('.mjs'))throw Error('refused module path');
      }
      res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');
      res.end(await readFile(file));
    } catch(error) {res.writeHead(404);res.end('not found');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>server.close(r))};
}
