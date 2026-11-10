import {expect,test} from "../playwright-test";
import {fileURLToPath} from "node:url";
import {writeFileSync} from "node:fs";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
for (const mode of ["retargetReset","peerRetargetReset","allocationReset","refreshReset"]) test(`private image ${mode} preserves coherent healthy-peer storage`,async({page,browser})=>{
 await installBrowserMemoryBoundaryProbe(page); await page.goto("/trap-signal-test.html");
 const root=fileURLToPath(new URL("../../../",import.meta.url));
 const result=await page.evaluate(async ({root,mode})=>{
  const canvas=document.createElement("canvas");canvas.width=canvas.height=8;
  const worker=new Worker(new URL(`/@fs${root}apps/browser-demos/test/support/image-storage-worker.ts`,location.href),{type:"module"});
  try{return await new Promise<any>((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error("image reset worker timed out")),30000);
   worker.onerror=e=>{clearTimeout(timeout);reject(new Error(e.message));};
   worker.onmessage=({data})=>{clearTimeout(timeout);if(data.type==="image_storage_failed")reject(new Error(data.error));else resolve(data);};
   const offscreen=canvas.transferControlToOffscreen();worker.postMessage({canvas:offscreen,fault:mode},[offscreen]);
  });}finally{worker.terminate();}
 },{root,mode});
 writeFileSync(test.info().outputPath("result.json"),JSON.stringify({engine:test.info().project.name,version:browser.version(),mode,...result},null,2));
 expect(result).toMatchObject({type:"image_storage_reset",resetRc:-19,refused:-19,clean:true,nativeError:0});
 // A reset may follow accepted shared mutations. Whichever generation the
 // host published must remain coherent for both attachment and sampling.
 expect([0,1]).toContain(result.healthySource);
 const expected=result.healthySource===0?[0,0,255,255]:mode==="refreshReset"?[0,255,0,255]:[255,0,0,255];
 expect(result.healthyPixels).toEqual(expected);expect(result.sampledPixels).toEqual(expected);expect(result.afterRetirement).toEqual(expected);
 expect(await memoryBoundaryFailures(page)).toEqual([]);
 expect(result.diagnostics).toHaveLength(1);expect(result.diagnostics[0]).toContain(mode==="allocationReset"?"OUT_OF_MEMORY":mode==="refreshReset"?"unpredicted native error 0x502":"unpredicted native error 0x500");
});
