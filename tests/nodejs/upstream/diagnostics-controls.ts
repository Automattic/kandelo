import {readFileSync} from 'node:fs';
export const diagnosticsFixture='tests/nodejs/upstream/diagnostics-engine-controls.js';
const prefix=readFileSync(diagnosticsFixture,'utf8'),marker='// @shared-diagnostics-controls';if(prefix.split(marker).length!==2)throw Error('diagnostics fixture marker must occur once');
const source=prefix.replace(marker,readFileSync('tests/nodejs/upstream/diagnostics-shared-controls.js','utf8'));
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),binding=realm.internalBinding('diagnostics_channel'),dc=realm.require('diagnostics_channel');`;
const roots=setup+`const name='diagnostics-exit';api.diagnosticsNative('get',name);dc.channel(name).subscribe(()=>{throw Error('DIAGNOSTICS_PUBLISH_MUST_NOT_RUN')});api.diagnosticsNative('status',name,()=>{throw Error('DIAGNOSTICS_STATUS_MUST_NOT_RUN')});print('DIAGNOSTICS_ROOTS_ARMED');`;
export const diagnosticsCases=[
 {name:'whole-native-diagnostics-storage-ownership-and-original-js',source,code:0},
 {name:'original-principal-bootstrap-passes-real-diagnostics',source:`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();let error;try{api.runNodeBootstrap()}catch(caught){error={name:caught.name,message:caught.message,code:caught.code,stack:caught.stack}}print(JSON.stringify({error,realm:api.inspectRealm(),startupAccepted:false}));`,code:0},
 {name:'nonfunction-native-linker-remains-fatal',source:setup+`binding.linkNativeChannel(0)`,code:132,trap:true,stderr:'args[0]->IsFunction()'},
 {name:'negative-active-index-remains-fatal',source:setup+`binding.notifyChannelActive(-1)`,code:132,trap:true,stderr:'args[0]->IsUint32()'},
 {name:'string-inactive-index-remains-fatal',source:setup+`binding.notifyChannelInactive('1')`,code:132,trap:true,stderr:'args[0]->IsUint32()'},
 {name:'real-native-publish-result-drains-promise-jobs',source:setup+`const name='diagnostics-job',channel=dc.channel(name);channel.subscribe(()=>{});channel.publish=()=>Promise.resolve().then(()=>print('DIAGNOSTICS_JOB_DONE'));api.diagnosticsNative('get',name);api.diagnosticsNative('publish',name,{});`,code:0,stdout:'DIAGNOSTICS_JOB_DONE'},
 {name:'natural-exit-with-real-native-channels-and-roots',source:roots,code:0,stdout:'DIAGNOSTICS_ROOTS_ARMED'},
 {name:'explicit-quit-with-real-native-channels-and-roots',source:roots+'quit(23)',code:23,stdout:'DIAGNOSTICS_ROOTS_ARMED'},
 {name:'uncaught-error-with-real-native-channels-and-roots',source:roots+`throw Error('DIAGNOSTICS_UNCAUGHT')`,code:3,stdout:'DIAGNOSTICS_ROOTS_ARMED',stderr:'DIAGNOSTICS_UNCAUGHT'},
 {name:'real-foreground-cleanup-retires-binding-and-native-channels',source:roots+`api.environment('armExit');`,code:0,stdout:'DIAGNOSTICS_ROOTS_ARMED\nENVIRONMENT_CLEANUP_DONE'},
];
export function verifyDiagnosticsResult(control:typeof diagnosticsCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if('trap'in control){if(result.exitCode!==control.code||!result.stderr.includes(control.stderr!)||result.hostDiagnostics.length!==1)throw Error(JSON.stringify(result));return{status:'expected-original-native-contract-assertion'}}
 if(result.exitCode!==control.code||result.hostDiagnostics.length)throw Error(JSON.stringify(result));
 if('stderr'in control){if(!result.stderr.includes(control.stderr!))throw Error(result.stderr)}else if(result.stderr)throw Error(result.stderr);
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(result.stdout);return{status:'pass'}}
 const detail=JSON.parse(result.stdout);
 if(control.name==='original-principal-bootstrap-passes-real-diagnostics'){
  if(detail.error?.name!=='Error'||detail.error?.code!=='ERR_KANDELO_NOT_IMPLEMENTED'||detail.error?.message!=="Native Node binding 'process_methods' is not implemented"||!detail.error.stack.includes('node:internal/process/per_thread:68:')||!detail.error.stack.includes('node:internal/bootstrap/node:152:')||detail.realm.nodeBootstrapPhase!==3||!detail.realm.compiledBuiltinIds.includes('diagnostics_channel')||detail.startupAccepted!==false)throw Error(JSON.stringify(detail));return detail;
 }
 if(detail.cases!==27||detail.sharedCases!==12||detail.failures||detail.observations.some((r:any)=>r.status!=='pass')||detail.wholeOriginalNativeUnit!==true||detail.upstreamStartup!==false)throw Error(JSON.stringify(detail));
 const native=JSON.parse(readFileSync('tests/nodejs/upstream/diagnostics-native-reference.json','utf8')).detail;
 if(JSON.stringify(detail.observations.slice(0,12))!==JSON.stringify(native.observations))throw Error('diagnostics observations differ from authenticated native reference');detail.exactNativeGroups=12;return detail;
}
