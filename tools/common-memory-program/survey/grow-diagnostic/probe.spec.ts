import {test,expect} from '../../../../tests/playwright-test';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
for(const retireWhileActive of [false,true]) {
  test(`standalone shared growth; retire active=${retireWhileActive}`,async({playwright,browserName},info)=>{
    const html=await readFile(resolve('tools/common-memory-program/survey/grow-diagnostic/index.html'));
    const server=createServer((_req,res)=>{
      res.writeHead(200,{'Content-Type':'text/html','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});res.end(html);
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const browser=await playwright[browserName].launch(info.project.use.launchOptions),page=await browser.newPage();
    const evidence:any={version:browser.version(),retireWhileActive,events:[],passed:false};
    page.on('crash',()=>evidence.events.push('page crash'));page.on('pageerror',e=>evidence.events.push(String(e)));
    try {
      const address=server.address() as {port:number};await page.goto(`http://127.0.0.1:${address.port}/`);
      evidence.result=await page.evaluate(options=>(window as any).runDiagnostic(options),{groups:12,workers:4,width:32,durationMs:150,retireWhileActive});
      expect(evidence.result.error).toBeUndefined();expect(evidence.result.passed).toBe(true);
      expect(evidence.result.groups).toHaveLength(12);expect(evidence.events).toEqual([]);evidence.passed=true;
    } catch(error){evidence.error=String(error);throw error;}
    finally {
      const repeat=info.repeatEachIndex?`-repeat${info.repeatEachIndex}`:'';
      await writeFile(resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!,`${info.project.name}-retire${retireWhileActive}${repeat}.json`),JSON.stringify(evidence,null,2)+'\n');
      await browser.close();await new Promise<void>(r=>server.close(()=>r()));
    }
  });
}
