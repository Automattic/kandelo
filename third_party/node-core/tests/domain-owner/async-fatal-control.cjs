'use strict';
// Candidate Domain + actual generated AsyncHook/task and unchanged fatal handler
// over the sealed real portable execution owner/N-API roots. Explicit host EE,
// metadata/destroy queue and trampoline-registration dependencies remain below.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const {EventEmitter}=require('node:events'),nativeTimers=require('node:timers');
assert.equal(process.version,'v26.13.0');
const core=path.resolve(__dirname,'../..'),repo=path.resolve(core,'../..');
const raw=fs.readFileSync(path.join(core,'node-core.js'),'utf8');
const factory=Function(raw+';return {values:_createNodeValuesPlatform,async:_createNodeAsyncPlatform,install:_installNodeProcessExceptions,domain:_createNodeDomainPlatform};')();
const values=factory.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const owner=require(path.resolve(process.argv[2]));
const bridgeHash=require('node:crypto').createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex');assert.equal(bridgeHash,'41a1703f99ed98df3fa7aea7bfdc773e1d926ce7e8985c356ffcfae49642af6e');
const adapter=fs.readFileSync(path.join(repo,'packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
const a=adapter.indexOf('    const _nodeNative = {'),b=adapter.indexOf('\n\n    const entryPath =',a),c=adapter.indexOf('    const asyncApply = Reflect.apply, asyncAssign = Object.assign;'),d=adapter.indexOf('    // The deadline heap owns',c);assert(a>=0&&b>a&&c>=0&&d>c);
owner.clearAsyncExecution();let lifecycle,registered,trampoline,trampolineGate;const destroys=[],records=new WeakMap();
const native={...owner,isPromise:util.types.isPromise,setAsyncLifecycle(fn){lifecycle=fn;},setAsyncDestroyTracking(){},getAsyncResourceInfo(resource){assert(records.has(resource));return records.get(resource);},enqueueAsyncDestroyId(id,promise){destroys.push([id,promise]);},drainNativeAsyncDestroyIds(){return destroys.splice(0);},asyncHookFatal(error){throw error;},setUncaughtProcess(proc){registered=proc;},setDomainTrampoline(callback,gate){trampoline=callback;trampolineGate=gate;}};
const actual=Function('native','workerEnvironment',adapter.slice(c,d)+adapter.slice(a,b)+'\nreturn _nodeNative;')(native,null);
const guest=new EventEmitter();guest.report={reportOnUncaughtException:false};guest._exiting=false;
const async=factory.async({native:actual,values,process:guest});const scheduled=[];
factory.install({process:guest,values,async,native:actual,timers:{setImmediate(fn){const handle=nativeTimers.setImmediate(fn);scheduled.push(handle);return handle;}}});assert.equal(registered,guest);
const domain=factory.domain({process:guest,events:EventEmitter,values,async});assert.equal(typeof trampoline,'function');assert.equal(trampolineGate(),false);
let groups=0;const timeline=[];const observer=async.api.createHook({before(id){timeline.push(['before',id]);},after(id){timeline.push(['after',id]);}}).enable();
const create=dom=>{const resource={};dom.run(()=>{const record=async.createTask(resource,'Timeout');records.set(resource,[record.id,record.triggerId,record.frame,'Timeout']);});return resource;};
try{
 {
  const dom=domain.create();assert.equal(trampolineGate(),true);const marker=new Error('actual task domain failure');let caught=0;
  dom.on('error',error=>{assert.equal(error,marker);assert.equal(error.domain,dom);assert.equal(error.domainThrown,true);timeline.push(['domain-error']);caught++;});
  const resource=create(dom),id=resource[async.symbols.async_id_symbol];assert.equal(resource.domain,dom);
  assert.throws(()=>async.runTask(resource,()=>{assert.equal(guest.domain,dom);throw marker;},resource,[]),error=>error===marker);
  assert.equal(owner.executionAsyncId(),id);assert.equal(guest.domain,dom);
  assert.equal(guest._fatalException(marker,false),true);assert.equal(caught,1);assert.equal(owner.executionAsyncId(),0);assert(!owner.hasAsyncExecution());assert.equal(domain.active,null);
  assert(timeline.findIndex(e=>e[0]==='domain-error')<timeline.findIndex(e=>e[0]==='after'&&e[1]===id));async.retireTask(resource);async.drainDestroys();groups++;
 }
 {
  const dom=domain.create();let emitter,handled=0;const marker=new Error('emitted');
  dom.run(()=>{emitter=new EventEmitter();});dom.on('error',error=>{assert.equal(error.domainEmitter,emitter);assert.equal(error.domainThrown,false);handled++;});
  const resource=create(dom);async.runTask(resource,()=>emitter.emit('error',marker),emitter,[]);assert.equal(handled,1);assert(!owner.hasAsyncExecution());async.retireTask(resource);async.drainDestroys();groups++;
 }
 {
  const dom=domain.create(),original=new Error('body'),handler=new Error('handler');dom.on('error',()=>{throw handler;});const resource=create(dom);
  assert.throws(()=>async.runTask(resource,()=>{throw original;},resource,[]),error=>error===original);
  assert.throws(()=>guest._fatalException(original,false),error=>error===handler);assert(owner.hasAsyncExecution());
  // Explicit component teardown after a real unhandled handler failure. The
  // native C++ exit7 boundary is not executed or counted as recovery here.
  owner.clearAsyncExecution();async.retireTask(resource);async.drainDestroys();groups++;
 }
 {
  const dom=domain.create(),marker=new Error('unhandled domain');const resource=create(dom);let exits=0;guest.on('exit',code=>{assert.equal(code,1);exits++;});
  assert.throws(()=>async.runTask(resource,()=>{throw marker;},resource,[]),error=>error===marker);
  assert.equal(guest._fatalException(marker,false),false);assert.equal(exits,1);assert(guest._exiting);assert(owner.hasAsyncExecution());owner.clearAsyncExecution();async.retireTask(resource);async.drainDestroys();groups++;
 }
 console.log(JSON.stringify({groups,realPortableExecutionOwner:true,actualCandidateDomainAsyncFatalAlgorithms:true,handlerThrowAndUnhandledRemainFailures:true,scope:'Explicit host EventEmitter/timer/metadata/destroy/trampoline-registration dependencies; no production JSAPI/GC/Promise/fatal C++ exit/guest claim'}));
}finally{observer.disable();for(const handle of scheduled)nativeTimers.clearImmediate(handle);owner.clearAsyncExecution();assert.equal(owner.retainedBytes(),0);}
