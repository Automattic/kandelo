import {test,expect} from '../../../tests/playwright-test';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {serve} from '../server.mjs';
test('byte snapshots preserve conversions, hooks and independent output',async({page,browser},info)=>{
 const root=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);const server=await serve(root);
 const evidence:any={version:browser.version(),pageErrors:[]};page.on('pageerror',e=>evidence.pageErrors.push(String(e)));
 try {
  await page.goto(server.url+'/artifacts/index.html');await page.waitForFunction(()=>typeof(window as any).run==='function');
  Object.assign(evidence,await page.evaluate(()=>(window as any).run()));
  expect(evidence.pageErrors).toEqual([]);expect(evidence.result.passed).toBe(true);expect(evidence.crossOriginIsolated).toBe(true);
 }catch(error){evidence.error=String(error);throw error;}
 finally{await writeFile(resolve(root,info.project.name+'-result.json'),JSON.stringify(evidence,null,2)+'\n');await server.close();}
});
