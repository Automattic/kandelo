'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();
const binding=realm.internalBinding('async_context_frame'),load=realm.require,collect=()=>gc('shrinking');
const queue=realm.internalBinding('task_queue'),enqueue=queue.enqueueMicrotask;queue.setPromiseRejectCallback(()=>{});
// @shared-continuation-controls
let done=false,bootstrapFailure;
runRawContinuationControls().then(()=>{
 const sharedCases=observations.length;
 return check('original-native-scope-restores-data-after-return-and-throw',()=>{
   set('prior');const marker=Error('NATIVE_SCOPE_MARKER');
   assert(api.withContinuationFrame('next',()=>{collect();assert(get()==='next');return 19})===19&&get()==='prior');
   assert(thrown(()=>api.withContinuationFrame('throw',()=>{collect();throw marker}))===marker&&get()==='prior');
   return true;
 }).then(()=>check('nested-original-native-scopes-retain-independent-rooted-values',()=>{
   const prior={value:1},next={value:2},inner={value:3};set(prior);
   api.withContinuationFrame(next,()=>{collect();assert(get()===next);api.withContinuationFrame(inner,()=>{collect();assert(get()===inner)});assert(get()===next)});
   collect();assert(get()===prior);return true;
 })).then(()=>check('other-realms-share-engine-data-and-have-distinct-binding-functions',()=>{
   const global=newGlobal({newCompartment:true});api.initializeContext(global);const other=api.initializeRealm(global),foreign=other.internalBinding('async_context_frame');
   assert(foreign!==binding&&foreign.getContinuationPreservedEmbedderData!==get);
   const value=global.eval('({foreign:true})');foreign.setContinuationPreservedEmbedderData(value);collect();assert(get()===value);
   const local={local:true};set(local);assert(foreign.getContinuationPreservedEmbedderData()===local);return true;
 })).then(()=>check('queued-reaction-keeps-its-only-frame-value-through-moving-gc',async()=>{
   let resolve,value={token:'queued-owner'};const promise=new Promise(done=>resolve=done);
   const work=scoped(value,()=>promise.then(()=>get()));value=null;collect();resolve();collect();
   assert((await work).token==='queued-owner');return true;
 })).then(()=>check('original-native-scope-captures-real-asynchronous-continuation',async()=>{
   set('outside');const work=api.withContinuationFrame('native-async',()=>Promise.resolve().then(()=>{collect();return get()}));
   assert(get()==='outside');assert(await work==='native-async'&&get()==='outside');return true;
 })).then(()=>check('original-active-consumers-preserve-the-pre-bootstrap-options-guard',()=>{
   assert(thrown(()=>load('internal/async_context_frame').enabled).code==='ERR_OPTIONS_BEFORE_BOOTSTRAPPING');
   assert(thrown(()=>load('async_hooks').AsyncLocalStorage).code==='ERR_OPTIONS_BEFORE_BOOTSTRAPPING');return true;
 })).then(()=>check('original-bootstrap-preserves-next-real-gap-and-retires-binding',()=>{
   const global=newGlobal({newCompartment:true});api.initializeContext(global);const other=api.initializeRealm(global),foreign=other.internalBinding('async_context_frame');
   const error=thrown(()=>api.runNodeBootstrap(global));bootstrapFailure={name:error.name,code:error.code,message:error.message,stack:error.stack,compiledBuiltinIds:api.inspectRealm(global).compiledBuiltinIds};
   assert(thrown(()=>foreign.getContinuationPreservedEmbedderData()).message.includes('Previous Node realm initialization failed'));
   assert(thrown(()=>foreign.setContinuationPreservedEmbedderData({})).message.includes('Previous Node realm initialization failed'));return true;
 })).then(()=>{
   done=true;print(JSON.stringify({kind:'native-continuation-controls',cases:observations.length,sharedCases,failures,observations,bootstrapFailure,deferredOriginalConsumerCases:4,deferredReason:'Active original JS consumers require genuine completed bootstrap; their four ERR_OPTIONS_BEFORE_BOOTSTRAPPING failures are retained in engine-first.json',upstreamStartup:false}));if(failures)quit(1);
 });
},error=>{throw error});
drainJobQueue();if(!done)throw Error('Continuation controls did not finish through the actual engine queue');
