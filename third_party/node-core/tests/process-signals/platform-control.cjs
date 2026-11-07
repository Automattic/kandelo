'use strict';
// Unchanged pinned listener algorithm with Node's actual native Signal owner.
// This is an adapter/native reference control, not a Kandelo engine run.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {internalBinding}=require('internal/test/binding');
const hooks=require('node:async_hooks');
assert.equal(process.version,'v26.13.0');
const mode=process.argv[2],source=process.argv[3],root=path.resolve(__dirname,'../../../..');
const constants=require('node:os').constants.signals;
const resources=new Map(),events=[];
const hook=hooks.createHook({init(id,type,trigger,resource){if(type==='SIGNALWRAP'){resources.set(id,resource);events.push(['init',id]);}},before(id){if(resources.has(id))events.push(['before',id]);},after(id){if(resources.has(id))events.push(['after',id]);},destroy(id){if(resources.has(id))events.push(['destroy',id]);}}).enable();
let target=process,created=[];
function adapter(worker=false){
 const primordials=Function('primordials',fs.readFileSync(path.join(root,'third_party/node-core/upstream/primordials.js'),'utf8')+'\nreturn primordials;')({});
 const create=Function('_createNodePrimordials',fs.readFileSync(source,'utf8')+'\nreturn _createNodeProcessSignals;')(()=>primordials);
 const Native=internalBinding('signal_wrap').Signal,proto=Native.prototype;
 const methods=Object.fromEntries(['start','stop','close','ref','unref','hasRef','getAsyncId'].map(n=>[n,proto[n]]));
 const emitter=new EventEmitter();
 create({process:emitter,signals:constants,values:{errors:require('internal/errors')},native:{workerEnvironment:worker?{threadId:1}:null,
  signalOperation(op,receiver,...args){
   if(op==='create'){const value=new Native();Object.setPrototypeOf(value,receiver);created.push(value);return value;}
   return Reflect.apply(methods[op],receiver,args);
  }}});
 return emitter;
}
if(mode==='adapter')target=adapter();
const pause=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 if(mode==='worker'){
  target=adapter(true);const listener=()=>{};target.on('SIGUSR2',listener);assert.equal(created.length,0);target.removeListener('SIGUSR2',listener);assert.equal(target.listenerCount('newListener'),0);console.log(JSON.stringify({mode,created:0,nativeSubscriptions:false}));return;
 }
 const trace=[],listener=(name,signum)=>trace.push([name,signum,hooks.executionAsyncId(),hooks.executionAsyncResource()]);
 target.on('SIGUSR2',listener);target.on('SIGUSR2',listener);
 if(mode==='adapter'){assert.equal(created.length,1);assert.equal(created[0].hasRef(),false);}
 process.kill(process.pid,'SIGUSR2');
 const deadline=Date.now()+2000;while(trace.length<2&&Date.now()<deadline)await pause();
 assert.equal(trace.length,2);assert.equal(trace[0][0],'SIGUSR2');assert.equal(trace[0][1],constants.SIGUSR2);
 assert.equal(trace[0][2],trace[1][2]);assert.equal(trace[0][3],trace[1][3]);
 assert.equal(resources.get(trace[0][2]),trace[0][3]);
 target.removeListener('SIGUSR2',listener);assert.equal(target.listenerCount('SIGUSR2'),1);
 target.removeListener('SIGUSR2',listener);assert.equal(target.listenerCount('SIGUSR2'),0);
 if(mode==='adapter')assert.equal(created[0].hasRef(),false);
 await pause();await pause();
 assert(events.some(e=>e[0]==='before'&&e[1]===trace[0][2]));
 assert(events.some(e=>e[0]==='after'&&e[1]===trace[0][2]));
 assert(events.some(e=>e[0]==='destroy'&&e[1]===trace[0][2]));
 assert.throws(()=>target.on('SIGKILL',()=>{}),{code:'EINVAL',syscall:'uv_signal_start'});
 assert.equal(target.listenerCount('SIGKILL'),0);
 await pause();await pause();
 const special=Symbol('SIGUSR2');target.on(special,listener);target.removeListener(special,listener);
 const ordinary=()=>{};target.on('SIGnotReal',ordinary);target.removeListener('SIGnotReal',ordinary);
 if(mode==='adapter')assert.equal(created.length,2);
 console.log(JSON.stringify({mode,callbacks:trace.map(([name,signum])=>[name,signum]),sameActualResource:true,unrefSubscription:true,lastListenerClose:true,initBeforeAfterDestroy:true,invalidSignal:'EINVAL',symbolsOrdinary:true}));
})().then(()=>hook.disable(),error=>{hook.disable();console.error(error);process.exitCode=1;});
