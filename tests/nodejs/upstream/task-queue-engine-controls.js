'use strict';
// Raw native binding/checkpoint controls; unchanged public queue modules and
// full async callback/fatal/exit policy remain separate unfinished contracts.
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();
const queue=realm.internalBinding('task_queue'),info=queue.tickInfo;
const enqueue=queue.enqueueMicrotask,run=queue.runMicrotasks,setTick=queue.setTickCallback,setReject=queue.setPromiseRejectCallback;
const observations=[];let failures=0,bootstrapFailure;
function thrown(callback){try{callback()}catch(error){return error}throw new Error('expected failure')}
function reset(){info.fill(0);setTick(()=>info.fill(0));setReject(()=>{});delete realm.process._fatalException;run()}
function check(name,callback){try{reset();callback();observations.push({name,status:'pass'})}catch(error){let stack;try{stack=error.stack}catch{}failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack}})}}
check('binding-layout-cache-and-native-method-lengths',()=>{
  assertEq(realm.internalBinding('task_queue'),queue);assertEq(info instanceof Uint8Array,true);assertEq(info.length,2);assertEq(info.join(','),'0,0');
  for(const name of ['enqueueMicrotask','runMicrotasks','setTickCallback','setPromiseRejectCallback']){assertEq(typeof queue[name],'function');assertEq(queue[name].name,name);assertEq(queue[name].length,0)}
  assertEq(queue.promiseRejectEvents.kPromiseRejectWithNoHandler,0);assertEq(queue.promiseRejectEvents.kPromiseHandlerAddedAfterReject,1);
  for(const name of Object.keys(queue.promiseRejectEvents)){const entry=Object.getOwnPropertyDescriptor(queue.promiseRejectEvents,name);assertEq(entry.writable,false);assertEq(entry.configurable,false)}
});
check('native-exit-code-enum-is-complete-and-readonly',()=>{
  const errors=realm.internalBinding('errors'),codes=errors.exitCodes;
  assertEq(Object.keys(codes).length,14);assertEq(codes.kGenericUserError,1);
  const descriptor=Object.getOwnPropertyDescriptor(errors,'exitCodes');assertEq(descriptor.writable,false);assertEq(descriptor.configurable,true);
  for(const name of Object.keys(codes)){const entry=Object.getOwnPropertyDescriptor(codes,name);assertEq(typeof entry.value,'number');assertEq(entry.writable,false);assertEq(entry.configurable,false)}
});
check('enqueue-is-deferred-and-shares-promise-fifo',()=>{
  const order=[];enqueue(()=>{order.push('queued');enqueue(()=>order.push('nested'))});Promise.resolve().then(()=>order.push('promise'));
  assertEq(order.length,0);assertEq(run(),undefined);assertEq(order.join(','),'queued,promise,nested');
});
check('callable-receiver-arguments-and-method-owner',()=>{
  let calls=0;enqueue.call(null,function(){assertEq(this,undefined);assertEq(arguments.length,0);calls++});run.call({});assertEq(calls,1);
});
check('bound-and-proxy-callables-use-real-engine-jobs',()=>{
  const order=[];enqueue(function(value){order.push(this.name+value)}.bind({name:'bound'},1));
  enqueue(new Proxy(()=>order.push('proxy'),{apply(target,self,args){assertEq(self,undefined);assertEq(args.length,0);return Reflect.apply(target,self,args)}}));
  run();assertEq(order.join(','),'bound1,proxy');
});
check('native-and-shell-nested-checkpoints-do-not-reenter',()=>{
  const order=[];enqueue(()=>{order.push('start');enqueue(()=>order.push('nested'));run();drainJobQueue();order.push('end')});run();assertEq(order.join(','),'start,end,nested');
});
check('nested-checkpoint-keeps-current-job-weakref-target',()=>{
  let result;enqueue(()=>{const weak=(()=>new WeakRef({}))();gc('shrinking');assertEq(weak.deref()!==undefined,true);run();drainJobQueue();gc('shrinking');result=weak.deref()!==undefined});run();assertEq(result,true);
});
check('queued-native-adapter-retains-callback-through-moving-gc',()=>{
  let calls=0;let callback=()=>{calls++;gc('shrinking')};enqueue(callback);callback=null;gc('shrinking');run();assertEq(calls,1);
});
check('microtask-only-entry-does-not-dispatch-live-ticks',()=>{
  const order=[];setTick(function(){assertEq(this,realm.process);assertEq(arguments.length,0);order.push('tick');info.fill(0)});info[0]=1;
  enqueue(()=>order.push('microtask'));run();assertEq(order.join(','),'microtask');drainJobQueue();assertEq(order.join(','),'microtask,tick');
});
check('outer-checkpoint-runs-scheduled-tick-before-microtasks',()=>{
  const order=[];setTick(()=>{order.push('tick');info.fill(0);run()});info[0]=1;enqueue(()=>order.push('microtask'));drainJobQueue();assertEq(order.join(','),'tick,microtask');
});
check('microtask-can-schedule-tick-in-the-same-outer-checkpoint',()=>{
  const order=[];setTick(()=>{order.push('tick');info.fill(0)});enqueue(()=>{order.push('microtask');info[0]=1});drainJobQueue();assertEq(order.join(','),'microtask,tick');
});
check('rejection-flag-triggers-original-registered-tick-callback',()=>{
  let calls=0;setTick(()=>{calls++;info.fill(0)});info[1]=1;drainJobQueue();assertEq(calls,1);
});
check('native-live-flags-match-exact-one-semantics',()=>{
  let calls=0;setTick(()=>{calls++;info.fill(0)});info[0]=2;info[1]=255;drainJobQueue();assertEq(calls,0);info.fill(0);
});
check('public-binding-fields-do-not-replace-protected-state',()=>{
  let calls=0;setTick(()=>{calls++;info.fill(0)});const original=queue.tickInfo;queue.tickInfo=new Uint8Array(2);info[0]=1;drainJobQueue();assertEq(calls,1);assertEq(queue.tickInfo[0],0);queue.tickInfo=original;
});
check('nested-tick-checkpoint-keeps-outer-owner-entered',()=>{
  const order=[];setTick(()=>{order.push('start');drainJobQueue();order.push('end');info.fill(0)});info[0]=1;drainJobQueue();assertEq(order.join(','),'start,end');
});
check('real-promise-rejection-events-and-original-reason',()=>{
  const events=[];setReject(function(type,promise,value){assertEq(this,undefined);assertEq(arguments.length,3);events.push({type,promise,value})});
  const reason={},promise=Promise.reject(reason);assertEq(events.length,1);assertEq(events[0].type,0);assertEq(events[0].promise,promise);assertEq(events[0].value,reason);
  promise.catch(()=>{});assertEq(events.length,2);assertEq(events[1].type,1);assertEq(events[1].promise,promise);assertEq(events[1].value,undefined);run();
});
check('promise-callback-replacement-retains-the-actual-latest-function',()=>{
  let first=0,second=0;setReject(()=>first++);setReject(()=>second++);gc('shrinking');const promise=Promise.reject({});promise.catch(()=>{});run();assertEq(first,0);assertEq(second,2);
});
check('cross-realm-binding-shares-flags-and-principal-process',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),binding=other.internalBinding('task_queue');
  assertEq(binding.tickInfo,info);let receiver;binding.setTickCallback(function(){receiver=this;info.fill(0)});info[0]=1;drainJobQueue();assertEq(receiver,realm.process);assertEq(receiver===other.process,false);
  target.record=[];const callback=target.eval('(function(){"use strict";record.push(this===undefined)})');binding.enqueueMicrotask(callback);run();assertEq(target.record.join(','),'true');
});
check('cross-realm-promise-and-reason-identity-survive-notification',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);api.initializeRealm(target);const events=[];setReject((type,promise,value)=>events.push({type,promise,value}));
  const reason=target.eval('({foreign:true})');target.reason=reason;const promise=target.eval('Promise.reject(reason)');assertEq(events[0].promise,promise);assertEq(events[0].value,reason);promise.catch(()=>{});run();assertEq(events[1].promise,promise);assertEq(events[1].value,undefined);
});
check('handled-job-error-enters-real-principal-process-policy',()=>{
  const marker={},order=[];realm.process._fatalException=function(error,fromPromise){assertEq(this,realm.process);assertEq(error,marker);assertEq(fromPromise,false);order.push('handled');return true};
  let caught=false;enqueue(()=>{order.push('throw');throw marker});enqueue(()=>order.push('after'));try{run()}catch{caught=true}assertEq(caught,false);assertEq(order.join(','),'throw,handled,after');
});
check('native-fatal-policy-accepts-every-result-except-exact-false',()=>{
  let calls=0;for(const value of [undefined,null,0,'',true]){realm.process._fatalException=()=>{calls++;return value};enqueue(()=>{throw {}});run()}assertEq(calls,5);
});
check('throwing-error-policy-preserves-actual-replacement-error',()=>{
  const original={},replacement={};realm.process._fatalException=()=>{throw replacement};enqueue(()=>{throw original});assertEq(thrown(()=>run()),replacement);
});
check('missing-fatal-policy-preserves-failure-and-pending-jobs',()=>{
  const marker={};let after=false;enqueue(()=>{throw marker});enqueue(()=>after=true);assertEq(thrown(()=>run()),marker);assertEq(after,false);run();assertEq(after,true);
});
check('false-fatal-policy-remains-an-explicit-exit-backend-gap',()=>{
  const marker={};realm.process._fatalException=()=>false;enqueue(()=>{throw marker});assertEq(thrown(()=>run()),marker);
});
check('libuv-callback-checkpoint-drains-real-jobs-and-live-ticks',()=>{
  const timers=realm.internalBinding('timers'),immediate=timers.immediateInfo,order=[];
  setTick(()=>{order.push('tick');info.fill(0)});
  timers.setupTimers(()=>{order.push('immediate');immediate.fill(0)},()=>{order.push('timer');enqueue(()=>{order.push('microtask');info[0]=1});immediate[0]=1;immediate[1]=1;timers.toggleImmediateRef(true);return 0});
  timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);drainJobQueue();assertEq(order.join(','),'timer,microtask,tick,immediate');
});
check('failed-realm-methods-retire-without-mutating-shared-state',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),binding=other.internalBinding('task_queue');
  const error=thrown(()=>api.runNodeBootstrap(target));assertEq(error.name,'Error');assertEq(error.code,'ERR_KANDELO_NOT_IMPLEMENTED');assertEq(error.message,"Native Node binding 'buffer' is not implemented");bootstrapFailure={name:error.name,code:error.code,message:error.message};
  let called=false;assertEq(thrown(()=>binding.enqueueMicrotask(()=>called=true)).message.includes('Previous Node realm initialization failed'),true);run();assertEq(called,false);
});
reset();
print(JSON.stringify({kind:'native-task-queue-controls',cases:observations.length,failures,observations,bootstrapFailure,exitCodes:realm.internalBinding('errors').exitCodes,
  limits:['Raw binding/checkpoint controls, not original public task queue modules or successful Node startup',
    'Complete AsyncWrap/resource/frame/native callback scopes and fatal exit/at-exit remain incomplete',
    'Active module-evaluation checkpoints remain explicit failures; assigned Promise rejection contexts use actual native state',
    'Per-host artifact identities and fatal/diagnostic controls belong to the external runner']}));
