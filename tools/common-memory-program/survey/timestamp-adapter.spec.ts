import {test,expect} from '../../../tests/playwright-test';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {serveWordPressSurvey} from './wordpress-server.mjs';
const m=JSON.parse(readFileSync(process.env.KANDELO_TIMESTAMP_ADAPTER_MANIFEST!,'utf8')),stage=process.env.KANDELO_TIMESTAMP_ADAPTER_STAGE!;
for(const[index,c]of m[stage+'Cases'].entries())test(`${stage} ${index} ${c.variant} ${c.label} ${c.backend??''}`,async({playwright,browserName},info)=>{
 const out=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);mkdirSync(out,{recursive:true});
 const artifact=stage==='micro'?(c.label==='native-file'?m.nativeCli:m.vmCli):(c.label==='native-file'?m.nativeFpm:m.vmFpm);
 const r:any={...c,stage,index,profile:m.profiles[c.variant],startedAt:new Date().toISOString(),loadBefore:loadavg(),events:[]};let server,browser,page,timer;
 try{
  server=await serveWordPressSurvey({profile:r.profile,image:m.image,artifact,kernel:m.kernel,wpConfig:renderWordPressConfig('selectable','/','http')});
  browser=await playwright[browserName].launch(info.project.use.launchOptions);r.version=browser.version();page=await browser.newPage();
  page.on('crash',()=>r.events.push('crash'));page.on('pageerror',e=>r.events.push(String(e)));
  await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).runWordPressSurvey==='function');
  const operation=stage==='micro'?page.evaluate(async()=>{
   const{BrowserKernel}=await import('/artifacts/browser-kernel-host.mjs');const{statMicroTrial,parseStatMicro}=await import('/timestamp-stat-micro.mjs');
   const v:any={stdout:'',stderr:'',diagnostics:[],crossOriginIsolated};
   const host=new BrowserKernel({maxWorkers:4,onStdout:b=>v.stdout+=new TextDecoder().decode(b),onStderr:b=>v.stderr+=new TextDecoder().decode(b),onHostDiagnostic:e=>v.diagnostics.push(e)});
   try{const[kernel,image,artifact]=await Promise.all(['/kernel.wasm','/wordpress.vfs.zst','/fpm.wasm'].map(p=>fetch(p).then(r=>r.arrayBuffer())));
    const sha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
    v.kernelSha256=await sha(kernel);v.artifactSha256=await sha(artifact);
    await host.initFromImage({kernelWasm:kernel,vfsImage:new Uint8Array(image),lazyUrlBase:location.origin+'/'});v.trial=await statMicroTrial(host,artifact);v.micro=parseStatMicro(v.stdout);
   }catch(e){v.error=String(e.stack||e);}finally{await host.destroy();v.destroyed=true;}return v;
  }):page.evaluate(o=>(window as any).runWordPressSurvey(o),{label:c.label,backend:c.backend,warmup:stage==='timing'?2:0,rounds:stage==='timing'?5:1,seed:6197,validateTimestamps:true,checkTimestampPolicy:stage==='gate',probeRequests:0});
  r.run=await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('parent deadline 260s')),260000);})]);
  expect(r.run.error).toBeUndefined();expect(r.events).toEqual([]);expect(r.run.stderr).toEqual(stage==='micro'?'':[]);expect(r.run.diagnostics).toEqual([]);expect(r.run.destroyed).toBe(true);
  expect(stage==='micro'?r.run.micro?.passed:r.run.trial?.passed).toBe(true);
 }catch(e){r.error=String(e);if(page){let rescueTimer;try{r.failureProgress=await Promise.race([page.evaluate(()=>(window as any).surveyProgress??null),new Promise((_,reject)=>{rescueTimer=setTimeout(()=>reject(Error('progress rescue deadline')),5000);})]);}catch(e){r.progressError=String(e);}finally{clearTimeout(rescueTimer);}}throw e;}
 finally{clearTimeout(timer);r.finishedAt=new Date().toISOString();r.loadAfter=loadavg();writeFileSync(resolve(out,`${info.project.name}-${index}.json`),JSON.stringify(r,null,2)+'\n');try{await browser?.close();}finally{await server?.close();}}
});
