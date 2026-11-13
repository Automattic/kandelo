import {test, expect} from '../../../../apps/browser-demos/playwright-test';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {resolveBinary} from '../../../../host/src/binary-resolver';
import {continuationCases, verifyContinuationResult} from '../continuation-controls';

const program = process.env.KANDELO_NODE_CONTINUATION_ENGINE_WASM;
if (!program || !isAbsolute(program)) throw Error('KANDELO_NODE_CONTINUATION_ENGINE_WASM must identify the absolute engine artifact');
const kernel=resolveBinary('kernel.wasm');
function identity(path:string) {const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}

test('continuation values follow real Promise and await jobs',async ({page,baseURL,browser},testInfo)=>{
  test.setTimeout(240_000);
  const errors:string[]=[], resources:Array<Record<string,unknown>>=[], responses:Promise<void>[]=[], runs:Array<Record<string,unknown>>=[];
  page.on('pageerror',error=>errors.push('pageerror: '+error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push('console: '+message.text());});
  page.on('requestfailed',request=>errors.push('requestfailed: '+request.url()+' '+request.failure()?.errorText));
  page.on('response',response=>{
    if(response.url().includes('.wasm')&&!response.url().includes('js.wasm')&&!response.url().includes('?import'))responses.push((async()=>{
      const bytes=await response.body();resources.push({url:response.url(),status:response.status(),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    })());
  });
  let failure:unknown;
  try {
    await page.goto(new URL('/pages/test-runner/?minimal=1',baseURL).href);
    await page.waitForFunction(()=>(window as any).__testRunnerReady===true);
    const moduleUrl=new URL('/@fs/'+resolve('tests/nodejs/upstream/continuation-browser/artifact-url.ts'),baseURL).href;
    const programUrl=await page.evaluate(async url=>(await import(url)).default as string,moduleUrl);
    for(const control of continuationCases){
      const observed=await page.evaluate(async ({url,source})=>{
        const response=await fetch(url);if(!response.ok)throw Error('engine fetch failed: '+response.status);
        const bytes=await response.arrayBuffer();
        const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
        const sha256=Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('');
        const result=await (window as any).__runTest(bytes,['js','--kandelo-test-upstream','-e',source],60_000,{seedEtc:false,env:['PATH=/usr/bin:/bin']});
        return {artifact:{url:response.url,bytes:bytes.byteLength,sha256},result};
      },{url:programUrl,source:control.source});
      const entry:Record<string,unknown>={name:control.name,status:'observed',result:observed.result};runs.push(entry);
      expect(observed.artifact.bytes).toBe(identity(program).bytes);
      expect(observed.artifact.sha256).toBe(identity(program).sha256);
      resources.push(observed.artifact);
      entry.detail=verifyContinuationResult(control,observed.result);
      entry.status='pass';
    }
    await Promise.all(responses);
    expect(resources.some(item=>item.sha256===identity(kernel).sha256)).toBe(true);
    expect(errors).toEqual([]);
  } catch(caught){
    failure=caught instanceof Error?{name:caught.name,message:caught.message,stack:caught.stack}:String(caught);
    throw caught;
  } finally {
    await Promise.allSettled(responses);
    writeFileSync(join(process.env.KANDELO_LIBUV_REPORT_DIR!,'continuation-'+testInfo.project.name+'.json'),JSON.stringify({
      schema:1,completedAt:new Date().toISOString(),host:testInfo.project.name,browserVersion:browser.version(),
      scope:'Raw continuation/native scope; four active original JS consumer checks remain blocked before genuine bootstrap',
      program:identity(program),kernel:identity(kernel),fixtures:[identity(resolve('tests/nodejs/upstream/continuation-engine-controls.js')),identity(resolve('tests/nodejs/upstream/continuation-shared-controls.js'))],resources,errors,runs,failure,
    },null,2)+'\n');
  }
});
