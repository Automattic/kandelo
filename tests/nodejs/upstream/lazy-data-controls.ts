import {readFileSync} from 'node:fs';
export const lazyDataFixture='tests/nodejs/upstream/lazy-data-engine-controls.js',lazyDataSharedFixture='tests/nodejs/upstream/lazy-data-shared-controls.js';
const source=readFileSync(lazyDataFixture,'utf8').replace('// @shared-native-lazy-data-controls',readFileSync(lazyDataSharedFixture,'utf8'));
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),define=realm.internalBinding('util').defineLazyProperties;`;
const retained=setup+`globalThis.lazyTarget={};api.defineNativeLazy(lazyTarget,'value',()=>{throw Error('MUST_NOT_LOAD_ON_EXIT')});print('NATIVE_LAZY_ARMED');`;
export const lazyDataCases=[
 {name:'native-lazy-data-semantics-and-holder-ownership',source,code:0},
 ...[
  ['argument-count',`define()`,'Lazy property argument count'],
  ['target-object',`define(0,'internal/util/types',[])`,'Lazy property target Object'],
  ['module-string',`define({},0,[])`,'Lazy property module String'],
  ['keys-array',`define({},'internal/util/types',{})`,'Lazy property keys Array'],
  ['enumerability-boolean',`define({},'internal/util/types',[],1)`,'Lazy property enumerability Boolean'],
  ['key-string',`define({},'internal/util/types',[1])`,'Lazy property key String'],
 ].map(([name,body,stderr])=>({name:'native-lazy-assertion-'+name,source:setup+body,code:132,trap:true,stderr})),
 {name:'actual-principal-bootstrap-advances-to-config-metadata',source:setup+`let error;try{api.runNodeBootstrap()}catch(caught){error={name:caught.name,code:caught.code,message:caught.message}}print(JSON.stringify({error,realm:api.inspectRealm(),startupAccepted:false}));`,code:0},
 {name:'native-lazy-promise-jobs-drain-on-natural-exit',source:setup+`const target={};api.defineNativeLazy(target,'value',()=>Promise.resolve().then(()=>print('NATIVE_LAZY_JOB_DONE')));target.value;`,code:0,stdout:'NATIVE_LAZY_JOB_DONE'},
 {name:'natural-exit-does-not-evaluate-unresolved-properties',source:retained,code:0,stdout:'NATIVE_LAZY_ARMED'},
 {name:'explicit-quit-with-unresolved-properties',source:retained+'quit(23)',code:23,stdout:'NATIVE_LAZY_ARMED'},
 {name:'uncaught-error-with-unresolved-properties',source:retained+`throw Error('NATIVE_LAZY_UNCAUGHT')`,code:3,stdout:'NATIVE_LAZY_ARMED',stderr:'NATIVE_LAZY_UNCAUGHT'},
];
export function verifyLazyDataResult(control:typeof lazyDataCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if('trap'in control){if(result.exitCode!==control.code||!result.stderr.includes(control.stderr!)||result.hostDiagnostics.length!==1)throw Error(JSON.stringify({exitCode:result.exitCode,stderr:result.stderr,hostDiagnostics:result.hostDiagnostics}));return{status:'expected-native-contract-assertion'}}
 if(result.exitCode!==control.code||result.hostDiagnostics.length!==0)throw Error(JSON.stringify({exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr,hostDiagnostics:result.hostDiagnostics}));
 if('stderr'in control){if(!result.stderr.includes(control.stderr!))throw Error(result.stderr)}else if(result.stderr!=='')throw Error(result.stderr);
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(result.stdout);return{status:'pass'}}
 const detail=JSON.parse(result.stdout);
 if(control.name==='actual-principal-bootstrap-advances-to-config-metadata'){
  if(detail.error?.name!=='Error'||detail.error?.code!=='ERR_KANDELO_NOT_IMPLEMENTED'||detail.error?.message!=='Requested native builtin metadata/cache/source-text backend is not implemented'||detail.realm.nodeBootstrapPhase!==3||detail.startupAccepted!==false)throw Error(JSON.stringify(detail));return detail;
 }
 if(detail.cases!==29||detail.sharedCases!==19||detail.failures||detail.observations.some((r:any)=>r.status!=='pass')||detail.upstreamStartup!==false)throw Error(JSON.stringify(detail));
 const native=JSON.parse(readFileSync('tests/nodejs/upstream/lazy-data-native-reference.json','utf8')).detail;
 if(JSON.stringify(detail.observations.slice(0,19))!==JSON.stringify(native.observations))throw Error('native lazy property observations differ from authenticated Node reference');
 detail.exactNativeGroups=19;return detail;
}
