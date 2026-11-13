import {readFileSync} from 'node:fs';
export const bufferFixture='tests/nodejs/upstream/buffer-engine-controls.js',bufferSharedFixture='tests/nodejs/upstream/buffer-shared-controls.js';
export const bufferSource=readFileSync(bufferFixture,'utf8').replace('// @shared-buffer-controls',readFileSync(bufferSharedFixture,'utf8'));
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),binding=realm.internalBinding('buffer');binding.setBufferPrototype(realm.require('internal/buffer').FastBuffer.prototype);globalThis.retainedOriginalBuffer=api.bufferNative('armExit',Uint8Array.of(1,2,3));`;
export const bufferCases=[
 {name:'whole-source-binding-and-original-callbackinfo',source:bufferSource,code:0},
 {name:'actual-zero-fill-cli-option-initializes-native-allocation',code:0,stdout:'NATIVE_ZERO_FILL_DONE',source:`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();api.configureOptions(['node','--zero-fill-buffers'],'');const binding=realm.internalBinding('buffer');const value=binding.createUnsafeArrayBuffer(65536);if(!new Uint8Array(value).every(byte=>byte===0))throw Error('native zero-fill option ignored');print('NATIVE_ZERO_FILL_DONE')`},
 {name:'source-principal-prototype-assertion-rejects-shadow-realm',code:132,trap:true,stderr:'realm->kind()',source:`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const global=newGlobal({newCompartment:true});api.initializeContext(global);const other=api.initializeRealm(global);other.internalBinding('buffer').setBufferPrototype({});`},
 {name:'natural-exit-cleans-original-callbackinfo',source:setup,code:0,stdout:'ORIGINAL_BUFFER_CALLBACK_DONE'},
 {name:'explicit-quit-cleans-original-callbackinfo',source:setup+'quit(23)',code:23,stdout:'ORIGINAL_BUFFER_CALLBACK_DONE'},
 {name:'uncaught-error-cleans-original-callbackinfo',source:setup+`throw Error('ORIGINAL_BUFFER_UNCAUGHT')`,code:3,stdout:'ORIGINAL_BUFFER_CALLBACK_DONE',stderr:'ORIGINAL_BUFFER_UNCAUGHT'},
];
export function verifyBufferResult(control:typeof bufferCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if('trap'in control){if(result.exitCode!==control.code||!result.stderr.includes(control.stderr!)||result.hostDiagnostics.length!==1)throw Error(JSON.stringify(result));return {status:'expected-source-assertion-trap'}}
 if(result.exitCode!==control.code||result.hostDiagnostics.length!==0)throw Error(JSON.stringify(result));
 if('stderr'in control){if(!result.stderr.includes(control.stderr!))throw Error(JSON.stringify(result))}else if(result.stderr!=='')throw Error(JSON.stringify(result));
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(JSON.stringify(result));return {status:'pass'}}
 const detail=JSON.parse(result.stdout);if(detail.failures||detail.sharedCases!==31||detail.cases!==44)throw Error(JSON.stringify(detail));
 const reference=JSON.parse(readFileSync('tests/nodejs/upstream/buffer-native-reference.json','utf8')).detail;
 const anomalies=[];let exactGroups=0;
 for(let i=0;i<31;++i){
  const engine=detail.observations[i],native=reference.observations[i];
  if(engine.name!==native.name)throw Error('native observation name changed');
  if(engine.name==='coercion-reentry-can-detach-buffer-without-pinning'){
   if(engine.detail.result!=='aaaa')throw Error('native backing retention lost its original bytes');
   anomalies.push({status:'native-reference-discrepancy',name:engine.name,engine:engine.detail,native:native.detail,evidence:'buffer-native-reentry-result.json',reason:'Authenticated native Node standalone reproduction returns bytes different from original input after detachment/GC. Retain the discrepancy; do not demand arbitrary released bytes as a target result.'});
  }else{if(JSON.stringify(engine)!==JSON.stringify(native))throw Error('original Buffer shared observation differs: '+engine.name);++exactGroups}
 }
 detail.nativeComparison={exactGroups,anomalies,bootstrapSetter:'excluded only from common descriptor comparison because original node.js deletes it during bootstrap; actual engine setter remains tested before bootstrap'};
 if(detail.upstreamStartup!==false)throw Error('binding checks cannot claim startup completion');return detail;
}
