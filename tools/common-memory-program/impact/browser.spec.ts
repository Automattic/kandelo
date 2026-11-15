import {test,expect} from '../../../apps/browser-demos/playwright-test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {serveImpact} from './server';
import {physicalFootprint} from './host-resources.mjs';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from '../../../apps/browser-demos/test/support/browser-memory-boundary';
const plan=JSON.parse(await readFile(process.env.KANDELO_IMPACT_PLAN!,'utf8'));
for(const trial of plan.trials.filter((t:any)=>t.host!=='node'))test(trial.id,async({playwright,browserName},info)=>{
  test.skip(trial.host!==browserName,'explicit host selection');
  const output=resolve(plan.output,trial.id);await mkdir(output,{recursive:true});
  const server=await serveImpact({...plan,label:trial.label,wpConfig:renderWordPressConfig('selectable','/','http')});
  const launch=await playwright[browserName].launchServer(info.project.use.launchOptions);
  const browser=await playwright[browserName].connect(launch.wsEndpoint());
  const pid=launch.process().pid!;
  const result:any={...trial,version:browser.version(),loadBefore:loadavg(),startedAt:new Date().toISOString(),events:[],resources:[]};
  let page;
  try{
    page=await browser.newPage();await installBrowserMemoryBoundaryProbe(page);
    page.on('pageerror',error=>result.events.push({kind:'pageerror',message:String(error)}));page.on('crash',()=>result.events.push({kind:'crash'}));
    await page.exposeFunction('impactFootprint',async(phase:string)=>{
      const sample=await physicalFootprint(pid,output,'os-'+result.resources.length,{tree:true});result.resources.push({phase,...sample});return sample;
    });
    await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).runImpact==='function');
    if(trial.mode==='resource')result.beforeInitFootprint=await physicalFootprint(pid,output,'before-init',{tree:true});
    result.run=await page.evaluate(trial=>(window as any).runImpact({...trial,seed:6197+trial.cohort}),trial);
    expect(result.run.error).toBeUndefined();expect(result.run.passed).toBe(true);expect(result.run.destroyed).toBe(true);
    expect(result.run.diagnostics).toEqual([]);expect(result.events).toEqual([]);
    expect(result.run.crossOriginIsolated).toBe(true);
    result.boundaryFailures=await memoryBoundaryFailures(page);expect(result.boundaryFailures).toEqual([]);
    result.passed=true;
  }catch(error){result.error=String(error);result.progress=await page?.evaluate(()=>(window as any).impactProgress).catch(()=>null);throw error;}
  finally{
    result.loadAfter=loadavg();result.requests=server.requests;
    await writeFile(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');
    await browser.close();await launch.close();await server.close();
  }
});
