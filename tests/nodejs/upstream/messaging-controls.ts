import {readFileSync} from 'node:fs';
export const messagingFixture='tests/nodejs/upstream/messaging-engine-controls.js',messagingSharedFixture='tests/nodejs/upstream/messaging-shared-controls.js';
const prefix=readFileSync(messagingFixture,'utf8'),marker='// @shared-messaging-controls';if(prefix.split(marker).length!==2)throw Error('messaging fixture marker must occur once');
const source=prefix.replace(marker,readFileSync(messagingSharedFixture,'utf8'));
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),binding=realm.internalBinding('messaging');`;
const roots=setup+`binding.setDeserializerCreateObjectFunction(()=>{throw Error('MESSAGING_CALLBACK_MUST_NOT_RUN')});print('MESSAGING_ROOT_ARMED');`;
export const messagingCases=[
 {name:'native-messaging-registration-and-constructor-call-stage',source,code:0},
 {name:'original-principal-bootstrap-passes-real-messaging-setup',source:setup+`let error;try{api.runNodeBootstrap()}catch(caught){error={name:caught.name,message:caught.message,code:caught.code,stack:caught.stack}}print(JSON.stringify({error,realm:api.inspectRealm(),registered:typeof api.messagingNative('get')==='function',startupAccepted:false}));`,code:0},
 {name:'nonfunction-deserializer-registration-remains-fatal',source:setup+`binding.setDeserializerCreateObjectFunction(0)`,code:132,trap:true,stderr:'Messaging deserializer must be a Function'},
 {name:'missing-function-deserializer-registration-remains-fatal',source:setup+`binding.setDeserializerCreateObjectFunction()`,code:132,trap:true,stderr:'Messaging deserializer must be a Function'},
 {name:'unregistered-native-constructor-call-remains-fatal',source:setup+`api.messagingNative('call','info')`,code:132,trap:true,stderr:'Messaging deserializer is not registered'},
 {name:'real-native-constructor-call-result-drains-promise-jobs',source:setup+`binding.setDeserializerCreateObjectFunction(()=>Promise.resolve().then(()=>print('MESSAGING_JOB_DONE')));api.messagingNative('call','info');`,code:0,stdout:'MESSAGING_JOB_DONE'},
 {name:'natural-exit-with-rooted-messaging-function',source:roots,code:0,stdout:'MESSAGING_ROOT_ARMED'},
 {name:'explicit-quit-with-rooted-messaging-function',source:roots+'quit(23)',code:23,stdout:'MESSAGING_ROOT_ARMED'},
 {name:'uncaught-error-with-rooted-messaging-function',source:roots+`throw Error('MESSAGING_UNCAUGHT')`,code:3,stdout:'MESSAGING_ROOT_ARMED',stderr:'MESSAGING_UNCAUGHT'},
 {name:'real-foreground-cleanup-does-not-invoke-messaging-constructor',source:roots+`api.environment('armExit');`,code:0,stdout:'MESSAGING_ROOT_ARMED\nENVIRONMENT_CLEANUP_DONE'},
];
export function verifyMessagingResult(control:typeof messagingCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if('trap'in control){if(result.exitCode!==control.code||!result.stderr.includes(control.stderr!)||result.hostDiagnostics.length!==1)throw Error(JSON.stringify(result));return{status:'expected-native-contract-assertion'}}
 if(result.exitCode!==control.code||result.hostDiagnostics.length)throw Error(JSON.stringify(result));
 if('stderr'in control){if(!result.stderr.includes(control.stderr!))throw Error(result.stderr)}else if(result.stderr)throw Error(result.stderr);
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(result.stdout);return{status:'pass'}}
 const detail=JSON.parse(result.stdout);
 if(control.name==='original-principal-bootstrap-passes-real-messaging-setup'){
  if(detail.error?.name!=='Error'||detail.error?.code!=='ERR_KANDELO_NOT_IMPLEMENTED'||detail.error?.message!=="Native Node binding 'diagnostics_channel' is not implemented"||!detail.error.stack.includes('node:diagnostics_channel:36:')||!detail.error.stack.includes('node:internal/bootstrap/node:152:')||detail.realm.nodeBootstrapPhase!==3||detail.registered!==true||detail.startupAccepted!==false)throw Error(JSON.stringify(detail));return detail;
 }
 if(detail.cases!==27||detail.sharedCases!==12||detail.failures||detail.observations.some((r:any)=>r.status!=='pass')||detail.callbackCallStageOnly!==true||detail.structuredCloneImplemented!==false||detail.workerOrPortTransportImplemented!==false||detail.upstreamStartup!==false)throw Error(JSON.stringify(detail));
 const native=JSON.parse(readFileSync('tests/nodejs/upstream/messaging-native-reference.json','utf8')).detail;
 if(JSON.stringify(detail.observations.slice(0,12))!==JSON.stringify(native.observations))throw Error('messaging registration/JS hook observations differ from authenticated native reference');detail.exactNativeGroups=12;return detail;
}
