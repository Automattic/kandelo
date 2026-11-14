import {test,expect} from '../../../tests/playwright-test';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serve} from '../server.mjs';
for(const mode of ['affine','affine-small','bench'])test('affine cache '+mode,async({page,browser},info)=>{
 const out=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);const server=await serve(out);const result:any={version:browser.version(),events:[]};
 page.on('pageerror',e=>result.events.push(String(e)));
 try{
  await page.goto(server.url+'/artifacts/index.html');await page.waitForFunction(()=>typeof(window as any).run==='function');
  result.run=await page.evaluate(mode=>(window as any).run(mode),mode);
  expect(result.run.passed,JSON.stringify(result.run)).toBe(true);expect(result.events).toEqual([]);
 }finally{await mkdir(out,{recursive:true});await writeFile(resolve(out,info.project.name+'-'+mode+'.json'),JSON.stringify(result,null,2)+'\n');await server.close();}
});
