import {test,expect} from '../../../tests/playwright-test';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serve} from '../platform/server.mjs';
for(const mode of (process.env.KANDELO_SURVEY_MODES??'baseline,baseline-conditional,scalar,scalar-conditional').split(',')) {
  test(`shared FPM and connection admission: ${mode}`,async({playwright,browserName},info)=>{
    const manifest=JSON.parse(await readFile(resolve(process.env.KANDELO_SURVEY_VARIANTS!,'manifest.json'),'utf8'));
    const server=await serve(resolve(process.env.KANDELO_COMMON_MEMORY_PROFILE!),manifest.variants[mode].artifacts.fpm.path);
    const browser=await playwright[browserName].launch(info.project.use.launchOptions);
    const page=await browser.newPage();
    const evidence:any={mode,version:browser.version(),events:[]};
    page.on('crash',()=>evidence.events.push('page crash'));
    page.on('pageerror',error=>evidence.events.push(String(error)));
    browser.on('disconnected',()=>evidence.events.push('browser disconnected'));
    try {
      await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).run==='function');
      const result=await page.evaluate(()=>(window as any).run('shared'));
      Object.assign(evidence,result);
      expect(result.error).toBeUndefined();expect(result.passed).toBe(true);expect(result.destroyed).toBe(true);
    } catch(error) {evidence.error=String(error);throw error;}
    finally {
      const repeat=info.repeatEachIndex?`-repeat${info.repeatEachIndex}`:'';
      await writeFile(resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!,`${info.project.name}-${mode}${repeat}.json`),JSON.stringify(evidence,null,2)+'\n');
      await browser.close();await server.close();
    }
  });
}
