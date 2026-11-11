'use strict';
// Native binding/scheduler controls, not public timers or successful Node startup.
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();
const timers=realm.internalBinding('timers'),info=timers.immediateInfo,timeout=timers.timeoutInfo;
const observations=[];let failures=0;
function thrown(fn){try{fn()}catch(error){return error}throw new Error('expected failure')}
function callbacks(timer,immediate=()=>{info.fill(0)}){timers.setupTimers(immediate,timer)}
function fire(delay,callback){callbacks(callback);timers.getLibuvNow();timers.scheduleTimer(delay);timers.toggleTimerRef(true);drainJobQueue()}
function reset(){info.fill(0);timers.toggleImmediateRef(false);callbacks(()=>0);timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);drainJobQueue()}
function check(name,callback){try{callback();observations.push({name,status:'pass'})}catch(error){let stack;try{stack=error.stack}catch{}failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack}})}finally{try{reset()}catch(error){failures++;observations.push({name:name+'/cleanup',status:'fail',error:{name:error.name,message:error.message}})}}}
check('native-binding-and-live-info-layout',()=>{
  assertEq(realm.internalBinding('timers'),timers);assertEq(info instanceof Uint32Array,true);assertEq(info.length,3);
  assertEq(timeout instanceof Int32Array,true);assertEq(timeout.length,1);assertEq(info.join(','),'0,0,0');assertEq(timeout[0],0);
  for(const name of ['setupTimers','getLibuvNow','scheduleTimer','toggleTimerRef','toggleImmediateRef']){assertEq(typeof timers[name],'function');assertEq(timers[name].name,name);assertEq(timers[name].length,0)}
});
check('guest-monotonic-environment-clock-is-shared',()=>{
  const first=timers.getLibuvNow(),second=timers.getLibuvNow(),snapshot=api.inspectTimers();
  assertEq(Number.isSafeInteger(first)&&first>=0,true);assertEq(second>=first,true);assertEq(snapshot.now-snapshot.base,second);
});
check('reference-toggles-use-true-without-coercing',()=>{
  for(const value of [1,'true',{},new Boolean(true),false,undefined]){
    timers.toggleTimerRef(value);timers.toggleImmediateRef(value);const state=api.inspectTimers();
    assertEq(state.timerReferenced,false);assertEq(state.immediateReferenced,false);
  }
  timers.toggleTimerRef(true);timers.toggleImmediateRef(true);assertEq(api.inspectTimers().timerReferenced,true);assertEq(api.inspectTimers().immediateReferenced,true);
  timers.toggleImmediateRef(false);
});
check('schedule-converts-once-and-keeps-exact-uint64-deadline',()=>{
  let converted=0;timers.getLibuvNow();timers.scheduleTimer({valueOf(){converted++;return '4.9'}});
  let state=api.inspectTimers();assertEq(converted,1);assertEq(state.deadline-BigInt(state.now),4n);assertEq(state.armed,true);
  timers.scheduleTimer(-1);state=api.inspectTimers();assertEq(state.deadline,18446744073709551615n);
  timers.scheduleTimer(Infinity);state=api.inspectTimers();assertEq(state.deadline,BigInt(state.now)+9223372036854775807n);
  timers.scheduleTimer(NaN);state=api.inspectTimers();assertEq(state.deadline,BigInt(state.now));
});
check('schedule-conversion-errors-preserve-original-state-and-exception',()=>{
  timers.getLibuvNow();timers.scheduleTimer(50);const before=api.inspectTimers().deadline,marker={original:true};
  assertEq(thrown(()=>timers.scheduleTimer({valueOf(){throw marker}})),marker);assertEq(api.inspectTimers().deadline,before);
  assertEq(thrown(()=>timers.scheduleTimer(Symbol('duration'))) instanceof TypeError,true);
  assertEq(thrown(()=>timers.scheduleTimer(1n)) instanceof TypeError,true);
});
check('actual-referenced-deadline-blocks-and-invokes-native-callback',()=>{
  let calls=0;const start=timers.getLibuvNow();
  fire(12,function(now){calls++;assertEq(this===realm.process,true);assertEq(arguments.length,1);assertEq(typeof now,'number');assertEq(now-start>=12,true);return 0});
  assertEq(calls,1);assertEq(api.inspectTimers().armed,false);assertEq(api.inspectTimers().timerReferenced,false);
});
check('rescheduling-replaces-the-existing-native-deadline',()=>{
  let calls=0;callbacks(()=>{calls++;return 0});timers.getLibuvNow();timers.scheduleTimer(120000);timers.scheduleTimer(0);timers.toggleTimerRef(true);drainJobQueue();assertEq(calls,1);
});
check('positive-expiry-return-rearms-a-referenced-one-shot',()=>{
  let calls=0,first;
  fire(0,now=>{calls++;if(calls===1){first=now;return now+4}assertEq(now-first>=4,true);return 0});
  assertEq(calls,2);assertEq(api.inspectTimers().armed,false);
});
check('negative-expiry-return-leaves-a-real-unreferenced-pending-timer',()=>{
  let calls=0;fire(0,now=>{calls++;return -(now+100)});const state=api.inspectTimers();
  assertEq(calls,1);assertEq(state.armed,true);assertEq(state.timerReferenced,false);
});
check('zero-expiry-does-not-discard-reentrant-rescheduling',()=>{
  let calls=0;fire(0,()=>{calls++;if(calls===1)timers.scheduleTimer(120000);return 0});
  assertEq(calls,1);assertEq(api.inspectTimers().armed,true);assertEq(api.inspectTimers().timerReferenced,false);
  timers.scheduleTimer(0);timers.toggleTimerRef(true);drainJobQueue();assertEq(calls,2);assertEq(api.inspectTimers().armed,false);
});
check('unreferenced-even-due-timer-does-not-keep-the-loop-alive',()=>{
  let calls=0;callbacks(()=>{calls++;return 0});timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(false);drainJobQueue();
  assertEq(calls,0);assertEq(api.inspectTimers().armed,true);
});
check('referenced-immediate-uses-live-counters-and-principal-process',()=>{
  let calls=0;callbacks(()=>0,function(){calls++;assertEq(this===realm.process,true);assertEq(arguments.length,0);info.fill(0)});
  info[0]=1;info[1]=1;timers.toggleImmediateRef(true);drainJobQueue();assertEq(calls,1);assertEq(api.inspectTimers().immediateReferenced,false);
});
check('unreferenced-immediate-does-not-keep-the-loop-alive',()=>{
  let calls=0;callbacks(()=>0,()=>{calls++;info.fill(0)});info[0]=1;timers.toggleImmediateRef(false);drainJobQueue();assertEq(calls,0);
});
check('unreferenced-immediate-runs-while-a-real-timer-keeps-the-loop-alive',()=>{
  let timersCalled=0,immediatesCalled=0;
  callbacks(now=>++timersCalled===1?now+8:0,()=>{immediatesCalled++;info.fill(0)});
  info[0]=1;timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);drainJobQueue();assertEq(timersCalled,2);assertEq(immediatesCalled,1);
});
check('real-engine-microtasks-run-between-timer-and-immediate-phases',()=>{
  const order=[];callbacks(()=>{order.push('timer');info[0]=1;info[1]=1;timers.toggleImmediateRef(true);Promise.resolve().then(()=>order.push('microtask'));return 0},()=>{order.push('immediate');info.fill(0)});
  timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);drainJobQueue();assertEq(order.join(','),'timer,microtask,immediate');
});
check('native-method-ownership-does-not-depend-on-a-javascript-receiver',()=>{
  assertEq(typeof timers.getLibuvNow.call(null),'number');let calls=0;callbacks(()=>{calls++;return 0});timers.scheduleTimer.call({},0);timers.toggleTimerRef.call(null,true);drainJobQueue();assertEq(calls,1);
});
check('callback-replacement-and-gc-retain-the-real-latest-function',()=>{
  let first=0,second=0;callbacks(()=>{first++;return 0});callbacks(()=>{second++;return 0});gc();timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);drainJobQueue();assertEq(first,0);assertEq(second,1);
});
check('other-realm-binding-shares-environment-state-and-principal-receiver',()=>{
  const target=newGlobal({newCompartment:true});api.initializeContext(target);const other=api.initializeRealm(target),binding=other.internalBinding('timers');
  assertEq(binding===timers,false);assertEq(binding.immediateInfo,info);assertEq(binding.timeoutInfo,timeout);
  target.principalProcess=realm.process;target.calls=0;target.correctReceiver=false;
  const timer=target.eval('(function(){calls++;correctReceiver=this===principalProcess;return 0})');
  binding.setupTimers(()=>{info.fill(0)},timer);gc();binding.getLibuvNow();binding.scheduleTimer(0);binding.toggleTimerRef(true);drainJobQueue();assertEq(target.calls,1);assertEq(target.correctReceiver,true);
});
check('original-callback-exception-is-not-cleared-or-replaced',()=>{
  const marker={original:'timer callback'};callbacks(()=>{throw marker});timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);
  assertEq(thrown(()=>drainJobQueue())===marker,true);assertEq(api.inspectTimers().armed,false);
});
check('reentrant-loop-dispatch-is-rejected-without-losing-outer-state',()=>{
  let caught=false;fire(0,()=>{caught=thrown(()=>drainJobQueue()).message.includes('Reentrant native timer dispatch');return 0});assertEq(caught,true);assertEq(api.inspectTimers().armed,false);
});
check('diagnostic-snapshots-and-public-binding-properties-do-not-own-native-state',()=>{
  let calls=0;const property=timers.immediateInfo;timers.immediateInfo={fake:true};
  try{callbacks(()=>0,()=>{calls++;info.fill(0)});info[0]=1;info[1]=1;timers.toggleImmediateRef(true);const copy=api.inspectTimers();copy.immediateReferenced=false;copy.deadline=0n;drainJobQueue();assertEq(calls,1)}finally{timers.immediateInfo=property}
});
check('owned-loop-does-not-call-public-compatibility-timer-hooks',()=>{
  const run=Object.getOwnPropertyDescriptor(globalThis,'__kandeloRunDueTimers'),delay=Object.getOwnPropertyDescriptor(globalThis,'__kandeloNextTimerDelay');let reads=0;
  Object.defineProperty(globalThis,'__kandeloRunDueTimers',{get(){reads++;throw new Error('legacy timer hook read')},configurable:true});
  Object.defineProperty(globalThis,'__kandeloNextTimerDelay',{get(){reads++;throw new Error('legacy delay hook read')},configurable:true});
  try{let called=0;fire(0,()=>{called++;return 0});assertEq(called,1);assertEq(reads,0)}finally{
    if(run)Object.defineProperty(globalThis,'__kandeloRunDueTimers',run);else delete globalThis.__kandeloRunDueTimers;
    if(delay)Object.defineProperty(globalThis,'__kandeloNextTimerDelay',delay);else delete globalThis.__kandeloNextTimerDelay;
  }
});
check('fresh-loop-does-not-retain-a-previous-check-phase',()=>{
  const order=[];callbacks(()=>{order.push('timer');Promise.resolve().then(()=>order.push('microtask'));return 0},()=>{order.push('immediate');info.fill(0)});
  info[0]=1;info[1]=1;timers.toggleImmediateRef(true);timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);drainJobQueue();assertEq(order.join(','),'timer,microtask,immediate');
});
check('fresh-default-loop-services-reentrant-zero-deadline-before-exit',()=>{
  let calls=0;fire(0,()=>{if(++calls===1)timers.scheduleTimer(0);return 0});
  assertEq(calls,2);assertEq(api.inspectTimers().armed,false);assertEq(api.inspectTimers().timerReferenced,false);
});
check('actual-libuv-version-and-public-layout-match',()=>{
  const state=api.inspectTimers();assertEq(state.libuvVersion,0x013401);
  assertEq(Number.isSafeInteger(state.loopSize)&&state.loopSize>0,true);assertEq(state.loopSize,state.nativeLoopSize);
});
check('outstanding-immediates-drain-with-engine-checkpoints',()=>{
  const order=[];let calls=0;
  callbacks(()=>0,()=>{const index=++calls;order.push('immediate'+index);Promise.resolve().then(()=>order.push('microtask'+index));if(index===3)info.fill(0);else info[2]=1});
  info[0]=1;info[1]=1;timers.toggleImmediateRef(true);drainJobQueue();
  assertEq(calls,3);assertEq(order.join(','),'immediate1,microtask1,immediate2,microtask2,immediate3,microtask3');
  assertEq(api.inspectTimers().immediateReferenced,false);
});
check('moving-gc-during-callback-checkpoint-preserves-libuv-owner',()=>{
  const order=[];
  callbacks(()=>{order.push('timer');info[0]=1;info[1]=1;timers.toggleImmediateRef(true);Promise.resolve().then(()=>{gc('shrinking');order.push('gc-job')});return 0},()=>{gc('shrinking');order.push('immediate');info.fill(0)});
  timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);drainJobQueue();
  assertEq(order.join(','),'timer,gc-job,immediate');assertEq(api.inspectTimers().armed,false);
});
const state=api.inspectTimers();
print(JSON.stringify({kind:'native-timers-controls',plannedCases:27,cases:observations.length,notRun:27-observations.length,failures,observations,
  state:{armed:state.armed,timerReferenced:state.timerReferenced,immediateReferenced:state.immediateReferenced,deadline:state.deadline.toString()},
  limits:['Native binding/scheduler controls, not public timers or successful Node bootstrap','No task_queue/async callback-scope/tick/fatal recovery integration','Real libuv phase machinery; full Node callback-scope/native differential/security/OOM/finalization proof incomplete','Per-host execution is recorded by the external runner']}));
if(failures)quit(1);
