import {readFileSync} from 'node:fs';
export const mksnapshotFixture='tests/nodejs/upstream/mksnapshot-engine-controls.js',nativeContextFixture='tests/nodejs/upstream/native-context-engine-controls.js';
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),binding=realm.internalBinding('mksnapshot');`;
const roots=setup+`for(const name of ['setSerializeCallback','setDeserializeCallback','setDeserializeMainFunction'])binding[name](()=>{throw Error('CALLBACK_MUST_NOT_RUN')});print('SNAPSHOT_ROOTS_ARMED');`;
export const mksnapshotCases=[
 {name:'live-native-snapshot-interface',source:readFileSync(mksnapshotFixture,'utf8'),code:0},
 {name:'real-contexts-and-principal-callback-ownership',source:readFileSync(nativeContextFixture,'utf8'),code:0},
 ...['setSerializeCallback','setDeserializeCallback','setDeserializeMainFunction'].flatMap(name=>[
  {name:'nonfunction-'+name,source:setup+`binding.${name}(0)`,code:132,trap:true,stderr:'value->IsFunction()'},
  {name:'duplicate-check-precedes-type-check-'+name,source:setup+`binding.${name}(()=>{});binding.${name}(0)`,code:132,trap:true,stderr:'previous.isUndefined()'},
 ]),
 {name:'missing-real-embedder-hook-remains-fatal',source:setup+`binding.runEmbedderPreload({},()=>{})`,code:132,trap:true,stderr:'hook'},
 {name:'original-principal-bootstrap-preserves-next-gap',source:setup+`let error;try{api.runNodeBootstrap()}catch(caught){error={name:caught.name,message:caught.message,code:caught.code}}print(JSON.stringify({error,realm:api.inspectRealm(),startupAccepted:false}));`,code:0},
 {name:'natural-exit-with-rooted-callbacks',source:roots,code:0,stdout:'SNAPSHOT_ROOTS_ARMED'},
 {name:'explicit-quit-with-rooted-callbacks',source:roots+'quit(23)',code:23,stdout:'SNAPSHOT_ROOTS_ARMED'},
 {name:'uncaught-error-with-rooted-callbacks',source:roots+`throw Error('SNAPSHOT_UNCAUGHT')`,code:3,stdout:'SNAPSHOT_ROOTS_ARMED',stderr:'SNAPSHOT_UNCAUGHT'},
];
export function verifyMksnapshotResult(control:typeof mksnapshotCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if('trap'in control){if(result.exitCode!==control.code||!result.stderr.includes(control.stderr!)||result.hostDiagnostics.length!==1)throw Error(JSON.stringify(result));return {status:'expected-native-binding-assertion-trap'}}
 if(result.exitCode!==control.code||result.hostDiagnostics.length!==0)throw Error(JSON.stringify(result));
 if('stderr'in control){if(!result.stderr.includes(control.stderr!))throw Error(JSON.stringify(result))}else if(result.stderr!=='')throw Error(JSON.stringify(result));
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(JSON.stringify(result));return {status:'pass'}}
 const detail=JSON.parse(result.stdout);
 if(control.name==='original-principal-bootstrap-preserves-next-gap'){if(detail.error?.name!=='TypeError'||detail.error?.message!=='defineLazyProperties is not a function'||detail.error?.code!==undefined||detail.realm?.nodeBootstrapPhase!==3||!detail.realm.compiledBuiltinIds.includes('internal/v8/startup_snapshot')||detail.startupAccepted!==false)throw Error(JSON.stringify(detail));return detail}
 const expected=control.name==='live-native-snapshot-interface'?8:17;
 if(detail.failures||detail.cases!==expected||detail.observations.length!==expected||detail.observations.some((r:any)=>r.status!=='pass'))throw Error(JSON.stringify(detail));
 if(control.name==='live-native-snapshot-interface'){
  const native=JSON.parse(readFileSync('tests/nodejs/upstream/mksnapshot-live-native-reference.json','utf8')).detail;
  if(JSON.stringify(detail.observations)!==JSON.stringify(native.observations))throw Error('live binding observations differ from authenticated native reference');
  detail.exactNativeGroups=8;
 }else if(detail.upstreamStartup!==false)throw Error('context tests cannot claim startup');return detail;
}
