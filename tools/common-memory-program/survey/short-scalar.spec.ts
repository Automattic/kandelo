import {test,expect} from '../../../tests/playwright-test';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {serve} from '../server.mjs';
for(const mode of ['baseline','dataview','typed'])test(`short scalar ${mode}`,async({page,browser},info)=>{
 const root=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);const server=await serve(root);
 const result:any={mode,version:browser.version(),errors:[]};page.on('pageerror',e=>result.errors.push(String(e)));
 try{await page.goto(server.url+'/artifacts/index.html');await page.waitForFunction(()=>typeof(window as any).run==='function');
  result.run=await page.evaluate(m=>(window as any).run(m),mode);expect(result.run.result.passed).toBe(true);expect(result.run.crossOriginIsolated).toBe(true);expect(result.errors).toEqual([]);
 }catch(e){result.error=String(e);throw e;}
 finally{writeFileSync(resolve(root,`${info.project.name}-${mode}.json`),JSON.stringify(result,null,2)+'\n');await server.close();}
});
