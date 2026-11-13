import {readFileSync} from 'node:fs';
export const continuationFixture='tests/nodejs/upstream/continuation-engine-controls.js';
export const continuationSharedFixture='tests/nodejs/upstream/continuation-shared-controls.js';
export const continuationSource=readFileSync(continuationFixture,'utf8').replace('// @shared-continuation-controls',readFileSync(continuationSharedFixture,'utf8'));
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const binding=realm.internalBinding('async_context_frame'),queue=realm.internalBinding('task_queue'),get=binding.getContinuationPreservedEmbedderData,set=binding.setContinuationPreservedEmbedderData;`;
export const continuationCases=[
 {name:'raw-engine-and-original-native-scope-controls',source:continuationSource,code:0},
 {name:'real-disabled-option-gates-original-native-scope',code:0,stdout:'OPTION_SCOPE_GUARD',source:`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();api.configureOptions(['node','--no-async-context-frame'],'');const binding=realm.internalBinding('async_context_frame'),get=binding.getContinuationPreservedEmbedderData,set=binding.setContinuationPreservedEmbedderData;set('prior');if(api.withContinuationFrame('ignored',()=>{gc('shrinking');return get()})!=='prior'||get()!=='prior')throw Error('source option guard ignored');set('raw');const work=Promise.resolve().then(()=>get());set('root');work.then(value=>{if(value!=='raw'||get()!=='root')throw Error('raw engine intrinsics were disabled');print('OPTION_SCOPE_GUARD')});`},
 {name:'natural-exit-drains-captured-native-microtask',source:setup+`set('scheduled');queue.enqueueMicrotask(()=>{gc('shrinking');if(get()!=='scheduled')throw Error('lost captured context');print('CAPTURED_JOB_DONE')});set('outside');`,code:0,stdout:'CAPTURED_JOB_DONE'},
 {name:'native-checkpoint-restores-outside-context',source:setup+`set('scheduled');queue.enqueueMicrotask(()=>{if(get()!=='scheduled')throw Error('lost context');set('mutation')});set('outside');queue.runMicrotasks();if(get()!=='outside')throw Error('job context escaped checkpoint');print('CHECKPOINT_RESTORED');`,code:0,stdout:'CHECKPOINT_RESTORED'},
 {name:'queued-quit-retains-real-exit-status',source:setup+`set('scheduled');queue.enqueueMicrotask(()=>{if(get()!=='scheduled')throw Error('lost captured context');quit(23)});set('outside');`,code:23},
 {name:'handled-job-error-keeps-captured-context-and-restores-next-job',source:setup+`const marker=Error('CPED_ERROR_REFERENCE'),values=[];realm.process._fatalException=function(error,rejection){if(error!==marker||rejection!==false)throw Error('wrong fatal arguments');values.push(get());set('handler-mutation');return true};set('captured');queue.enqueueMicrotask(()=>{throw marker});set('outside');queue.enqueueMicrotask(()=>values.push(get()));queue.runMicrotasks();if(JSON.stringify(values)!=='["captured","outside"]'||get()!=='outside')throw Error('fatal callback or following job lost context');print('FATAL_CONTEXT_RESTORED');`,code:0,stdout:'FATAL_CONTEXT_RESTORED'},
 {name:'foreign-promise-and-await-wrap-captured-data-through-moving-gc',source:setup+`const global=newGlobal({newCompartment:true});api.initializeContext(global);const other=api.initializeRealm(global);global.binding=other.internalBinding('async_context_frame');const value={token:'cross-realm'};set(value);const work=global.eval('Promise.resolve().then(async()=>{await 0;gc("shrinking");return binding.getContinuationPreservedEmbedderData()})');set('outside');work.then(observed=>{if(observed!==value||get()!=='outside')throw Error('cross-realm job lost its data or caller context');print('FOREIGN_JOB_RESTORED')});`,code:0,stdout:'FOREIGN_JOB_RESTORED'},
 {name:'queued-uncaught-error-remains-real-failure',source:setup+`set('scheduled');queue.enqueueMicrotask(()=>{if(get()!=='scheduled')throw Error('lost captured context');throw Error('CONTINUATION_UNCAUGHT')});set('outside');`,code:3,stderr:'CONTINUATION_UNCAUGHT'},
];
function assert(value:unknown,message:string):asserts value {if(!value)throw Error(message)}
export function verifyContinuationResult(control:typeof continuationCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 assert(result.exitCode===control.code&&result.hostDiagnostics.length===0,JSON.stringify(result));
 if('stderr' in control)assert(result.stderr.includes(control.stderr!),JSON.stringify(result));
 else assert(result.stderr==='',JSON.stringify(result));
 if('stdout' in control)assert(result.stdout.trim()===control.stdout,JSON.stringify(result));
 if(control.name!=='raw-engine-and-original-native-scope-controls')return {status:'pass'};
 const detail=JSON.parse(result.stdout);
 assert(detail.cases===27&&detail.sharedCases===20&&detail.failures===0&&detail.observations.every((row:any)=>row.status==='pass'),JSON.stringify(detail));
 const native=JSON.parse(readFileSync('tests/nodejs/upstream/continuation-native-reference.json','utf8')).detail;
 assert(JSON.stringify(detail.observations.slice(0,20))===JSON.stringify(native.observations.slice(0,20)),'raw shared observations differ from authenticated native Node');
 assert(detail.deferredOriginalConsumerCases===4,'missing honest original consumer deferral');
 return detail;
}
