import {scopedCatchCases} from './scoped-catch-controls';
import {readFileSync} from 'node:fs';
import {asyncResourcePrimitiveCases} from './async-resource-primitives-controls';
import {diagnosticsCases,verifyDiagnosticsResult} from './diagnostics-controls';
import {bufferCases,verifyBufferResult} from './buffer-controls';
import {aliasedCases,verifyAliasedResult} from './aliased-controls';
import {environmentCases,verifyEnvironmentResult} from './environment-controls';
export const nativeOwnerFixture='tests/nodejs/upstream/native-owner-engine-controls.js';
export const nativeOwnerSourceFiles=['tests/nodejs/upstream/scoped-catch-controls.ts','tests/nodejs/upstream/async-resource-primitives-controls.ts',nativeOwnerFixture,'tests/nodejs/upstream/native-owner-controls.ts',
 'tests/nodejs/upstream/diagnostics-controls.ts','tests/nodejs/upstream/diagnostics-engine-controls.js','tests/nodejs/upstream/diagnostics-shared-controls.js','tests/nodejs/upstream/diagnostics-native-reference.json',
 'tests/nodejs/upstream/buffer-controls.ts','tests/nodejs/upstream/buffer-engine-controls.js','tests/nodejs/upstream/buffer-shared-controls.js','tests/nodejs/upstream/buffer-native-reference.json',
 'tests/nodejs/upstream/aliased-controls.ts','tests/nodejs/upstream/aliased-engine-controls.js',
 'tests/nodejs/upstream/environment-controls.ts','tests/nodejs/upstream/environment-engine-controls.js'];
const source=readFileSync(nativeOwnerFixture,'utf8');
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const op=(name,...args)=>api.nativeOwners(name,...args);`;
export const nativeOwnerCases=[
 ...scopedCatchCases,
 ...asyncResourcePrimitiveCases,
 {name:'canonical-native-ownership-gc-reentry-and-real-uv-close',source,code:0},
 {name:'private-probe-explicitly-rejects-process-methods',source:setup+`let error;try{realm.internalBinding('process_methods')}catch(caught){error=caught}if(!error||!error.message.includes('private native-owner diagnostic build'))throw Error('missing diagnostic boundary');print('OWNER_DIAGNOSTIC_ONLY');`,code:0,stdout:'OWNER_DIAGNOSTIC_ONLY'},
 {name:'native-destruction-callback-job-is-drained',source:setup+`const object=op('create'),ref=op('hold',object);op('onDestroy',object,()=>Promise.resolve().then(()=>print('OWNER_JOB_DONE')));op('detach',object);op('release',ref);`,code:0,stdout:'OWNER_JOB_DONE'},
 // No private poll call: the real engine loop must run the uv close callback.
 // Otherwise native retirement hits the probe destructor's !opened_ invariant.
 {name:'real-engine-loop-drains-native-close-before-retirement',source:setup+`const object=op('create',true);op('close',object);print('OWNER_CLOSE_PENDING');`,code:0,stdout:'OWNER_CLOSE_PENDING'},
 {name:'original-diagnostics-remains-coherent-with-canonical-native-cells',source:setup+`const dc=realm.require('diagnostics_channel'),name='owner-regression';api.diagnosticsNative('get',name);let called=0;const callback=()=>called++;dc.channel(name).subscribe(callback);gc();api.diagnosticsNative('publish',name,{});dc.channel(name).unsubscribe(callback);if(called!==1)throw Error('native diagnostics identity/lifetime');print('OWNER_DIAGNOSTICS_OK');`,code:0,stdout:'OWNER_DIAGNOSTICS_OK'},
 // Select the existing complete positive fixtures explicitly. Startup drivers
 // remain separate because this private profile deliberately rejects startup.
 {...diagnosticsCases[0],validate:(result:NativeOwnerResult)=>verifyDiagnosticsResult(diagnosticsCases[0],result)},
 {...bufferCases[0],validate:(result:NativeOwnerResult)=>verifyBufferResult(bufferCases[0],result)},
 {...aliasedCases[0],validate:(result:NativeOwnerResult)=>verifyAliasedResult(aliasedCases[0],result)},
 {...environmentCases[0],validate:(result:NativeOwnerResult)=>verifyEnvironmentResult(environmentCases[0],result)},
];
type NativeOwnerResult={exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]};
export function verifyNativeOwnerResult(control:typeof nativeOwnerCases[number],result:NativeOwnerResult){
 if('validate'in control)return control.validate(result);
 if(result.exitCode!==control.code||result.stderr!==('stderr'in control?control.stderr:'')||result.hostDiagnostics.length)throw Error(JSON.stringify(result));
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(result.stdout);return{status:'pass'}}
 const detail=JSON.parse(result.stdout);if(detail.failures!==0||detail.diagnosticOnly!==true||detail.startupAccepted!==false||detail.results.length!==12||detail.results.some((r:{status:string})=>r.status!=='pass'))throw Error(result.stdout);return detail;
}
