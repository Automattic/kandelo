import {test,expect} from '../../../tests/playwright-test';
import {readFileSync} from 'node:fs';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serve} from '../server.mjs';
import {serveWordPressSurvey} from './wordpress-server.mjs';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
const out=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
test('access diagnostic mechanism',async({page,browser},info)=>{
 const server=await serve(resolve(process.env.KANDELO_ACCESS_MECHANISMS!));const result:any={version:browser.version(),events:[]};
 page.on('pageerror',e=>result.events.push(String(e)));
 try{await page.goto(server.url+'/artifacts/index.html');await page.waitForFunction(()=>typeof(window as any).run==='function');result.run=await page.evaluate(()=>(window as any).run());expect(result.run.passed).toBe(true);expect(result.run.checks).toBe(13);expect(result.events).toEqual([]);}
 finally{await mkdir(out,{recursive:true});await writeFile(resolve(out,info.project.name+'-mechanism.json'),JSON.stringify(result,null,2)+'\n');await server.close();}
});
test('WordPress dynamic access diagnostic',async({page,browser},info)=>{
 const server=await serveWordPressSurvey({profile:resolve(process.env.KANDELO_COMMON_MEMORY_PROFILE!),image:resolve('.scratch/common-memory-wordpress-1/wordpress.vfs.zst'),artifact:resolve(process.env.KANDELO_ACCESS_FPM!),wpConfig:renderWordPressConfig('selectable','/','http')});
 const result:any={diagnostic:'access-counts',version:browser.version(),events:[]};page.on('pageerror',e=>result.events.push(String(e)));
 try{
  await page.goto(server.url);await page.waitForFunction(()=>typeof(window as any).runWordPressSurvey==='function');
  result.run=await page.evaluate(async()=>{
   const {BrowserKernel}=await import('/artifacts/browser-kernel-host.mjs');
   const original=BrowserKernel.prototype.commonMemoryPrototypeStats,snapshots:any[]=[];
   BrowserKernel.prototype.commonMemoryPrototypeStats=async function(...args:any[]){const value=await original.apply(this,args);snapshots.push(await this.commonMemoryPrototypeAccessCounts());return value;};
   try{return {...await(window as any).runWordPressSurvey({label:'vm-shared',backend:'sqlite',warmup:2,rounds:1,seed:6197,validateTimestamps:true,checkTimestampPolicy:false,probeRequests:0}),diagnostic:'access-counts',snapshots};}
   finally{BrowserKernel.prototype.commonMemoryPrototypeStats=original;}
  });
  expect(result.run.error).toBeUndefined();expect(result.run.trial?.error).toBeUndefined();expect(result.run.trial?.passed).toBe(true);expect(result.run.destroyed).toBe(true);expect(result.run.diagnostics).toEqual([]);expect(result.run.stderr).toEqual([]);expect(result.events).toEqual([]);expect(result.run.crossOriginIsolated).toBe(true);expect(result.run.snapshots.length).toBe(4);
  const previous=new Map(result.run.snapshots[2].records.map((r:any)=>[`${r.pid}:${r.root}`,new Map(r.values)]));
  result.delta=result.run.snapshots[3].records.map((r:any)=>{const p:any=previous.get(`${r.pid}:${r.root}`);expect(p).toBeDefined();const values=r.values.map(([slot,value]:any)=>{const delta=BigInt(value)-BigInt(p.get(slot)??0);expect(delta>=0n).toBe(true);return [slot,delta.toString()];}).filter(([,v]:any)=>v!=='0');const total=values.filter(([s]:any)=>s<256).reduce((n:bigint,[,v]:any)=>n+BigInt(v),0n),functions=values.filter(([s]:any)=>s>=256).reduce((n:bigint,[,v]:any)=>n+BigInt(v),0n);expect(total).toBe(functions);return{pid:r.pid,root:r.root,total:total.toString(),values};});
  expect(result.delta.some((r:any)=>BigInt(r.total)>0n)).toBe(true);result.passed=true;
 }catch(error){result.error=String(error);throw error;}
 finally{await mkdir(out,{recursive:true});await writeFile(resolve(out,info.project.name+'-wordpress.json'),JSON.stringify(result,null,2)+'\n');await server.close();}
});
