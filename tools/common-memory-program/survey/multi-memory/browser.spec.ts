import {test,expect} from '../../../../tests/playwright-test';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serve} from '../../server.mjs';
test('Worker-owned private/shared memories and import alias control',async({page,browser},info)=>{
 const root=resolve(process.env.KANDELO_MULTI_MEMORY_ARTIFACTS!);const server=await serve(root);
 const result:any={version:browser.version(),pageErrors:[]};page.on('pageerror',e=>result.pageErrors.push(String(e)));
 try {
  await page.goto(server.url+'/artifacts/index.html');await page.waitForFunction(()=>typeof(window as any).runProbe==='function');
  result.crossOriginIsolated=await page.evaluate(()=>crossOriginIsolated);
  result.probe=await page.evaluate(()=>(window as any).runProbe());
  expect(result.crossOriginIsolated).toBe(true);expect(result.pageErrors).toEqual([]);expect(result.probe.passed).toBe(true);
 }finally{await writeFile(resolve(root,info.project.name+'-result.json'),JSON.stringify(result,null,2)+'\n');await server.close();}
});
