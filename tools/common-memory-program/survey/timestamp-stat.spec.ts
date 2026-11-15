import {test,expect} from '../../../tests/playwright-test';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {serveWordPressSurvey} from './wordpress-server.mjs';
const manifest=JSON.parse(readFileSync(process.env.KANDELO_TIMESTAMP_STAT_MANIFEST!,'utf8'));
const stage=process.env.KANDELO_TIMESTAMP_STAT_STAGE!;
for(const [index,trial]of manifest[stage+'Cases'].entries())test(`${stage} ${index} ${trial.kernel} ${trial.label} ${trial.backend??''}`,async({playwright,browserName},info)=>{
 const out=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);mkdirSync(out,{recursive:true});
 const artifact=stage==='micro'?(trial.label==='native-file'?manifest.nativeCli:manifest.vmCli):(trial.label==='native-file'?manifest.nativeFpm:manifest.vmFpm);
 const result:any={...trial,stage,index,startedAt:new Date().toISOString(),loadBefore:loadavg(),events:[]};let server,browser,page;
 try{
  server=await serveWordPressSurvey({profile:manifest.profile,image:manifest.image,artifact,kernel:manifest.kernels[trial.kernel],wpConfig:renderWordPressConfig('selectable','/','http')});
  browser=await playwright[browserName].launch(info.project.use.launchOptions);result.version=browser.version();page=await browser.newPage();
  page.on('crash',()=>result.events.push('crash'));page.on('pageerror',e=>result.events.push(String(e)));
  await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).runWordPressSurvey==='function');
  if(stage==='micro')result.run=await page.evaluate(async()=>{
   const {BrowserKernel}=await import('/artifacts/browser-kernel-host.mjs');const {statMicroTrial,parseStatMicro}=await import('/timestamp-stat-micro.mjs');
   const r:any={stdout:'',stderr:'',diagnostics:[],crossOriginIsolated};
   const host=new BrowserKernel({maxWorkers:4,onStdout:b=>r.stdout+=new TextDecoder().decode(b),onStderr:b=>r.stderr+=new TextDecoder().decode(b),onHostDiagnostic:e=>r.diagnostics.push(e)});
   try{const[kernel,image,artifact]=await Promise.all(['/kernel.wasm','/wordpress.vfs.zst','/fpm.wasm'].map(p=>fetch(p).then(r=>r.arrayBuffer())));
    const sha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
    r.kernelSha256=await sha(kernel);r.artifactSha256=await sha(artifact);
    await host.initFromImage({kernelWasm:kernel,vfsImage:new Uint8Array(image),lazyUrlBase:location.origin+'/'});r.trial=await statMicroTrial(host,artifact);r.micro=parseStatMicro(r.stdout);
   }catch(e){r.error=String(e.stack||e);}finally{await host.destroy();r.destroyed=true;}return r;
  });
  else result.run=await page.evaluate(o=>(window as any).runWordPressSurvey(o),{label:trial.label,backend:trial.backend??'sqlite',warmup:stage==='timing'?2:0,rounds:stage==='timing'?5:1,seed:6197,validateTimestamps:true,checkTimestampPolicy:stage==='gate',probeRequests:0});
  expect(result.run.error).toBeUndefined();expect(result.events).toEqual([]);expect(result.run.stderr).toEqual(stage==='micro'?'':[]);expect(result.run.diagnostics).toEqual([]);expect(result.run.destroyed).toBe(true);
  expect(stage==='micro'?result.run.micro?.passed:result.run.trial?.passed).toBe(true);
 }catch(error){result.error=String(error);throw error;}
 finally{result.finishedAt=new Date().toISOString();result.loadAfter=loadavg();writeFileSync(resolve(out,`${info.project.name}-${index}.json`),JSON.stringify(result,null,2)+'\n');try{await browser?.close();}finally{await server?.close();}}
});
