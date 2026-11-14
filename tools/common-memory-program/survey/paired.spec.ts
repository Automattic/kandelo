import {test,expect} from '../../../tests/playwright-test';
import {readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {serve} from '../platform/server.mjs';
import {pairedPlan} from './paired-plan.mjs';
import {hostProfileFor} from './paired-inputs.mjs';
const manifest=JSON.parse(readFileSync(resolve(process.env.KANDELO_SURVEY_VARIANTS!,'manifest.json'),'utf8'));
for(const trial of pairedPlan(manifest)) {
  test(`paired ${trial.cohort} ${trial.block} ${trial.order} ${trial.mode} ${trial.label}`,async({playwright,browserName},info)=>{
    const out=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
    const selectedProfile=hostProfileFor(manifest,trial.mode,process.env.KANDELO_COMMON_MEMORY_PROFILE!);
    const startedAt=new Date().toISOString();
    const server=await serve(selectedProfile,manifest.variants[trial.mode].artifacts.fpm.path,
      {nativeArtifact:resolve(manifest.nativeArtifacts?.[trial.mode]?.path??process.env.KANDELO_COMMON_MEMORY_NATIVE_FPM!),entry:'browser-benchmark.mjs'});
    const browser=await playwright[browserName].launch(info.project.use.launchOptions);
    const result:any={...trial,version:browser.version(),launchArgs:info.project.use.launchOptions?.args??[],loadBefore:loadavg(),pageErrors:[],startedAt,
      ...(manifest.hostProfiles?{hostProfile:selectedProfile}:{})};let page;
    try {
      page=await browser.newPage();
      page.on('pageerror',error=>result.pageErrors.push(String(error)));page.on('crash',()=>result.pageErrors.push('page crash'));
      await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).runBenchmark==='function');
      result.run=await page.evaluate(options=>(window as any).runBenchmark(options.label,options),{label:trial.label,seed:trial.seed,rounds:7,warmup:64});
      expect(result.run.error).toBeUndefined();expect(result.run.trial?.error).toBeUndefined();
      expect(result.run.trial?.passed).toBe(true);expect(result.run.destroyed).toBe(true);
      expect(result.run.stderr).toEqual([]);expect(result.run.diagnostics).toEqual([]);expect(result.pageErrors).toEqual([]);
    } catch(error) {
      result.error=String(error);result.progress=await page?.evaluate(()=>(window as any).benchmarkProgress).catch(()=>null);throw error;
    } finally {
      result.loadAfter=loadavg();
      result.finishedAt=new Date().toISOString();
      await writeFile(resolve(out,`${info.project.name}-${trial.cohort}-${trial.block}-${trial.order}-${trial.mode}-${trial.label}.json`),JSON.stringify(result,null,2)+'\n');
      await browser.close();await server.close();
    }
  });
}
