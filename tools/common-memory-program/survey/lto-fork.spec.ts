import {test,expect} from '../../../tests/playwright-test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {serve} from '../platform/server.mjs';
import {ltoForkPlan} from './lto-fork-plan.mjs';
const root=resolve(process.env.KANDELO_LTO_FORK_ARTIFACTS!);
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
for(const control of ltoForkPlan(manifest))test(`LTO real fork ${control.id}`,async({playwright,browserName},info)=>{
 const artifact=manifest.variants[control.mode][control.addressing];
 const bytes=await readFile(artifact.path);
 expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
 const server=await serve(resolve(process.env.KANDELO_COMMON_MEMORY_PROFILE!),artifact.path,{entry:'browser-lto-fork.mjs'});
 const browser=await playwright[browserName].launch(info.project.use.launchOptions);
 const page=await browser.newPage(),evidence:any={version:browser.version(),pageErrors:[]};
 page.on('pageerror',error=>evidence.pageErrors.push(String(error)));
 try{
  await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).run==='function');
  Object.assign(evidence,await page.evaluate(c=>(window as any).run(c),control));
  expect(evidence.pageErrors).toEqual([]);expect(evidence.error).toBeUndefined();
  expect(evidence.passed).toBe(true);expect(evidence.destroyed).toBe(true);expect(evidence.artifactSha256).toBe(artifact.sha256);
 }finally{
  const output=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);await mkdir(output,{recursive:true});
  await writeFile(resolve(output,`${info.project.name}-${control.id}.json`),JSON.stringify(evidence,null,2)+'\n');
  await browser.close();await server.close();
 }
});
