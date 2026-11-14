import {test,expect} from '../../../tests/playwright-test';
import {serve} from './server.mjs';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadavg,cpus,totalmem} from 'node:os';
const orders=[['native-file','vm-shared','vm-file','native-file'],['native-file','vm-file','vm-shared','native-file']];
for(let cohort=0;cohort<2;cohort++) for(const [order,label] of orders[cohort].entries()) {
  test(`cohort ${cohort} order ${order} ${label}`,async ({playwright,browserName},testInfo)=>{
    const profile=resolve(process.env.KANDELO_COMMON_MEMORY_PROFILE!);
    const artifact=resolve(process.env.KANDELO_COMMON_MEMORY_FPM!);
    const nativeArtifact=resolve(process.env.KANDELO_COMMON_MEMORY_NATIVE_FPM!);
    const out=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
    const server=await serve(profile,artifact,{nativeArtifact,entry:'browser-benchmark.mjs'});
    const result:any={cohort,order,label,loadBefore:loadavg(),cpus:cpus().length,totalMemory:totalmem()};
    // Each control gets a fresh engine parent process. Controls never hold
    // multiple guest memory reservations concurrently in one browser parent.
    const browser=await playwright[browserName].launch(testInfo.project.use.launchOptions);
    try {
      const page=await browser.newPage();
      const errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));
      await page.goto(server.url);
      await page.waitForFunction(()=>typeof(window as any).runBenchmark==='function');
      result.run=await page.evaluate(async ({label,seed,rounds,warmup})=>(window as any).runBenchmark(label,{seed,rounds,warmup}),
        {label,seed:6197+cohort,rounds:Number(process.env.KANDELO_BENCH_ROUNDS??7),warmup:Number(process.env.KANDELO_BENCH_WARMUP??16)});
      result.version=browser.version();result.pageErrors=errors;result.loadAfter=loadavg();
      await writeFile(resolve(out,`${testInfo.project.name}-${cohort}-${order}-${label}.json`),JSON.stringify(result,null,2)+'\n');
      expect(errors).toEqual([]);expect(result.run.error).toBeUndefined();expect(result.run.trial?.error).toBeUndefined();
      expect(result.run.trial?.passed).toBe(true);expect(result.run.destroyed).toBe(true);
      expect(result.run.stderr).toEqual([]);expect(result.run.diagnostics).toEqual([]);
    } finally {await browser.close();await server.close();}
  });
}
