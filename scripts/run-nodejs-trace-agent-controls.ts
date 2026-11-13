import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {resolveBinary} from '../host/src/binary-resolver';
import {runCentralizedProgram} from '../host/test/centralized-test-helper';
import {traceAgentCases, verifyTraceAgentResult} from '../tests/nodejs/upstream/trace-agent-controls';

const [program, report] = process.argv.slice(2);
if (!program || !report || process.argv.length !== 4) throw Error('usage: tsx scripts/run-nodejs-trace-agent-controls.ts <js.wasm> <report.json>');
function identity(path: string) {const bytes=readFileSync(path);return {path:resolve(path),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
const kernel=resolveBinary('kernel.wasm'), runs: unknown[]=[];
const programIdentity=identity(program), kernelIdentity=identity(kernel);
let failures=0;
function record(completed:boolean,activeCase?:string) {
  writeFileSync(report,JSON.stringify({scope:'Original native agent linked to actual engine providers; not original trace_events binding or startup',
    program:programIdentity,kernel:kernelIdentity,completed,activeCase,cases:runs.length,failures,runs},null,2)+'\n');
}
for (const control of traceAgentCases) {
  record(false,control.name);
  console.log('starting '+control.name);
  let result;
  try {
    result=await runCentralizedProgram({programPath:resolve(program),kernelWasmBytes:readFileSync(kernel),useDefaultRootfs:false,
      argv:['js','--kandelo-test-upstream','-e',control.source],env:['PATH=/usr/bin:/bin'],timeout:60000});
    const detail=verifyTraceAgentResult(control,result);
    runs.push({name:control.name,status:'pass',result,detail});
  } catch(caught) {
    failures++;
    runs.push({name:control.name,status:'fail',result,error:caught instanceof Error?{name:caught.name,message:caught.message,stack:caught.stack}:String(caught)});
  }
  record(false);
}
record(true);
console.log(JSON.stringify({cases:runs.length,failures,report:resolve(report)}));
if(failures)process.exitCode=1;
