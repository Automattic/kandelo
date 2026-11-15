import {test,expect} from '../../../tests/playwright-test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serve} from '../platform/server.mjs';
for(const mode of ['baseline','fuse-small','object-guard','object-guard-fused','ordinary-negative']) {
 test(`real fork reenters object callees: ${mode}`,async({playwright,browserName},info)=>{
  const root=resolve(process.env.KANDELO_OBJECT_FORK_ARTIFACTS!);
  const manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
  const artifact=mode==='ordinary-negative'?manifest.native:manifest.variants[mode].path;
  const server=await serve(resolve(process.env.KANDELO_COMMON_MEMORY_PROFILE!),artifact,{entry:'browser-object-fork.mjs'});
  const browser=await playwright[browserName].launch(info.project.use.launchOptions);
  const page=await browser.newPage();const evidence:any={mode,version:browser.version(),pageErrors:[]};
  page.on('pageerror',error=>evidence.pageErrors.push(String(error)));
  try {
   await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).run==='function');
   Object.assign(evidence,await page.evaluate(code=>(window as any).run(code),mode==='ordinary-negative'?26:0));
   expect(evidence.pageErrors).toEqual([]);expect(evidence.error).toBeUndefined();expect(evidence.passed).toBe(true);expect(evidence.destroyed).toBe(true);
  }finally{
   const output=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);await mkdir(output,{recursive:true});
   await writeFile(resolve(output,`${info.project.name}-${mode}.json`),JSON.stringify(evidence,null,2)+'\n');
   await browser.close();await server.close();
  }
 });
}
