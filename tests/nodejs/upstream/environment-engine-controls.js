'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();
const env=(...args)=>api.environment(...args),collect=()=>gc('shrinking');
const observations=[];let failures=0;
function assert(value,message='native environment assertion failed'){if(!value)throw Error(message)}
function thrown(callback){try{callback()}catch(error){return error}throw Error('expected exception')}
function check(name,callback){try{observations.push({name,status:'pass',detail:callback()??true})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}})}}
check('environment-and-cleanup-owner-outlive-native-call-frames',()=>{
 const before=env('inspect');env('probe');env('probe');collect();
 const during=env('inspect');assert(during.cleanables===before.cleanables+2&&during.probeBytes===before.probeBytes+254);
 env('clean');const after=env('inspect');assert(after.cleanables===0&&after.probeBytes===0&&after.probesCleaned===before.probesCleaned+2);return true;
});
check('cleanup-drains-resources-registered-by-cleanup-callbacks',()=>{
 const before=env('inspect');env('reentrantProbe');env('clean');const after=env('inspect');
 assert(after.probesCreated===before.probesCreated+2&&after.probesCleaned===before.probesCleaned+2&&after.cleanables===0&&after.probeBytes===0);return true;
});
check('shared-environment-memory-accounter-balances-multiple-allocations',()=>{
 const before=api.inspectCodecs();for(let i=0;i<8;i++)env('probe');const during=api.inspectCodecs();
 assert(during.externalBytes===before.externalBytes+8*127);env('clean');const after=api.inspectCodecs();
 assert(after.externalBytes===before.externalBytes&&after.created===before.created+8&&after.released===before.released+8);return true;
});
check('weak-global-retains-live-buffer-identity-through-moving-gc',()=>{
 const buffer=new ArrayBuffer(64),view=new Uint8Array(buffer);view[3]=97;const handle=env('weak',buffer);collect();
 assert(env('read',handle)===buffer&&new Uint8Array(env('read',handle))[3]===97);env('release',handle);assert(env('read',handle)===undefined);return true;
});
check('weak-global-does-not-root-otherwise-unreachable-arraybuffer',()=>{
 function capture(){const buffer=new ArrayBuffer(64);new Uint8Array(buffer)[0]=23;return env('weak',buffer)}
 const handle=capture();collect();assert(env('read',handle)===undefined,'weak native handle retained its buffer');env('release',handle);return true;
});
check('weak-foreign-buffer-is-updated-and-wrapped-into-the-caller-realm',()=>{
 const global=newGlobal({newCompartment:true}),buffer=global.eval('new ArrayBuffer(17)'),handle=env('weak',buffer);
 collect();assert(env('read',handle)===buffer&&env('read',handle).byteLength===17);env('release',handle);return true;
});
check('reset-weak-handles-retire-native-registry-records-at-gc',()=>{
 const buffer=new ArrayBuffer(64);for(let i=0;i<16;i++){const handle=env('weak',buffer);env('release',handle)}
 collect();assert(env('inspect').weakRecords===0,'abandoned weak records survived collection');return true;
});
check('background-weak-handle-disposal-races-safely-with-moving-gc',()=>{
 const before=env('inspect'),buffer=new ArrayBuffer(64);
 for(let i=0;i<8;i++){const handle=env('weak',buffer);env('releaseFromThread',handle);assert(env('read',handle)===undefined)}
 collect();const after=env('inspect');assert(after.weakThreadReleases===before.weakThreadReleases+8&&after.weakRecords===0);return true;
});
check('foreground-work-is-queued-and-drained-by-the-real-libuv-loop',()=>{
 const before=env('inspect');env('post',7);const queued=env('inspect');assert(queued.pending===7&&queued.executed===before.executed);
 drainJobQueue();const after=env('inspect');assert(after.pending===0&&after.executed===before.executed+7&&after.ownerChecks===before.ownerChecks+7&&after.payloadBytes===before.payloadBytes+7*29);return true;
});
check('foreign-native-producers-post-move-only-payloads-without-js-roots',()=>{
 const before=env('inspect');env('postThreads',13);collect();assert(env('inspect').pending===52);
 drainJobQueue();const after=env('inspect');assert(after.pending===0&&after.executed===before.executed+52&&after.ownerChecks===before.ownerChecks+52&&after.payloadBytes===before.payloadBytes+52*29);return true;
});
check('native-dispatch-can-enqueue-further-native-work',()=>{
 const before=env('inspect');env('postReentrant');drainJobQueue();const after=env('inspect');
 assert(after.pending===0&&after.executed===before.executed+2&&after.ownerChecks===before.ownerChecks+1&&after.payloadBytes===before.payloadBytes+17);return true;
});
check('caught-native-work-error-preserves-pending-work-and-loop-liveness',()=>{
 const before=env('inspect');env('postFailure');env('post',2);
 const error=thrown(()=>drainJobQueue());assert(error.code==='ERR_NATIVE_ENVIRONMENT_PROBE'&&error.message==='NATIVE_ENVIRONMENT_WORK_ERROR');
 const failed=env('inspect');assert(failed.pending===2&&failed.executed===before.executed+1);
 drainJobQueue();const after=env('inspect');assert(after.pending===0&&after.executed===before.executed+3&&after.ownerChecks===before.ownerChecks+2);
 env('postFailure');assert(thrown(()=>drainJobQueue()).code==='ERR_NATIVE_ENVIRONMENT_PROBE');assert(env('inspect').pending===0);
 drainJobQueue();assert(env('inspect').executed===before.executed+4);return true;
});
check('foreign-native-bindings-preserve-the-canonical-environment',()=>{
 const global=newGlobal({newCompartment:true});api.initializeContext(global);const other=api.initializeRealm(global);assert(other.internalBinding('icu').getStringWidth('中')===2);const before=env('inspect');
 env('post',2);drainJobQueue();assert(env('inspect').ownerChecks===before.ownerChecks+2);return true;
});
check('invalid-native-controls-remain-visible-errors',()=>{
 for(const count of [0,-1,1025,undefined,NaN])thrown(()=>env('post',count));
 thrown(()=>env('weak',{}));thrown(()=>env('weak',new SharedArrayBuffer(8)));thrown(()=>env('read',-1));thrown(()=>env('release',0x7fffffff));return true;
});
print(JSON.stringify({kind:'native-environment-prerequisite-controls',cases:observations.length,failures,observations,state:env('inspect'),originalBufferExercisedByThesePrerequisiteControls:false,upstreamStartup:false}));if(failures)quit(1);
