import {test,expect} from '../../../apps/browser-demos/playwright-test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import http from 'node:http';
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures,memoryBoundaryRealmId} from '../../../apps/browser-demos/test/support/browser-memory-boundary';

for(const backend of ['sqlite','mariadb'])test(backend+' observes cached WordPress source edits',async({playwright,browserName},info)=>{
  const profile=process.env.KANDELO_COMMON_MEMORY_PROFILE;
  const image=process.env.KANDELO_COMMON_MEMORY_IMAGE;
  const kernel=process.env.KANDELO_COMMON_MEMORY_KERNEL;
  const output=process.env.KANDELO_COMMON_MEMORY_ARTIFACTS;
  const cycles=Number(process.env.KANDELO_COMMON_MEMORY_CYCLES??'1');
  if(!Number.isInteger(cycles)||cycles<1||cycles>4)throw Error('cycles must be an integer from 1 to 4');
  if(!profile||!image||!kernel||!output)throw Error('set explicit profile, image, kernel and artifacts paths');
  const files=new Map([
    ['/kernel.wasm',resolve(kernel)],['/wordpress.vfs.zst',resolve(image)],
    ['/browser-freshness.mjs',resolve('tools/common-memory-program/wordpress/browser-freshness.mjs')],
    ['/freshness.mjs',resolve('tools/common-memory-program/wordpress/freshness.mjs')],
  ]);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    try {
      const path=new URL(req.url!,'http://localhost').pathname;
      if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><script type="module" src="/browser-freshness.mjs"></script>');return;}
      const file=files.get(path)??(/^\/artifacts\/[a-z-]+\.mjs$/.test(path)?resolve(profile,path.slice(11)):undefined);
      if(!file)throw Error('unknown fixture path');
      res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':'application/octet-stream');res.end(await readFile(file));
    } catch {res.writeHead(404).end();}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const browser=await playwright[browserName].launch(info.project.use.launchOptions),result:any={backend,version:browser.version()};
  try {
    const page=await browser.newPage();await installBrowserMemoryBoundaryProbe(page);
    result.pageErrors=[];result.progress=[];
    page.on('pageerror',error=>result.pageErrors.push(String(error)));
    await page.exposeFunction('reportWordPressProbe',(value:unknown)=>result.progress.push(value));
    await page.goto('http://127.0.0.1:'+(server.address()as any).port);
    await page.waitForFunction(()=>typeof(window as any).run==='function');
    const realm=await memoryBoundaryRealmId(page);result.runs=[];
    for(let cycle=0;cycle<cycles;cycle++){
      result.run=await page.evaluate(backend=>(window as any).run(backend),backend);
      result.runs.push(result.run);
      expect(result.pageErrors).toEqual([]);
      expect(result.run.passed,JSON.stringify(result.run)).toBe(true);expect(result.run.destroyed).toBe(true);
      expect(await memoryBoundaryRealmId(page)).toBe(realm);
      result.memoryBoundaryFailures=await memoryBoundaryFailures(page);
      expect(result.memoryBoundaryFailures).toEqual([]);
    }
  } finally {
    await mkdir(output,{recursive:true});await writeFile(resolve(output,`${info.project.name}-${backend}.json`),JSON.stringify(result,null,2)+'\n');
    await browser.close();await new Promise<void>(r=>server.close(()=>r()));
  }
});
