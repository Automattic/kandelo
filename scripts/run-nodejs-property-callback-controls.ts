import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {resolveBinary} from '../host/src/binary-resolver';
import {runCentralizedProgram} from '../host/test/centralized-test-helper';
import {propertyCallbackCases,propertyCallbackFixture,verifyPropertyCallbackResult} from '../tests/nodejs/upstream/property-callback-controls';
const [program,report]=process.argv.slice(2);
if(!program||!report)throw Error('usage: tsx scripts/run-nodejs-property-callback-controls.ts <js.wasm> <report.json>');
function identity(path:string){const bytes=readFileSync(path);return{path:resolve(path),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}
const kernel=resolveBinary('kernel.wasm'),runs:Record<string,unknown>[]=[];let failures=0;
for(const control of propertyCallbackCases){
 let result;
 try{
  result=await runCentralizedProgram({programPath:resolve(program),kernelWasmBytes:readFileSync(kernel),useDefaultRootfs:false,argv:['js','--kandelo-test-upstream','-e',control.source],env:['PATH=/usr/bin:/bin'],timeout:60000});
  runs.push({name:control.name,status:'pass',result,detail:verifyPropertyCallbackResult(control,result)});
 }catch(caught){failures++;runs.push({name:control.name,status:'fail',result,error:caught instanceof Error?{name:caught.name,message:caught.message,stack:caught.stack}:String(caught)})}
}
writeFileSync(report,JSON.stringify({scope:'Live native data properties; process_methods and startup remain incomplete',program:identity(program),kernel:identity(kernel),fixture:identity(propertyCallbackFixture),sources:propertyCallbackCases.map(({name,source})=>({name,sha256:createHash('sha256').update(source).digest('hex')})),runs,failures},null,2)+'\n');
console.log(JSON.stringify({runs:runs.length,failures}));if(failures)process.exitCode=1;
