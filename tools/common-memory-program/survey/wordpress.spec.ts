import {test,expect} from '../../../tests/playwright-test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {wordpressPlan} from './wordpress-plan.mjs';
import {timestampOptionsFromEnv} from './wordpress-policy.mjs';
import {serveWordPressSurvey} from './wordpress-server.mjs';
const modes=(process.env.KANDELO_SURVEY_MODES??'baseline,baseline-conditional,scalar,scalar-conditional').split(',');
for(const trial of wordpressPlan(modes)) {
  test(`WordPress ${trial.cohort} ${trial.order} ${trial.mode} ${trial.label}`,async({playwright,browserName},info)=>{
    const manifest=JSON.parse(await readFile(resolve(process.env.KANDELO_SURVEY_VARIANTS!,'manifest.json'),'utf8'));
    const out=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);await mkdir(out,{recursive:true});
    const artifact=trial.label==='native-file'?process.env.KANDELO_COMMON_MEMORY_NATIVE_FPM!:manifest.variants[trial.mode].artifacts.fpm.path;
    const server=await serveWordPressSurvey({profile:resolve(process.env.KANDELO_COMMON_MEMORY_PROFILE!),
      image:resolve(process.env.KANDELO_SURVEY_IMAGE!),artifact:resolve(artifact),wpConfig:renderWordPressConfig('selectable','/','http')});
    const browser=await playwright[browserName].launch(info.project.use.launchOptions);
    const result:any={...trial,version:browser.version(),launchArgs:info.project.use.launchOptions?.args??[],loadBefore:loadavg(),events:[]};
    let page;
    try {
      page=await browser.newPage();
      page.on('crash',()=>result.events.push('page crash'));page.on('pageerror',error=>result.events.push(String(error)));
      await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).runWordPressSurvey==='function');
      result.run=await page.evaluate(options=>(window as any).runWordPressSurvey(options),{
        label:trial.label,backend:process.env.KANDELO_SURVEY_BACKEND??'sqlite',seed:trial.seed,
        ...timestampOptionsFromEnv(process.env),
        warmup:Number(process.env.KANDELO_SURVEY_WARMUP??4),rounds:Number(process.env.KANDELO_SURVEY_ROUNDS??7)});
      expect(result.run.error).toBeUndefined();expect(result.run.trial?.error).toBeUndefined();
      expect(result.run.trial?.passed).toBe(true);expect(result.run.destroyed).toBe(true);
      expect(result.run.diagnostics).toEqual([]);expect(result.events).toEqual([]);expect(result.run.crossOriginIsolated).toBe(true);
    } catch(error) {
      result.error=String(error);
      result.progress=await page?.evaluate(()=>(window as any).surveyProgress).catch(()=>null);
      throw error;
    } finally {
      result.loadAfter=loadavg();
      await writeFile(resolve(out,`${info.project.name}-${trial.cohort}-${trial.order}-${trial.mode}-${trial.label}.json`),JSON.stringify(result,null,2)+'\n');
      await browser.close();await server.close();
    }
  });
}
