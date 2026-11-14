import {test,expect} from '../../../tests/playwright-test';
import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serveWordPressSurvey} from './wordpress-server.mjs';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
const root=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
const paths=JSON.parse(readFileSync('.scratch/common-memory-preload-first-pass-1/inventory/inventory.json','utf8')).cachedScripts;
const cases=[{name:'sparse',profile:'.scratch/common-memory-sparse-fork-profile-1',preload:false},{name:'preload',profile:'.scratch/common-memory-survey-postopt-pregrown-profile-1',preload:true},{name:'preload-sparse-small',profile:'.scratch/common-memory-sparse-fork-small-profile-1',preload:true}];
for(const c of cases)test('breadth app '+c.name,async({page,browser},info)=>{
 const server=await serveWordPressSurvey({profile:resolve(c.profile),image:resolve('.scratch/common-memory-wordpress-1/wordpress.vfs.zst'),artifact:resolve('.scratch/common-memory-survey-fused-1/fpm-fuse-small.wasm'),wpConfig:renderWordPressConfig('selectable','/','http')});
 const result:any={case:c,diagnostic:'breadth-app-first-pass',version:browser.version(),events:[]};page.on('crash',()=>result.events.push('page crash'));page.on('pageerror',e=>result.events.push(String(e)));
 try{await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).runWordPressSurvey==='function');
  result.run=await page.evaluate(async options=>{
   const {BrowserKernel}=await import('/artifacts/browser-kernel-host.mjs');const{installBrowserPreloadProbe}=await import('/preload-browser-probe.mjs');const probe=installBrowserPreloadProbe(BrowserKernel,options);
   try{return{...await(window as any).runWordPressSurvey({label:'vm-shared',backend:'sqlite',warmup:1,rounds:1,seed:6197,validateTimestamps:false,checkTimestampPolicy:false,probeRequests:0}),probe:probe.report};}finally{probe.restore();}
  },{paths,preload:c.preload,warmup:1,rounds:1});
  expect(result.run.error).toBeUndefined();expect(result.run.trial?.error).toBeUndefined();expect(result.run.trial?.passed).toBe(true);expect(result.run.destroyed).toBe(true);expect(result.run.diagnostics).toEqual([]);expect(result.run.stderr).toEqual([]);expect(result.run.crossOriginIsolated).toBe(true);expect(result.events).toEqual([]);
  expect(result.run.trial.samples.length).toBe(8);expect(new Set(result.run.trial.statuses.map((s:any)=>s.pid)).size).toBe(2);expect(result.run.trial.artifactSha256).toBe('2edbcf32ef3c309eefdabec5eaceeb6d6082ca80fc9b1fc0e235ff838b7b89b4');
  if(c.preload){expect(result.run.probe.completion).toEqual({requested:561,compiled:561,failed:[]});expect(result.run.probe.inventory.preload.functions.length).toBe(3466);expect(result.run.probe.inventory.preload.classes.length).toBe(290);}
  result.run.probe.passed=true;result.passed=true;
 }catch(error){result.error=String(error);result.progress=await page.evaluate(()=>(window as any).surveyProgress).catch(()=>null);throw error;}
 finally{await mkdir(root,{recursive:true});await writeFile(resolve(root,info.project.name+'-'+c.name+'.json'),JSON.stringify(result,null,2)+'\n');await server.close();}
});
