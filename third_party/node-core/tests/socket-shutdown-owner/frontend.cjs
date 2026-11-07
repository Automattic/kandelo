'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const nativeNet=require('node:net'),stream=require('node:stream'),util=require('node:util'),os=require('node:os'),events=require('node:events'),timers=require('node:timers'),asyncHooks=require('node:async_hooks');
const {once}=events;assert.equal(process.version,'v26.13.0');
const phase=process.argv[2],mode=phase==='native'?'native':'candidate',repo=path.resolve(process.argv[3]);assert(['native','before','after'].includes(phase));
const source=fs.readFileSync(path.join(repo,phase==='before'?'../before/packages/registry/node-compat/bootstrap.js':'packages/registry/node-compat/bootstrap.js'),'utf8');
const bundle=fs.readFileSync(path.join(repo,phase==='before'?'../baseline-core.js':'third_party/node-core/node-core.js'),'utf8');
const factory=Function(bundle+';return {primordials:_createNodePrimordials,values:_createNodeValuesPlatform,socket:_createNodeSocketStream,server:_createNodeServerConstructor};')();
const values=factory.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const debugInit=source.match(/^_nodeDebug\.initializeDebugEnv\(process\.env\.NODE_DEBUG\);$/m);assert(debugInit);Function('_nodeDebug','process',debugInit[0])(values.require('internal/util/debuglog'),process);
const {TCP,constants:tcpConstants}=process.binding('tcp_wrap');
const nativeStream=process.binding('stream_wrap');const {FastBuffer}=require('internal/buffer');
const handles=new Set(),closing=new Map(),observations=[],writeResults=[];let forcedBindingError;
function bounded(promise,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),5000);})]).finally(()=>clearTimeout(timer));}
function observeHandle(handle){
 handles.add(handle);const nativeClose=handle.close;
 handle.close=function(callback){
  let resolve;const completed=new Promise(r=>resolve=r);closing.set(this,completed);
  return Reflect.apply(nativeClose,this,[function(...args){resolve();if(callback)Reflect.apply(callback,this,args);}]);
 };
 return handle;
}
function close(handle,callback){
 if(!handle){callback?.();return Promise.resolve();}
 if(!closing.has(handle))handle.close();
 const pending=closing.get(handle);if(callback)pending.then(callback);return pending;
}
function actual(handle){assert(handles.has(handle)&&handle instanceof TCP,'real native TCP resource required');return handle;}
function copyState(target){for(let i=0;i<target.length;i++)target[i]=nativeStream.streamBaseState[i];}
function prepare(handle){
 actual(handle);if(mode!=='candidate')return;
 const nativeWriteBuffer=handle.writeBuffer,nativeWritev=handle.writev;
 const nativeRef=handle.ref,nativeUnref=handle.unref;
 handle.ref=function(value=true){return Reflect.apply(value?nativeRef:nativeUnref,this,[]);};
 handle.configureRead=function(dispatch,state){
  const onread=this.onread;
  this.onread=function(buffer){copyState(state);return Reflect.apply(dispatch,this,[undefined,buffer,onread]);};
 };
 handle.write=function(buffer){const result=Reflect.apply(nativeWriteBuffer,this,[null,buffer]);copyState(socketStream.binding.streamBaseState);writeResults.push(typeof result==='number'?'sync':'actual-native-WriteWrap');return result;};
 handle.writeVector=function(chunks){const result=Reflect.apply(nativeWritev,this,[null,chunks,true]);copyState(socketStream.binding.streamBaseState);return result;};
}
const native={
 socketShutdownRequest(handle){actual(handle);return new nativeStream.ShutdownWrap();},
 socketOwnerValidate(handle){actual(handle);if(closing.has(handle))throw Error('actual native owner closed');return handle.hasRef();},
 socketOwnerCommitAdoption(handle){actual(handle);if(closing.has(handle))throw Error('actual native owner closed before publication');},
 socketOwnerAbortAdoption(handle){actual(handle);return close(handle);},
 socketAddress(fd,peer){const handle=[...handles].find(h=>h.fd===fd);assert(handle);const out={};assert.equal((peer?handle.getpeername(out):handle.getsockname(out)),0);return out;},
 socketShutdown(fd){const handle=[...handles].find(h=>h.fd===fd);assert(handle);const request=new nativeStream.ShutdownWrap();request.oncomplete=()=>{};const error=handle.shutdown(request);if(error)throw Object.assign(Error('shutdown'),{errno:error});},
 socketOwnerAdopt(){throw Error('Numeric-fd adoption is outside this fixture');},
};
const symbols={owner_symbol:Symbol('actual candidate stream owner'),async_id_symbol:Symbol('actual candidate async id')};
const socketStream=factory.socket({Buffer,FastBuffer,async:{symbols},values,types:util.types,native,stream,uv:{binding:process.binding('uv')},
 markResource:receiver=>require('node:worker_threads').markAsUncloneable(receiver)});
function candidateNet(){
 const a=source.indexOf('const net = (() => {'),b=source.indexOf('// net.BlockList and SocketAddress',a);assert(a>=0&&b>a);
 const names=['_nodeNative','_nodeDiagnostics','_nodeNetworkIP','util','fs','_nodeValues','_nodeAsyncPlatform','_nodeSocketStream','_nodeClonePlatform','_nodeStreamPlatform','_nodeEventPlatform','_nodeDnsLookup','_nodeDispose','_errnoToCode','stream','process','timers','Buffer','_createNodeServerConstructor','_createNodePrimordials','events'];
 const args=[native,{registerProducer:name=>require('node:diagnostics_channel').channel(name)},nativeNet,util,fs,values,{symbols},socketStream,{setMode:receiver=>require('node:worker_threads').markAsUncloneable(receiver)},{require(name){assert.equal(name,'internal/streams/state');return{getDefaultHighWaterMark:stream.getDefaultHighWaterMark};}},events,require('node:dns'),Symbol.dispose,util.getSystemErrorName,stream,process,timers,Buffer,factory.server,factory.primordials,events];
 return Function(...names,source.slice(a,b)+';net.BlockList=_nodeNetworkIP.BlockList;return net;')(...args);
}
async function pair(){
 const listener=observeHandle(new TCP(tcpConstants.SERVER));assert.equal(listener.bind('127.0.0.1',0),0);const address={};assert.equal(listener.getsockname(address),0);assert.equal(listener.listen(16),0);
 let resolve;const accepted=new Promise(r=>resolve=r);listener.onconnection=(status,handle)=>{assert.equal(status,0);observeHandle(handle);resolve({handle});};
 const peer=nativeNet.connect(address.port,'127.0.0.1');peer.on('error',()=>{});await bounded(once(peer,'connect'),'peer connect');const {handle}=await bounded(accepted,'actual accept');prepare(handle);await close(listener);return{handle,peer,port:address.port};
}

const net=mode==='native'?nativeNet:candidateNet(),Socket=net.Socket;
const results=[];
async function group(name,body){console.error('GROUP START',name);try{results.push({name,result:await body()});}catch(error){results.push({name,nonpass:{name:error.name,code:error.code,message:error.message}});}console.error('GROUP DONE',name);}

async function joined(pair,socket){socket.destroy();pair.peer.destroy();await close(pair.handle);}
async function directFinal(){
 const paired=await pair();const socket=new Socket({handle:paired.handle,allowHalfOpen:true,manualStart:true});socket.on('error',()=>{});const order=[];let calls=0,observed;let done;const completed=new Promise(r=>done=r);
 try{
  const result=socket._final(function(...args){calls++;order.push('callback');observed={empty:args.length===0,request:this instanceof nativeStream.ShutdownWrap,hasActualHandle:this?.handle===paired.handle};done();});order.push('returned');await bounded(completed,'real shutdown completion');return{returnedUndefined:result===undefined,order,calls,observed};
 }finally{await joined(paired,socket);}
}
async function callbackThrows(){
 const paired=await pair();const socket=new Socket({handle:paired.handle,allowHalfOpen:true,manualStart:true});socket.on('error',()=>{});const marker=Error('original shutdown callback');let calls=0,original=false,synchronous=false,resolve;const captured=new Promise(r=>resolve=r);
 const previous=process.hasUncaughtExceptionCaptureCallback();assert(!previous);process.setUncaughtExceptionCaptureCallback(error=>{original=error===marker;resolve();});
 try{
  try{socket._final(()=>{calls++;throw marker;});}catch(error){synchronous=true;original=error===marker;resolve();}
  await bounded(captured,'actual fatal callback ownership');return{calls,original,synchronous};
 }finally{process.setUncaughtExceptionCaptureCallback(null);await joined(paired,socket);}
}
async function noOwner(){const socket=new Socket();let calls=0,returned;const marker={original:'callback'};let same=false;try{returned=socket._final(()=>{calls++;return 7;});try{socket._final(()=>{throw marker;});}catch(error){same=error===marker;}return{calls,returned,same};}finally{socket.destroy();}}
async function queuedPayload(){
 const paired=await pair();const socket=new Socket({handle:paired.handle,allowHalfOpen:true,manualStart:true});socket.on('error',()=>{});const chunks=[],order=[];paired.peer.on('data',b=>chunks.push(b));paired.peer.pause();let finish;const completed=new Promise(r=>finish=r);const ended=once(paired.peer,'end');const payload=Buffer.alloc(2*1024*1024,0x57);
 try{socket.write(payload,error=>{assert.ifError(error);order.push('write');});socket._final(()=>{order.push('shutdown');finish();});setImmediate(()=>paired.peer.resume());await bounded(Promise.all([completed,ended]),'real write before shutdown and EOF');assert.deepEqual(Buffer.concat(chunks),payload);return{order,bytes:Buffer.concat(chunks).length};}finally{await joined(paired,socket);}
}
async function initClose(){
 const paired=await pair();const socket=new Socket({handle:paired.handle,allowHalfOpen:true,manualStart:true});socket.on('error',()=>{});const order=[];let enabled=true,calls=0;const hook=asyncHooks.createHook({init(_id,type){if(enabled&&type==='SHUTDOWNWRAP'){enabled=false;order.push('init');socket.destroy();}}}).enable();
 try{socket._final(()=>{calls++;order.push('callback');});order.push('returned');await new Promise(r=>setImmediate(r));return{order,calls};}finally{hook.disable();await joined(paired,socket);}
}
async function closedOwner(){
 const paired=await pair();const socket=new Socket({handle:paired.handle,allowHalfOpen:true,manualStart:true});socket.on('error',()=>{});await bounded(close(paired.handle),'actual attached handle close');let calls=0,result,error;try{result=socket._final(e=>{calls++;error=e?.code;});return{calls,error,returnedUndefined:result===undefined};}finally{socket.destroy();paired.peer.destroy(); /* actual raw close was already observed; do not await a second wrapper close */}
}
async function closingAdmission(){
 const paired=await pair();const socket=new Socket({handle:paired.handle,allowHalfOpen:true,manualStart:true});socket.on('error',()=>{});let count=0,callbackError,calls=0;const hook=asyncHooks.createHook({init(_id,type){if(type==='SHUTDOWNWRAP')count++;}}).enable();
 try{const closed=close(paired.handle);socket._final(e=>{calls++;callbackError=e?.code;});const immediate={count,calls,callbackError};await bounded(closed,'actual queued-close completion');return immediate;}finally{hook.disable();socket.destroy();paired.peer.destroy();}
}
async function completedCloseCallbackAdmission(){
 const paired=await pair();const socket=new Socket({handle:paired.handle,allowHalfOpen:true,manualStart:true});socket.on('error',()=>{});let count=0;const hook=asyncHooks.createHook({init(_id,type,_trigger,resource){if(type==='SHUTDOWNWRAP'&&resource.handle===paired.handle)count++;}}).enable();
 try{return await bounded(new Promise((resolve,reject)=>{
  paired.handle.close(()=>{try{let calls=0,error;socket._final(e=>{calls++;error=e?.code;});resolve({count,calls,error});}catch(e){reject(e);}});
 }),'actual onclose admission');}finally{hook.disable();socket.destroy();paired.peer.destroy();}
}
async function providerRequest(){
 const paired=await pair();const socket=new Socket({handle:paired.handle,allowHalfOpen:true,manualStart:true});socket.on('error',()=>{});let record,active=true;const hook=asyncHooks.createHook({init(id,type,trigger,resource){if(active&&type==='SHUTDOWNWRAP'){active=false;record={positiveId:id>0,actualTrigger:trigger===paired.handle.getAsyncId(),callback:typeof resource.callback==='function',oncomplete:typeof resource.oncomplete==='function',handle:resource.handle===paired.handle};}}}).enable();let resolve;const done=new Promise(r=>resolve=r);
 try{socket._final(()=>resolve());await bounded(done,'actual request init/delivery');return record;}finally{hook.disable();await joined(paired,socket);}
}
(async()=>{try{
 await group('no owner branch preserves synchronous callback and throw',noOwner);
 await group('connected final callback is genuinely deferred once',directFinal);
 await group('original callback throw is fatal-owned once',callbackThrows);
 await group('queued original TCP payload precedes shutdown EOF',queuedPayload);
 await group('real init-hook close precedes synchronous no-connection completion',initClose);
 await group('closed retained owner immediate no-connection completion',closedOwner);
 await group('queued close remains alive for request init and ENOTCONN',closingAdmission);
 await group('close completion is terminal before its own callback',completedCloseCallbackAdmission);
 await group('actual ShutdownWrap trigger/frame resource and callback fields',providerRequest);
 console.log(JSON.stringify({phase,results,scope:'Actual shared frontend over genuine native TCP/ShutdownWrap/VM/stream/fatal resource dependencies; new guest JSAPI and portable owner separately scoped'}));
}finally{await Promise.all([...handles].map(handle=>close(handle)));}})().catch(error=>{console.error(error);process.exitCode=1});
