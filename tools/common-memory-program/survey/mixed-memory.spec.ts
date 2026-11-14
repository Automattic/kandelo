import {test,expect} from '../../../tests/playwright-test';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {serve} from '../server.mjs';
test('Worker-owned mixed-tag pointer read/write cost',async({page,browser},info)=>{
 const root=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!),server=await serve(root);
 const result:any={version:browser.version(),launchArgs:info.project.use.launchOptions?.args??[],loadBefore:loadavg(),events:[]};
 page.on('pageerror',e=>result.events.push(String(e)));page.on('crash',()=>result.events.push('page crash'));
 try{
  await page.goto(server.url+'/artifacts/index.html');await page.waitForFunction(()=>typeof(window as any).runMixedMemory==='function');
  result.crossOriginIsolated=await page.evaluate(()=>crossOriginIsolated);
  result.probe=await page.evaluate(()=>(window as any).runMixedMemory());
  expect(result.crossOriginIsolated).toBe(true);expect(result.events).toEqual([]);
  expect(result.probe.passed,JSON.stringify(result.probe)).toBe(true);expect(result.probe.samples).toHaveLength(784);
 }finally{result.loadAfter=loadavg();await writeFile(resolve(root,info.project.name+'-result.json'),JSON.stringify(result,null,2)+'\n');await server.close();}
});
