// Failure triage only: copied progress and host output are retained while live.
// This deliberately instrumented run is not part of the latency comparison.
import {test,expect} from '../../../tests/playwright-test';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {serveWordPressSurvey} from './wordpress-server.mjs';
const path=resolve('.scratch/timestamp-stat-plan-1/manifest.json');
const manifest=JSON.parse(readFileSync(path,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
for(const kernel of ['candidate','baseline'])test(`diagnose ${kernel} shared WordPress`,async({playwright},info)=>{
 const out=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);mkdirSync(out,{recursive:true});
 const result:any={kernel,manifestSha256:sha(path),kernelSha256:sha(manifest.kernels[kernel]),startedAt:new Date().toISOString(),events:[],progress:[]};
 const save=()=>writeFileSync(resolve(out,`${kernel}.json`),JSON.stringify(result,null,2)+'\n');
 let server,browser;
 try{
  for(const[p,h]of Object.entries(manifest.inputs))expect(sha(p)).toBe(h);
  server=await serveWordPressSurvey({profile:manifest.profile,image:manifest.image,artifact:manifest.vmFpm,kernel:manifest.kernels[kernel],wpConfig:renderWordPressConfig('selectable','/','http')});
  browser=await playwright.chromium.launch(info.project.use.launchOptions);const page=await browser.newPage();
  page.on('pageerror',e=>{result.events.push(String(e));save();});page.on('crash',()=>{result.events.push('crash');save();});
  await page.exposeFunction('__retainStatProgress',(text:string)=>{const r=JSON.parse(text);result.progress.push(r);save();});
  await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).runWordPressSurvey==='function');
  result.run=await page.evaluate(async()=>{
   const {BrowserKernel}=await import('/artifacts/browser-kernel-host.mjs');const {wordpressTrial}=await import('/wordpress-fixture.mjs');
   const r:any={stage:'construct',stdout:[],stderr:[],diagnostics:[]};
   const publish=async()=>await(window as any).__retainStatProgress(JSON.stringify(r));
   const host=new BrowserKernel({maxWorkers:24,onStdout:b=>{r.stdout.push(new TextDecoder().decode(b));void publish();},onStderr:b=>{r.stderr.push(new TextDecoder().decode(b));void publish();},onHostDiagnostic:e=>{r.diagnostics.push(e);void publish();}});
   let timer;
   try{
    r.stage='fetch';await publish();const[kernel,image,artifact,config]=await Promise.all([fetch('/kernel.wasm').then(r=>r.arrayBuffer()),fetch('/wordpress.vfs.zst').then(r=>r.arrayBuffer()),fetch('/fpm.wasm').then(r=>r.arrayBuffer()),fetch('/config.json').then(r=>r.json())]);
    r.stage='init';await publish();await host.initFromImage({kernelWasm:kernel,vfsImage:new Uint8Array(image),lazyUrlBase:location.origin+'/'});
    r.stage='application';await publish();r.trial=await Promise.race([wordpressTrial(host,artifact,{label:'vm-shared',backend:'sqlite',warmup:2,rounds:5,seed:6197,validateTimestamps:true,checkTimestampPolicy:false,probeRequests:0,wpConfig:config.wpConfig,persist:t=>{r.trial=t;void publish();}}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('diagnostic application deadline 180s')),180000);})]);
   }catch(e){r.error=String(e.stack||e);}
   finally{
    clearTimeout(timer);r.stage='destroy';await publish();let retirementTimer;
    try{await Promise.race([host.destroy(),new Promise((_,reject)=>{retirementTimer=setTimeout(()=>reject(Error('diagnostic retirement deadline 15s')),15000);})]);r.destroyed=true;}
    catch(e){r.destroyError=String(e.stack||e);}finally{clearTimeout(retirementTimer);}
    r.stage='finished';await publish();
   }
   return r;
  });
  expect(result.run.error).toBeUndefined();expect(result.run.destroyed).toBe(true);expect(result.run.trial?.passed).toBe(true);expect(result.events).toEqual([]);
 }catch(e){result.error=String(e);throw e;}
 finally{result.finishedAt=new Date().toISOString();save();try{await browser?.close();}finally{await server?.close();}}
});
