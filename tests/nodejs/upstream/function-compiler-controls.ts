import {readFileSync} from 'node:fs';
export const functionCompilerFixture='tests/nodejs/upstream/function-compiler-engine-controls.js';
export const functionCompilerSharedFixture='tests/nodejs/upstream/function-compiler-shared-controls.js';
const source=readFileSync(functionCompilerFixture,'utf8').replace('// @shared-native-function-compiler-controls',readFileSync(functionCompilerSharedFixture,'utf8'));
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();`;
export const functionCompilerCases=[
 {name:'native-function-body-realm-source-and-gc',source,code:0},
 {name:'compiled-function-jobs-drain-on-natural-exit',source:setup+`const fn=api.compileFunctionBody(globalThis,'fixture:pending.js',"return Promise.resolve().then(()=>print('NATIVE_FUNCTION_JOB_DONE'))");fn();`,code:0,stdout:'NATIVE_FUNCTION_JOB_DONE'},
 {name:'explicit-quit-inside-native-compiled-body',source:setup+`api.compileFunctionBody(globalThis,'fixture:quit.js','quit(23)')();`,code:23,stdout:''},
 {name:'uncaught-error-preserves-compiled-body-origin',source:setup+`api.compileFunctionBody(globalThis,'fixture:uncaught-native-function.js',"throw Error('NATIVE_FUNCTION_UNCAUGHT')")();`,code:3,stdout:'',stderr:'NATIVE_FUNCTION_UNCAUGHT'},
];
export function verifyFunctionCompilerResult(control:typeof functionCompilerCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if(result.exitCode!==control.code||result.hostDiagnostics.length!==0)throw Error(JSON.stringify(result));
 if('stderr'in control){if(!result.stderr.includes(control.stderr!)||!result.stderr.includes('fixture:uncaught-native-function.js'))throw Error(JSON.stringify(result))}else if(result.stderr!=='')throw Error(JSON.stringify(result));
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(JSON.stringify(result));return {status:'pass'}}
 const detail=JSON.parse(result.stdout);if(detail.failures!==0||detail.cases!==25||detail.sharedCases!==21||detail.observations.length!==25||detail.observations.some((row:any)=>row.status!=='pass')||detail.upstreamStartup!==false)throw Error(JSON.stringify(detail));
 const native=JSON.parse(readFileSync('tests/nodejs/upstream/function-compiler-native-reference.json','utf8')).detail;
 if(JSON.stringify(detail.observations.slice(0,21))!==JSON.stringify(native.observations))throw Error('compiler observations differ from authenticated native Node');
 detail.nativeComparison={exactGroups:21,scope:'Original Node vm/contextify reaches V8 ScriptCompiler; guest checks underlying native compiler only, not a mksnapshot/contextify binding'};return detail;
}
