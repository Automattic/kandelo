'use strict';
// Selected production Socket/stream sources over explicit actual pinned native
// Node TCP/StreamBase and OS boundaries. No guest JSAPI or TTY facade is used.
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
async function group(name,body){try{results.push({name,result:await body()});}catch(error){results.push({name,nonpass:{name:error.name,code:error.code,message:error.message}});}}
async function noOwnerFinal(){
 const socket=new Socket();let calls=0,args,returned,thrown;const marker={original:'final callback'};
 try{const final=socket._final;returned=Reflect.apply(final,socket,[function(...values){calls++;args=values;return 'callback return';}]);let same=false;try{Reflect.apply(final,socket,[()=>{throw marker}]);}catch(error){same=error===marker;}return{calls,args,returned,sameOriginalThrow:same};}finally{socket.destroy();}
}
async function noOwnerEnd(){
 const socket=new Socket(),errors=[],events=[];socket.on('error',error=>errors.push(error.code||error.message));socket.on('finish',()=>events.push('finish'));
 try{await bounded(new Promise((resolve,reject)=>socket.end(error=>error?reject(error):resolve())),'never connected final');return{errors,events,finished:socket.writableFinished};}finally{socket.destroy();}
}
async function noOwnerSoon(){
 const socket=new Socket(),events=[],errors=[];socket.on('error',e=>errors.push(e.code||e.message));socket.on('finish',()=>events.push('finish'));socket.on('close',()=>events.push('close'));
 try{const closed=once(socket,'close');const result=socket.destroySoon();await bounded(closed,'never connected destroySoon close');return{returnedUndefined:result===undefined,events,errors,destroyed:socket.destroyed};}finally{socket.destroy();}
}
async function liveSoon(repeat=false,finished=false){
 assert.equal(typeof Socket.prototype.destroySoon,'function');
 const{handle,peer}=await pair();const socket=new Socket({handle,allowHalfOpen:true,manualStart:true});const events=[],errors=[],chunks=[];let callbacks=0,closeCount=0;
 socket.on('error',error=>errors.push(error.code||error.message));socket.on('finish',()=>events.push('finish'));socket.on('close',()=>{events.push('close');closeCount++});peer.on('data',chunk=>chunks.push(chunk));
 const ended=once(peer,'end'),closed=once(socket,'close');const payload=Buffer.alloc(finished?8192:2*1024*1024,0x5a);
 try{
  peer.pause();socket.write(payload,error=>{callbacks++;if(error)errors.push(error.code||error.message);events.push('write')});
  if(finished){const done=once(socket,'finish');socket.end();setImmediate(()=>peer.resume());await bounded(done,'actual final before destroySoon');}
  const result=socket.destroySoon();if(repeat)socket.destroySoon();setImmediate(()=>peer.resume());
  await bounded(Promise.all([closed,ended]),'actual flushed bytes and queued close');const bytes=Buffer.concat(chunks);assert.deepEqual(bytes,payload);
  return{returnedUndefined:result===undefined,events,errors,callbacks,closeCount,bytes:bytes.length,destroyed:socket.destroyed,actualHandleRetired:handle.fd<0};
 }finally{socket.destroy();peer.destroy();await close(handle);}
}
(async()=>{
 try{
  await group('unowned final completion and original callback throw',noOwnerFinal);
  await group('never connected public end completes actual Writable',noOwnerEnd);
  await group('pinned destroySoon function descriptor',()=>{const d=Object.getOwnPropertyDescriptor(Socket.prototype,'destroySoon');return{exists:!!d,name:d?.value.name,length:d?.value.length,enumerable:d?.enumerable,writable:d?.writable,configurable:d?.configurable};});
  await group('never connected destroySoon finish then close',noOwnerSoon);
  await group('real TCP buffered write flushed before destroySoon close',()=>liveSoon());
  await group('real TCP repeated destroySoon closes once',()=>liveSoon(true));
  await group('real TCP already finished destroySoon closes actual owner',()=>liveSoon(false,true));
  console.log(JSON.stringify({phase,results,writeResults,scope:'Actual generated production Socket/stream/bootstrap owners over explicit genuine native TCP/WriteWrap/ShutdownWrap/close/VM/state dependencies; no guest JSAPI or server activation'}));
 }finally{await Promise.all([...handles].map(handle=>close(handle)));}
})().catch(error=>{console.error(error);process.exitCode=1});
