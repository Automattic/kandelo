'use strict';
// Actual Node TCPWRAP hook events/IDs/aliases drive the candidate hook registry.
// No replacement IDs/providers are assigned. Context storage is the actual
// portable execution owner through Node-API roots; production SpiderMonkey
// callback/GC behavior is not executed. A compiled owner bridge is required.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict'),async=require('node:async_hooks'),util=require('node:util');
const {once}=require('node:events');
assert.equal(process.version,'v26.13.0');
const root=path.resolve(__dirname,'../../..');
const core=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const make=Function(core+';return _createNodeAsyncPlatform;')();
const executionOwner=require(path.resolve(process.argv[2]));
executionOwner.clearAsyncExecution();
const records=new WeakMap(),drivers=new Map(),active=[];
let lifecycle,observer,tracking=false;
const destroys=[];
const native={...executionOwner,
 getAsyncContext:()=>executionOwner.getAsyncContext(),setAsyncContext:value=>executionOwner.setAsyncContext(value),
 getDefaultTriggerAsyncId:()=>executionOwner.getDefaultTriggerAsyncId(),
 swapDefaultTriggerAsyncId(){throw Error('Default override is outside this control');},
 allocateAsyncId(){throw Error('This control consumes actual TCP IDs, not an allocator surrogate');},
 getAsyncResourceInfo(resource){const record=records.get(resource);if(!record)throw Error('No real TCP resource record');return record;},
 isPromise:util.types.isPromise,
 setAsyncLifecycle(callback){lifecycle=callback;observer=async.createHook({
  init(id,type,trigger,resource){
   if(type!=='TCPWRAP')return;
   const raw=typeof resource.getAsyncId==='function'?resource:resource.handle;
   if(!raw||typeof raw.getAsyncId!=='function'||raw.getAsyncId()!==id)throw Error('Unobserved native TCP alias');
   const frame=executionOwner.getAsyncContext()?.frame;
   records.set(raw,[id,trigger,frame,type,resource]);drivers.set(id,raw);lifecycle('native:init',raw,frame);
  },
  before(id){const resource=drivers.get(id);if(!resource)return;
   active.push({id,resource});lifecycle('before',resource,records.get(resource)[2]);},
  after(id){const entry=active[active.length-1];if(!entry||entry.id!==id)return;
   lifecycle('after',entry.resource);active.pop();},
  destroy(id){drivers.delete(id);if(tracking)destroys.push([id,false]);},
 }).enable();},
 setAsyncDestroyTracking(value){tracking=value;},
 enqueueAsyncDestroyId(){throw Error('No candidate-owned numeric lifetime in this control');},
 drainNativeAsyncDestroyIds:()=>destroys.splice(0),
 asyncHookFatal(error){throw error;},
};
const values={errors:require('internal/errors'),validators:require('internal/validators'),util:require('internal/util'),require};
const platform=make({native,values,process});
(async()=>{
 let peer,accepted;const ready=new Promise(resolve=>accepted=resolve);
 const server=net.createServer(socket=>{peer=socket;accepted();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const socket=net.connect({host:'127.0.0.1',port:server.address().port});socket.on('error',()=>{});await once(socket,'connect');await ready;
 const handle=socket._handle,old=handle.getAsyncId(),replacement={type:handle.getProviderType(),handle};let next,armed=true;
 const rows=[],role=id=>id===old?'old':id===next?'new':'other';
 const hook=platform.api.createHook({
  init(id,type,trigger,resource){if(resource===replacement){next=id;rows.push({kind:'init',type,trigger:role(trigger),execution:role(platform.api.executionAsyncId())});}},
  before(id){if(id!==old&&id!==next)return;rows.push({kind:'before',id:role(id),execution:role(platform.api.executionAsyncId())});
   if(id===old&&armed){armed=false;handle.asyncReset(replacement);}},
  after(id){if(id===old||id===next)rows.push({kind:'after',id:role(id),execution:role(platform.api.executionAsyncId()),replacement:platform.api.executionAsyncResource()===replacement});},
 }).enable();
 const deadline=setTimeout(()=>socket.destroy(Error('socket async adapter deadline')),5000);deadline.unref();
 const closed=once(socket,'close');
 socket.on('data',chunk=>{rows.push({kind:'data',id:role(platform.api.executionAsyncId()),replacement:platform.api.executionAsyncResource()===replacement,body:chunk.toString()});socket.destroy();});
 socket.on('close',()=>rows.push({kind:'close',id:role(platform.api.executionAsyncId()),replacement:platform.api.executionAsyncResource()===replacement}));
 try{
  peer.write('payload');await closed;
  assert.deepEqual(rows.find(row=>row.kind==='data'),{kind:'data',id:'old',replacement:true,body:'payload'});
  assert.deepEqual(rows.find(row=>row.kind==='after'),{kind:'after',id:'old',execution:'old',replacement:true});
  assert.deepEqual(rows.find(row=>row.kind==='close'),{kind:'close',id:'new',replacement:true});
  console.log(JSON.stringify({passed:true,rows,boundary:'candidate async JS registry over actual native TCP IDs/hook order/alias replacement; production JSAPI/GC unrun'}));
 }finally{clearTimeout(deadline);hook.disable();socket.destroy();peer.destroy();await new Promise(resolve=>server.close(resolve));observer.disable();executionOwner.clearAsyncExecution();}
})().catch(error=>{observer.disable();console.error(error);process.exitCode=1;});
