import {test,expect} from '../../../tests/playwright-test';
import {mkdir,writeFile} from 'node:fs/promises';import {resolve}from'node:path';import {serve}from'./server.mjs';
for(const mode of ['baseline','reuse'])test('mapped payload ownership '+mode,async({page,browser},info)=>{
 const root=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);const server=await serve(root,resolve(root,'grow-helper.wasm'),{entry:'reuse-page.mjs'});const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
 try{await page.goto(server.url);await page.waitForFunction(()=>(window as any).reuseFixtureReady===true);const result=await page.evaluate(mode=>new Promise((resolve,reject)=>{const worker=new Worker('/reuse-worker.mjs',{type:'module'});worker.onmessage=({data})=>{worker.terminate();resolve(data);};worker.onerror=e=>{worker.terminate();reject(String(e.message));};worker.postMessage({mode});}),mode);
 await mkdir(root,{recursive:true});await writeFile(resolve(root,info.project.name+'-'+mode+'.json'),JSON.stringify({version:browser.version(),errors,...result as any},null,2)+'\n');expect((result as any).passed).toBe(true);expect((result as any).pumpGrowthPages).toBe(mode==='reuse'?0:128);expect(errors).toEqual([]);
 }finally{await server.close();}
});
