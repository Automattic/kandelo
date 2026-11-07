'use strict';
// Selected production Socket/stream sources over explicit actual pinned native
// Node TCP/StreamBase and OS boundaries. No guest JSAPI or TTY facade is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const nativeNet=require('node:net'),stream=require('node:stream'),util=require('node:util'),os=require('node:os'),events=require('node:events'),timers=require('node:timers'),asyncHooks=require('node:async_hooks');
const {once}=events;assert.equal(process.version,'v26.13.0');
const mode=process.argv[2],repo=path.resolve(process.argv[3]);assert(['native','candidate'].includes(mode));
const source=fs.readFileSync(path.join(repo,'packages/registry/node-compat/bootstrap.js'),'utf8');
const bundle=fs.readFileSync(path.join(repo,'third_party/node-core/node-core.js'),'utf8');
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
 socketOwnerValidate(handle){actual(handle);if(closing.has(handle))throw Error('actual native owner closed');return handle.hasRef();},
 socketOwnerCommitAdoption(handle){actual(handle);if(closing.has(handle))throw Error('actual native owner closed before publication');},
 socketOwnerAbortAdoption(handle){actual(handle);return close(handle);},
 socketAddress(fd,peer){const handle=[...handles].find(h=>h.fd===fd);assert(handle);const out={};assert.equal((peer?handle.getpeername(out):handle.getsockname(out)),0);return out;},
 socketShutdown(fd){const handle=[...handles].find(h=>h.fd===fd);assert(handle);const request=new nativeStream.ShutdownWrap();request.oncomplete=()=>{};const error=handle.shutdown(request);if(error)throw Object.assign(Error('shutdown'),{errno:error});},
 socketOwnerAdopt(){throw Error('Numeric-fd adoption is outside this fixture');},
};
const symbols={owner_symbol:Symbol('actual candidate stream owner'),async_id_symbol:Symbol('actual candidate async id')};
const socketStream=factory.socket({Buffer,FastBuffer,async:{symbols},values,types:util.types,native,stream,
 markResource:receiver=>require('node:worker_threads').markAsUncloneable(receiver)});
function candidateNet(){
 const a=source.indexOf('const net = (() => {'),b=source.indexOf('// net.BlockList and SocketAddress',a);assert(a>=0&&b>a);
 const names=['_nodeNative','_nodeDiagnostics','_nodeNetworkIP','util','fs','_nodeValues','_nodeAsyncPlatform','_nodeSocketStream','_nodeClonePlatform','_nodeStreamPlatform','_nodeEventPlatform','_nodeDnsLookup','_nodeDispose','_errnoToCode','stream','process','timers','Buffer','_createNodeServerConstructor','_createNodePrimordials','events'];
 const args=[native,{registerProducer:name=>require('node:diagnostics_channel').channel(name)},nativeNet,util,fs,values,{symbols},socketStream,{setMode:receiver=>require('node:worker_threads').markAsUncloneable(receiver)},{require(name){assert.equal(name,'internal/streams/state');return{getDefaultHighWaterMark:stream.getDefaultHighWaterMark};}},events,require('node:dns'),Symbol.dispose,util.getSystemErrorName,stream,process,timers,Buffer,factory.server,factory.primordials,events];
 return Function(...names,source.slice(a,b)+';net.BlockList=_nodeNetworkIP.BlockList;return net;')(...args);
}
const net=mode==='native'?nativeNet:candidateNet();const Socket=net.Socket;
const results=[];
function group(name,fn){fn();results.push({name,passed:true});}
group('call/new/subclass actual receiver and newTarget guards',()=>{
 const called=Socket(),constructed=new Socket();assert(called instanceof Socket);assert(constructed instanceof Socket);
 function Legacy(options){assert.equal(Socket.call(this,options),undefined);}Object.setPrototypeOf(Legacy.prototype,Socket.prototype);const legacy=new Legacy({allowHalfOpen:true});assert(legacy instanceof Legacy);assert(legacy instanceof stream.Duplex);assert.equal(legacy.allowHalfOpen,true);
 class Derived extends Socket{}const derived=new Derived();assert(derived instanceof Derived);assert.equal(derived.constructor,Derived);
 const receiver=Object.create(Socket.prototype);assert.equal(Socket.call(receiver,{allowHalfOpen:true}),undefined);assert.equal(receiver.allowHalfOpen,true);assert(receiver._readableState&&receiver._writableState);assert.equal(receiver._handle,null);
 const unrelated={};assert(Socket.call(unrelated) instanceof Socket);assert(!Object.hasOwn(unrelated,'_readableState'));
 function Foreign(){}const foreign=Reflect.construct(Socket,[],Foreign);assert(foreign instanceof Socket);assert(!(foreign instanceof Foreign));
 assert.equal(Object.getPrototypeOf(Socket),stream.Duplex);assert.equal(Object.getPrototypeOf(Socket.prototype),stream.Duplex.prototype);
 for(const s of [called,constructed,legacy,derived,receiver,foreign])s.destroy();
});
const getterTraces=[];
group('pinned validation/spread/getter/error/initialization order',()=>{
 for(const bad of [{objectMode:true},{readableObjectMode:true},{writableObjectMode:true},{keepAliveInitialDelay:'bad'}]){
  const receiver=Object.create(Socket.prototype);assert.throws(()=>Socket.call(receiver,bad),error=>error.code==='ERR_INVALID_ARG_VALUE'||error.code==='ERR_INVALID_ARG_TYPE');assert(!Object.hasOwn(receiver,'_readableState'));
 }
 const trace=[],marker=Error('own option getter');const receiver=Object.create(Socket.prototype);
 const options={get objectMode(){trace.push('objectMode');return false;},get readableObjectMode(){trace.push('readableObjectMode');return false;},get writableObjectMode(){trace.push('writableObjectMode');return false;},get keepAliveInitialDelay(){trace.push('keepAliveInitialDelay');return undefined;},get custom(){trace.push('custom');throw marker;}};
 assert.throws(()=>Socket.call(receiver,options),error=>error===marker);assert(!Object.hasOwn(receiver,'_readableState'));getterTraces.push(trace);
 const original={keepAliveInitialDelay:-10};const socket=new Socket(original);assert.equal(original.keepAliveInitialDelay,0);assert.equal(socket._writableState.decodeStrings,false);socket.destroy();
});
async function pair(){
 const listener=observeHandle(new TCP(tcpConstants.SERVER));assert.equal(listener.bind('127.0.0.1',0),0);const address={};assert.equal(listener.getsockname(address),0);assert.equal(listener.listen(16),0);
 let resolve;const accepted=new Promise(r=>resolve=r);listener.onconnection=(status,handle)=>{assert.equal(status,0);observeHandle(handle);resolve({handle});};
 const peer=nativeNet.connect(address.port,'127.0.0.1');peer.on('error',()=>{});await bounded(once(peer,'connect'),'peer connect');const {handle}=await bounded(accepted,'actual accept');prepare(handle);await close(listener);return{handle,peer,port:address.port};
}
async function transport(name,options){
 const {handle,peer,port}=await pair();const id=handle.getAsyncId();let starts=0,stops=0;
 const start=handle.readStart,stop=handle.readStop;handle.readStart=function(...a){starts++;return Reflect.apply(start,this,a);};handle.readStop=function(...a){stops++;return Reflect.apply(stop,this,a);};
 handle.unref();const sock=new Socket({handle,allowHalfOpen:true,...options});sock.on('error',error=>{observations.push({unexpectedError:error.message});});assert.equal(sock._handle,handle);assert.equal(handle.hasRef(),false,'existing native unref state preserved');
 assert.equal(sock.ref(),sock);assert.equal(handle.hasRef(),true);assert.equal(sock.unref(),sock);assert.equal(handle.hasRef(),false);sock.ref();
 if(options.manualStart){assert.equal(starts,0,'manualStart does not arm native read');}
 else if(options.pauseOnCreate){assert.equal(starts,0);assert.equal(stops,1);}
 else assert(starts>0,'ordinary actual-handle constructor starts read');
 const expected=Buffer.from('real retained TCP bytes');const received=once(sock,'data');let context;
 sock.once('data',()=>{context=asyncHooks.executionAsyncId();});if(options.pauseOnCreate)sock.resume();peer.write(expected);const [data]=await bounded(received,'actual candidate/native data');assert.deepEqual(data,expected);assert.equal(context,id,'public callback executes in actual TCP resource');assert(starts>0);
 const peerData=once(peer,'data');await bounded(new Promise((resolve,reject)=>sock.write('é','latin1',error=>error?reject(error):resolve())),'encoded write completion');assert.deepEqual((await bounded(peerData,'encoded peer bytes'))[0],Buffer.from([0xe9]));
 const closed=once(sock,'close');sock.destroy();await bounded(closed,'actual native queued close');assert.equal(handle.fd,-os.constants.errno.EINVAL);peer.destroy();await close(handle);results.push({name,passed:true,actualPort:port,actualAsyncId:id,readStarts:starts,readStops:stops,readBytes:expected.length,latin1Bytes:1});
}
async function failureOwnership(){
 const {handle,peer,port}=await pair();const marker=Error('real native onread setter');const receiver=Object.create(Socket.prototype);
 Object.defineProperty(handle,'onread',{configurable:true,set(){throw marker;},get(){return undefined;}});
 assert.throws(()=>Socket.call(receiver,{handle,manualStart:true}),error=>error===marker);
 assert(handle.fd>=0,'caller-supplied real owner remains live after binding failure');delete handle.onread;
 const closed=once(receiver,'close');receiver.destroy();await bounded(closed,'partial receiver real close');assert.equal(handle.fd,-os.constants.errno.EINVAL);peer.destroy();await close(handle);results.push({name:'supplied-owner failure identity/ownership and partial receiver cleanup',passed:true,actualPort:port});
}
async function reinitializeLive(){
 const old=await pair(),fresh=await pair();
 const sock=new Socket({handle:old.handle,manualStart:true,allowHalfOpen:true});sock.on('error',()=>{});old.handle.unref();const oldState=sock._readableState;let getterRuns=0;
 const options={get custom(){getterRuns++;assert.equal(sock._handle,null,'receiver reset before option spread');assert.equal(sock.connecting,false);assert.equal(sock._readableState,oldState,'Duplex initialization follows the spread');return true;},manualStart:true,allowHalfOpen:true};
 assert.equal(Socket.call(sock,options),undefined);assert.equal(getterRuns,1);assert.equal(sock._handle,null);assert.notEqual(sock._readableState,oldState);assert(old.handle.fd>=0);sock.ref();assert.equal(old.handle.hasRef(),false,'detached old owner is not current ref authority');
 assert.equal(Socket.call(sock,{handle:fresh.handle,manualStart:true,allowHalfOpen:true}),undefined);assert.equal(sock._handle,fresh.handle);assert(old.handle.fd>=0,'constructor reinit does not close old caller-retained handle');
 const closed=once(sock,'close');sock.destroy();await bounded(closed,'reinitialized receiver close');assert.equal(fresh.handle.fd,-os.constants.errno.EINVAL);assert(old.handle.fd>=0);await close(old.handle);old.peer.destroy();fresh.peer.destroy();await close(fresh.handle);
 results.push({name:'live receiver reset/spread/Duplex order and retained old owner',passed:true,oldPort:old.port,newPort:fresh.port,getterRuns});
}
async function largeWrite(){
 const {handle,peer,port}=await pair();const sock=new Socket({handle,manualStart:true,allowHalfOpen:true});sock.on('error',()=>{});peer.pause();
 const payload=Buffer.alloc(2*1024*1024,0x5a);let bytes=0;const actual=[];peer.on('data',chunk=>{bytes+=chunk.length;actual.push(chunk);});
 const write=new Promise((resolve,reject)=>sock.write(payload,error=>error?reject(error):resolve()));peer.resume();await bounded(write,'actual large native write callback');
 while(bytes<payload.length)await bounded(once(peer,'data'),'actual large peer drain');assert.equal(bytes,payload.length);assert.deepEqual(Buffer.concat(actual),payload);
 const closed=once(sock,'close');sock.destroy();await bounded(closed,'large write close');peer.destroy();await close(handle);results.push({name:'actual buffer/write request/peer bytes and close',passed:true,actualPort:port,bytes});
}
(async()=>{
 try{await transport('manualStart actual inherited transport',{manualStart:true});await transport('pauseOnCreate actual read-stop/resume',{pauseOnCreate:true});await transport('ordinary handle actual read-start',{});await failureOwnership();await reinitializeLive();await largeWrite();assert.deepEqual(observations,[]);console.log(JSON.stringify({passed:true,mode,scope:'Exact candidate Socket factory/initializer/stream algorithms over actual pinned native Node TCP/state/request/OS control boundaries; Kandelo JSAPI and TTY admission unexecuted',native:{version:process.version,platform:process.platform,arch:process.arch},getterTraces,results,writeResults}));}
 finally{await Promise.all([...handles].map(handle=>close(handle)));}
})().catch(error=>{console.error(error);process.exitCode=1;});
