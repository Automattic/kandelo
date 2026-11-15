import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function serve(profile,artifact,{nativeArtifact,entry='browser-trial.mjs'}={}) {
  const source=fileURLToPath(new URL('.',import.meta.url));
  const exact=new Map([
    ['/kernel.wasm',resolve('local-binaries/source-only-v1/kernel.wasm')],
    ['/partial.vfs.zst',resolve('local-binaries/partial/shell-partial.vfs.zst')],
    ['/php-fpm-vm.wasm',resolve(artifact)],
  ]);
  if(nativeArtifact) exact.set('/php-fpm-native.wasm',resolve(nativeArtifact));
  const server=http.createServer(async (req,res)=>{
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    res.setHeader('Cache-Control','no-store');
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/') {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Common-memory PHP-FPM</title><script type="module" src="/${entry}"></script>`);return;}
      let file=exact.get(path);
      if(!file) {
        const base=resolve(path.startsWith('/artifacts/')?profile:source);
        file=resolve(base,path.startsWith('/artifacts/')?path.slice(11):path.slice(1));
        if(!file.startsWith(base+sep) || !file.endsWith('.mjs')) throw Error('refused path');
      }
      res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':file.endsWith('.mjs')?'text/javascript':'application/octet-stream');
      res.end(await readFile(file));
    } catch {res.writeHead(404);res.end('not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
