import {test,expect} from '../../../../apps/browser-demos/playwright-test';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {resolveBinary} from '../../../../host/src/binary-resolver';
import {functionCompilerCases,verifyFunctionCompilerResult,functionCompilerFixture,functionCompilerSharedFixture} from '../function-compiler-controls';

const program=process.env.KANDELO_NODE_FUNCTION_COMPILER_ENGINE_WASM;
if(!program||!isAbsolute(program))throw Error('KANDELO_NODE_FUNCTION_COMPILER_ENGINE_WASM must identify the absolute engine artifact');
const kernel=resolveBinary('kernel.wasm');
function identity(path:string){const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}

test('native function-body compiler preserves scope, source, roots and jobs',async({page,baseURL,browser},testInfo)=>{
 test.setTimeout(180_000);
 const errors:string[]=[],resources:Array<Record<string,unknown>>=[],responses:Promise<void>[]=[];
 page.on('pageerror',error=>errors.push('pageerror: '+error.message));
 page.on('console',message=>{if(message.type()==='error')errors.push('console: '+message.text())});
 page.on('requestfailed',request=>errors.push('requestfailed: '+request.url()+' '+request.failure()?.errorText));
 page.on('response',response=>{
  if(response.url().includes('.wasm')&&!response.url().includes('js.wasm')&&!response.url().includes('?import'))responses.push((async()=>{
   const bytes=await response.body();resources.push({url:response.url(),status:response.status(),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  })());
 });
 let result,detail,failure;const runs:Array<Record<string,unknown>>=[];
 try{
  await page.goto(new URL('/pages/test-runner/?minimal=1',baseURL).href);
  await page.waitForFunction(()=>(window as any).__testRunnerReady===true);
  const moduleUrl=new URL('/@fs/'+resolve('tests/nodejs/upstream/function-compiler-browser/artifact-url.ts'),baseURL).href;
  const programUrl=await page.evaluate(async url=>(await import(url)).default as string,moduleUrl);
  for(const control of functionCompilerCases){
  const observed=await page.evaluate(async({url,source})=>{
   const response=await fetch(url);if(!response.ok)throw Error('engine fetch failed: '+response.status);
   const bytes=await response.arrayBuffer(),hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
   const sha256=Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('');
   const result=await (window as any).__runTest(bytes,['js','--kandelo-test-upstream','-e',source],60_000,{seedEtc:false,env:['PATH=/usr/bin:/bin']});
   return {artifact:{url:response.url,bytes:bytes.byteLength,sha256},result};
  },{url:programUrl,source:control.source});
  result=observed.result;resources.push(observed.artifact);
  expect(observed.artifact.bytes).toBe(identity(program).bytes);expect(observed.artifact.sha256).toBe(identity(program).sha256);
  detail=verifyFunctionCompilerResult(control,result);runs.push({name:control.name,status:"pass",result,detail});
  }
  await Promise.all(responses);expect(resources.some(item=>item.sha256===identity(kernel).sha256)).toBe(true);expect(errors).toEqual([]);
 }catch(caught){failure=caught instanceof Error?{name:caught.name,message:caught.message,stack:caught.stack}:String(caught);throw caught}
 finally{
  await Promise.allSettled(responses);
  writeFileSync(join(process.env.KANDELO_LIBUV_REPORT_DIR!,'function-compiler-'+testInfo.project.name+'.json'),JSON.stringify({
   schema:1,completedAt:new Date().toISOString(),host:testInfo.project.name,browserVersion:browser.version(),
   scope:'Shared native function-body compiler; snapshot binding/startup/full conformance remain incomplete',program:identity(program),kernel:identity(kernel),
   fixtures:[identity(resolve(functionCompilerFixture)),identity(resolve(functionCompilerSharedFixture))],sources:functionCompilerCases.map(({name,source})=>({name,sha256:createHash('sha256').update(source).digest('hex')})),resources,errors,runs,failure,
  },null,2)+'\n');
 }
});
