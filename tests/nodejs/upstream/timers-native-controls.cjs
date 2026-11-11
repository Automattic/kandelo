'use strict';
const assert=require('assert/strict'),{writeSync}=require('fs');
const {internalBinding}=require('internal/test/binding');
const timers=internalBinding('timers'),info=timers.immediateInfo,timeout=timers.timeoutInfo;
const mode=process.argv[2];
if(mode==='initial-phases'){
  const order=[];timers.setupTimers(()=>{order.push('immediate');info.fill(0);writeSync(1,JSON.stringify({kind:'native-timer-initial-phase-control',mode,order})+'\n')},()=>{order.push('timer');info[0]=1;info[1]=1;timers.toggleImmediateRef(true);Promise.resolve().then(()=>order.push('microtask'));return 0});
  info[0]=1;info[1]=1;timers.toggleImmediateRef(true);timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);
}else if(mode==='unref-timer'||mode==='unref-immediate'){
  timers.setupTimers(()=>{writeSync(1,'UNEXPECTED_IMMEDIATE_CALLBACK\n');info.fill(0)},()=>{writeSync(1,'UNEXPECTED_TIMER_CALLBACK\n');return 0});
  if(mode==='unref-timer'){timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(false)}
  else{info[0]=1;timers.toggleImmediateRef(false)}
  writeSync(1,JSON.stringify({kind:'native-timer-unref-exit-control',mode})+'\n');
}else{
  const observations=[];let failures=0;
  function setup(timer,immediate=()=>info.fill(0)){timers.setupTimers(immediate,timer)}
  function scheduled(delay,callback){return new Promise((resolve,reject)=>{
    setup(function(now){try{return callback.call(this,now,resolve)}catch(error){reject(error);return 0}});
    timers.getLibuvNow();timers.scheduleTimer(delay);timers.toggleTimerRef(true);
  })}
  async function reset(){info.fill(0);timers.toggleImmediateRef(false);await scheduled(0,(_now,resolve)=>{resolve();return 0})}
  async function check(name,fn){try{await fn();observations.push({name,status:'pass'})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}})}finally{await reset()}}
  async function main(){
    await check('native-binding-and-real-info-layout',()=>{assert.equal(internalBinding('timers'),timers);assert.ok(info instanceof Uint32Array);assert.equal(info.length,3);assert.ok(timeout instanceof Int32Array);assert.equal(timeout.length,1);for(const name of ['setupTimers','getLibuvNow','scheduleTimer','toggleTimerRef','toggleImmediateRef']){assert.equal(timers[name].name,name);assert.equal(timers[name].length,0)}});
    await check('native-clock-and-true-only-reference-toggles',()=>{const a=timers.getLibuvNow(),b=timers.getLibuvNow();assert.ok(Number.isSafeInteger(a)&&a>=0&&b>=a);for(const value of [1,'true',{},new Boolean(true),false,undefined]){timers.toggleTimerRef(value);timers.toggleImmediateRef(value)}});
    await check('native-duration-conversion-and-original-exceptions',async()=>{let count=0;const marker={original:'duration'};assert.throws(()=>timers.scheduleTimer({valueOf(){throw marker}}),error=>error===marker);assert.throws(()=>timers.scheduleTimer(Symbol()),TypeError);assert.throws(()=>timers.scheduleTimer(1n),TypeError);await scheduled({valueOf(){count++;return '1.9'}},(_now,resolve)=>{resolve();return 0});assert.equal(count,1)});
    await check('native-referenced-deadline-and-process-receiver',async()=>{const start=timers.getLibuvNow();await scheduled(12,function(now,resolve){assert.equal(this,process);assert.ok(now-start>=12);resolve();return 0})});
    await check('native-schedule-replaces-previous-deadline',async()=>{let count=0;await new Promise(resolve=>{setup(()=>{count++;resolve();return 0});timers.getLibuvNow();timers.scheduleTimer(120000);timers.scheduleTimer(0);timers.toggleTimerRef(true)});assert.equal(count,1)});
    await check('native-positive-expiry-rearms-one-shot',async()=>{let count=0,first;await scheduled(0,(now,resolve)=>{if(++count===1){first=now;return now+4}assert.ok(now-first>=4);resolve();return 0});assert.equal(count,2)});
    await check('native-negative-expiry-leaves-unreferenced-timer',async()=>{let count=0;await scheduled(0,(now,resolve)=>{count++;resolve();return -(now+100)});assert.equal(count,1)});
    await check('native-zero-expiry-preserves-reentrant-schedule',async()=>{let count=0;await new Promise(resolve=>{setup(()=>{if(++count===1){timers.scheduleTimer(0);Promise.resolve().then(()=>timers.toggleTimerRef(true));return 0}resolve();return 0});timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true)});assert.equal(count,2)});
    await check('native-immediate-counters-and-process-receiver',async()=>{let count=0;await new Promise(resolve=>{setup(()=>0,function(){count++;assert.equal(this,process);assert.equal(arguments.length,0);info.fill(0);resolve()});info[0]=1;info[1]=1;timers.toggleImmediateRef(true)});assert.equal(count,1)});
    await check('native-microtask-checkpoint-between-timer-and-immediate',async()=>{const order=[];await new Promise(resolve=>{setup(()=>{order.push('timer');info[0]=1;info[1]=1;timers.toggleImmediateRef(true);Promise.resolve().then(()=>order.push('microtask'));return 0},()=>{order.push('immediate');info.fill(0);resolve()});timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true)});assert.deepEqual(order,['timer','microtask','immediate'])});
    await check('native-method-owner-is-independent-of-this-value',async()=>{assert.equal(typeof timers.getLibuvNow.call(null),'number');await new Promise(resolve=>{setup(()=>{resolve();return 0});timers.scheduleTimer.call({},0);timers.toggleTimerRef.call(null,true)})});
    await check('native-callback-replacement-and-gc-retention',async()=>{let first=0,second=0;await new Promise(resolve=>{setup(()=>{first++;return 0});setup(()=>{second++;resolve();return 0});gc();timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true)});assert.equal(first,0);assert.equal(second,1)});
    await check('native-foreign-function-keeps-principal-process-receiver',async()=>{const vm=require('vm'),context=vm.createContext({principal:process,complete:null,called:false,correct:false});await new Promise(resolve=>{context.complete=resolve;const callback=vm.runInContext('(function(){called=true;correct=this===principal;complete();return 0})',context);setup(callback);gc();timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true)});assert.equal(context.called,true);assert.equal(context.correct,true)});
    writeSync(1,JSON.stringify({kind:'native-timers-reference-only',version:process.version,platform:process.platform,arch:process.arch,v8:process.versions.v8,cases:observations.length,failures,observations,limits:['Native runtime already bootstrapped; direct binding controls only','Foreign function uses a VM context, not a fresh Node native Realm/Environment','No complete async/tick/fatal/native phase/lifecycle/security/OOM differential','Unref-only natural-exit controls run in separate processes']})+'\n');
    if(failures)process.exitCode=1;
  }
  main().catch(error=>{writeSync(2,error.stack+'\n');process.exitCode=1});
}
