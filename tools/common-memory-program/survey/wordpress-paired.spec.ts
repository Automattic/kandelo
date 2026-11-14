import {test,expect} from '../../../tests/playwright-test';
import {readFileSync} from 'node:fs';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {serveWordPressSurvey} from './wordpress-server.mjs';
const frozen=JSON.parse(readFileSync(process.env.KANDELO_SURVEY_PAIRED_INPUTS!,'utf8'));
const manifest=JSON.parse(readFileSync(resolve(process.env.KANDELO_SURVEY_VARIANTS!,'manifest.json'),'utf8'));
for(const trial of frozen.plan) {
  test(`paired WordPress ${trial.cohort} ${trial.block} ${trial.order} ${trial.mode} ${trial.label}`,async({playwright,browserName},info)=>{
    const out=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);await mkdir(out,{recursive:true});
    const artifact=trial.label==='native-file'?manifest.nativeArtifacts[trial.mode].path:manifest.variants[trial.mode].artifacts.fpm.path;
    const hostProfile=frozen.hostProfiles[trial.mode],appOptions=frozen.appOptions[trial.mode];
    const result:any={...trial,hostProfile,appOptions,startedAt:new Date().toISOString(),loadBefore:loadavg(),events:[],launchArgs:info.project.use.launchOptions?.args??[]};
    let browser,page,server;
    try {
      server=await serveWordPressSurvey({profile:hostProfile,image:resolve(process.env.KANDELO_SURVEY_IMAGE!),artifact:resolve(artifact),wpConfig:renderWordPressConfig('selectable','/','http')});
      browser=await playwright[browserName].launch(info.project.use.launchOptions);result.version=browser.version();
      page=await browser.newPage();page.on('crash',()=>result.events.push('page crash'));page.on('pageerror',error=>result.events.push(String(error)));
      await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).runWordPressSurvey==='function');
      result.run=await page.evaluate(options=>(window as any).runWordPressSurvey(options),{
        ...appOptions,...frozen.settings,label:trial.label,seed:trial.seed,checkTimestampPolicy:false,probeRequests:0});
      expect(result.run.error).toBeUndefined();expect(result.run.trial?.error).toBeUndefined();
      expect(result.run.trial?.passed).toBe(true);expect(result.run.destroyed).toBe(true);
      expect(result.run.diagnostics).toEqual([]);expect(result.run.stderr).toEqual([]);expect(result.events).toEqual([]);expect(result.run.crossOriginIsolated).toBe(true);
    } catch(error) {
      result.error=String(error);result.progress=await page?.evaluate(()=>(window as any).surveyProgress).catch(()=>null);throw error;
    } finally {
      result.finishedAt=new Date().toISOString();result.loadAfter=loadavg();
      await writeFile(resolve(out,`${info.project.name}-${trial.cohort}-${trial.block}-${trial.order}-${trial.mode}-${trial.label}.json`),JSON.stringify(result,null,2)+'\n');
      try {await browser?.close();}finally {await server?.close();}
    }
  });
}
