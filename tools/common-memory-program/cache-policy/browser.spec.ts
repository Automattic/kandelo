import {test,expect} from '../../../apps/browser-demos/playwright-test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {resolveLazyAssetPath} from '../../../host/src/binary-resolver';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from '../../../apps/browser-demos/test/support/browser-memory-boundary';
const root=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
for(const backend of ['sqlite','mariadb'])test('seed and edits '+backend,async({playwright,browserName},info)=>{
 const output=resolve(root,browserName+'-'+backend);await mkdir(output,{recursive:true});
 const fixture=resolve(process.env.KANDELO_OPCACHE_SEED_PREFIX?process.env.KANDELO_OPCACHE_SEED_PREFIX+'-'+backend:
  '.scratch/opcache-wordpress-'+backend+'-seed-'+(backend==='sqlite'?'2':'1'));
 const manifest=JSON.parse(await readFile(resolve(fixture,'manifest.json'),'utf8'));
 const files=new Map([
  ['/kernel.wasm',resolve('.scratch/common-memory-stop-kernel-2/out/kandelo-kernel.wasm')],
  ['/wordpress.vfs.zst',manifest.image],['/fpm.wasm',resolve(fixture,'translated-fpm.wasm')],
 ]),requests:any[]=[];
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cache-Control','no-store');
  const path=new URL(req.url!,'http://localhost').pathname;
  try{
   if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>OPcache seed mechanism</title><script type="module" src="/cache-policy/browser.mjs"></script>');return;}
   if(path==='/config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({wpConfig:renderWordPressConfig('selectable','/','http')}));return;}
   let file=files.get(path);
   if(!file&&/^\/(?:binaries\/|assets\/programs\/|@kandelo-lazy\/assets\/)/.test(path))file=resolveLazyAssetPath(path.replace(/^\/@kandelo-lazy\//,'/'));
   if(!file){
    const artifact=path.startsWith('/artifacts/'),base=resolve(artifact?'.scratch/common-memory-accounting-profile-2':'tools/common-memory-program');
    file=resolve(base,artifact?path.slice(11):path.slice(1));
    if(!file.startsWith(base+sep)||!file.endsWith('.mjs'))throw Error('unsupported module path');
   }
   const bytes=await readFile(file);requests.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
   res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');res.end(bytes);
  }catch(error){requests.push({path,error:String(error)});res.writeHead(404).end(String(error));}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const launch=await playwright[browserName].launchServer(info.project.use.launchOptions);
 const browser=await playwright[browserName].connect(launch.wsEndpoint());
 const result:any={scope:'Mechanism and freshness only; diagnostic logging; no browser latency claim',backend,browserName,version:browser.version(),manifest,events:[],passed:false};
 let page;
 try{
  page=await browser.newPage();await installBrowserMemoryBoundaryProbe(page);
  page.on('pageerror',error=>result.events.push({kind:'pageerror',message:String(error)}));page.on('crash',()=>result.events.push({kind:'crash'}));
  await page.goto('http://127.0.0.1:'+(server.address()as any).port);
  await page.waitForFunction(()=>typeof(window as any).runSeed==='function');
  result.run=await page.evaluate(backend=>(window as any).runSeed(backend),backend);
  expect(result.run.error).toBeUndefined();expect(result.run.passed).toBe(true);expect(result.run.destroyed).toBe(true);
  expect(result.run.identities.image).toBe(manifest.imageSha256);expect(result.run.identities.fpm).toBe(manifest.translatedFpmSha256);
  expect(result.run.crossOriginIsolated).toBe(true);expect(result.events).toEqual([]);
  result.boundaryFailures=await memoryBoundaryFailures(page);expect(result.boundaryFailures).toEqual([]);result.passed=true;
 }catch(error){result.error=String(error);result.progress=await page?.evaluate(()=>(window as any).seedProgress).catch(()=>null);throw error;}
 finally{result.requests=requests;await writeFile(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');
  await browser.close();await launch.close();await new Promise<void>(r=>server.close(()=>r()));}
});
