import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {resolveBinary} from '../host/src/binary-resolver';
import {runCentralizedProgram} from '../host/test/centralized-test-helper';
import {bufferMemorySource,verifyBufferMemoryResult,bufferMemoryFixture,bufferDetachSharedFixture} from '../tests/nodejs/upstream/buffer-memory-controls';
const [program,report]=process.argv.slice(2);
if(!program||!report)throw Error('usage: tsx scripts/run-nodejs-buffer-memory-controls.ts <js.wasm> <report.json>');
function identity(path:string){const bytes=readFileSync(path);return{path:resolve(path),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}
const kernel=resolveBinary('kernel.wasm');let result,detail,failure;
try{
 result=await runCentralizedProgram({programPath:resolve(program),kernelWasmBytes:readFileSync(kernel),useDefaultRootfs:false,argv:['js','--kandelo-test-upstream','-e',bufferMemorySource],env:['PATH=/usr/bin:/bin'],timeout:60000});
 detail=verifyBufferMemoryResult(result);
}catch(caught){failure=caught instanceof Error?{name:caught.name,message:caught.message,stack:caught.stack}:String(caught)}
writeFileSync(report,JSON.stringify({scope:'Native engine Buffer memory prerequisite; original Buffer binding and startup remain incomplete',program:identity(program),kernel:identity(kernel),fixtures:[identity(bufferMemoryFixture),identity(bufferDetachSharedFixture)],sourceSha256:createHash('sha256').update(bufferMemorySource).digest('hex'),result,detail,failure},null,2)+'\n');
console.log(JSON.stringify({cases:detail?.cases,failures:failure?1:0}));if(failure)process.exitCode=1;
