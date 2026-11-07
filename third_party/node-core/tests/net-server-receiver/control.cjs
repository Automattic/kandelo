'use strict';
// Exact candidate constructor/Server-owner source over explicitly identified
// pinned native EventEmitter/Duplex/TCPWrap provider boundaries. This does not
// execute Kandelo's guest JSAPI, kernel, accept initialization or fatal handler.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const util=require('node:util'),os=require('node:os'),events=require('node:events'),nativeNet=require('node:net');
const {Duplex,getDefaultHighWaterMark}=require('node:stream');
assert.equal(process.version,'v26.13.0');
const mode=process.argv[2];assert(['native','candidate'].includes(mode));
const core=path.resolve(__dirname,'../..'),repo=path.resolve(core,'../..');
const bundle=fs.readFileSync(path.join(core,'node-core.js'),'utf8');
const bootstrap=fs.readFileSync(path.join(repo,'packages/registry/node-compat/bootstrap.js'),'utf8');
const spec=JSON.parse(fs.readFileSync(path.join(core,'sources.json'),'utf8'));
assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(core,spec.netServerConstructor.source.path))).digest('hex'),spec.netServerConstructor.source.sha256);
const factory=Function(bundle+';return {primordials:_createNodePrimordials,values:_createNodeValuesPlatform,server:_createNodeServerConstructor,socket:_createNodeSocketStream};')();
const values=factory.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const results=[],closing=new Map(),allHandles=new Set(),listeners=new Map(),accepted=new Set(),clients=new Set(),capabilities=new WeakMap(),socketNativeOwners=new WeakMap();
const failures=[],optionCalls=[];let acceptedCount=0,failSetup=null;
function close(handle){if(!handle)return Promise.resolve();if(closing.has(handle))return closing.get(handle);const result=new Promise(resolve=>handle.close(resolve));closing.set(handle,result);return result;}
function record(code,name){const error=Object.assign(new Error(name||String(code)),{code,errno:code,syscall:name});return error;}
function address(handle,peer){const out={};const status=peer?handle.getpeername(out):handle.getsockname(out);if(status)throw record(status,'getsockname');return out;}
const {TCP,constants}=process.binding('tcp_wrap');
function pendingPromise(owner){const promise=new Promise((resolve,reject)=>owner.pending.push({resolve,reject}));
 const then=promise.then;promise.then=function(...args){const child=Reflect.apply(then,this,args);child.catch(error=>failures.push(error));return child;};return promise;}
const native={
 socketListen(host,port,family,backlog,ipv6Only,reusePort){
  assert.equal(reusePort,false,'component uses only ordinary native binding flags');
  const handle=new TCP(constants.SERVER);allHandles.add(handle);
  let status=family===6?handle.bind6(host,port,ipv6Only?1:0):handle.bind(host,port);
  if(!status)status=handle.listen(backlog);
  if(status){close(handle);throw record(status,'listen');}
  const owner={handle,pending:[],ready:[],closed:false,fd:handle.fd};assert(owner.fd>=0);listeners.set(owner.fd,owner);
  handle.onconnection=(status,child)=>{
   if(status){const next=owner.pending.shift();if(next)next.reject(record(status,'accept'));return;}
   allHandles.add(child);accepted.add(child);acceptedCount++;
   const token=Object.create(null);capabilities.set(token,{handle:child});
   const next=owner.pending.shift();if(next)next.resolve(token);else owner.ready.push(token);
  };
  return owner.fd;
 },
 socketAcceptLease(fd){const owner=listeners.get(fd);assert(owner&&!owner.closed);if(owner.ready.length)return Promise.resolve(owner.ready.shift());return pendingPromise(owner);},
 socketAcceptedFd(token){const state=capabilities.get(token);assert(state?.handle);return state.handle.fd;},
 socketAcceptedClose(token){const state=capabilities.get(token);assert(state);if(state.handle){close(state.handle);state.handle=null;}},
 socketOwnerAdoptAccepted(token){const state=capabilities.get(token);assert(state?.handle);const handle=state.handle;state.handle=null;return handle;},
 socketOwnerAbortAdoption(handle){assert(allHandles.has(handle));return close(handle);},
 socketAddress(fd,peer){const handle=[...allHandles].find(value=>value.fd===fd&&!closing.has(value));assert(handle,`actual descriptor ${fd} is owned`);return address(handle,peer);},
 socketClose(fd){const owner=listeners.get(fd);assert(owner&&!owner.closed);owner.closed=true;listeners.delete(fd);for(const request of owner.pending.splice(0))request.reject(record('ECANCELED','accept'));for(const token of owner.ready.splice(0))native.socketAcceptedClose(token);return close(owner.handle);},
 socketRef(fd,referenced){const owner=listeners.get(fd);assert(owner&&!owner.closed);owner.handle[referenced?'ref':'unref']();},
};
const socketStream=factory.socket({Buffer,FastBuffer:Buffer,async:{symbols:{owner_symbol:Symbol('component owner')}},values,types:util.types,native});
class Socket extends Duplex{
 constructor(options){super(options);this.options=options;socketStream.initOptions(this,options);}
 _read(){}
 _write(_chunk,_encoding,callback){callback(new Error('Payload transport is outside this focused component'));}
 _adoptFd(_fd,handle){assert(allHandles.has(handle));this._handle=handle;socketNativeOwners.set(this,handle);
  const delay=handle.setNoDelay,keepalive=handle.setKeepAlive;
  handle.setNoDelay=function(...args){optionCalls.push(['noDelay',...args]);if(failSetup)throw failSetup;return Reflect.apply(delay,this,args);};
  handle.setKeepAlive=function(...args){optionCalls.push(['keepAlive',...args]);return Reflect.apply(keepalive,this,args);};
 }
 _destroy(error,callback){const handle=socketNativeOwners.get(this);close(handle).then(()=>{this._onServerSocketClose?.();callback(error);});}
 _scheduleRead(){throw Error('All component connections require pauseOnConnect');}
}
function select(start,end){const a=bootstrap.indexOf(start),b=bootstrap.indexOf(end,a);assert(a>=0&&b>a,`source boundary ${start}`);return bootstrap.slice(a,b);}
Socket.prototype._adoptAccepted=Function('nat','return ({'+select('        _adoptAccepted(lease) {','        _adoptFd(')+'})._adoptAccepted;')(native);
let net;
if(mode==='native')net=nativeNet;
else{
 const helpers=select('    function argumentError(', '    function assignBlockList(')+select('    function received(', '    function timeout(')+select('    function normalizeArgs(', '    function normalizeOptions(');
 const owners=select('    const ServerWeakMap =','    // Node accepts both call and construct forms');
 const ctor=select('    const Server = _createNodeServerConstructor({','    function createConnection(');
 net={BlockList:nativeNet.BlockList};
 const boundary={events,values,socketStream,socketNativeOwners,Socket,native,isIP:nativeNet.isIP,
  connectError:error=>error,eventPlatform:{addAbortListener:events.addAbortListener},dispose:Symbol.dispose,
  dns:require('node:dns'),clone:{setMode(receiver,value){assert.equal(value,0);require('node:worker_threads').markAsUncloneable(receiver);}},
  streamPlatform:{require(name){assert.equal(name,'internal/streams/state');return{getDefaultHighWaterMark};}},net};
 net.Server=Function('_createNodePrimordials','_createNodeServerConstructor','boundary',`
 const {events,values:_nodeValues,socketStream:_nodeSocketStream,socketNativeOwners,Socket,native:nat,isIP,connectError,eventPlatform:_nodeEventPlatform,dispose:_nodeDispose,dns:_nodeDnsLookup,clone:_nodeClonePlatform,streamPlatform:_nodeStreamPlatform,net}=boundary;
 const serverSocketChannel={hasSubscribers:false};
 ${helpers}\n${owners}\n${ctor}\nreturn Server;`)(factory.primordials,factory.server,boundary);
 net.createServer=(...args)=>new net.Server(...args);
}
function publicState(server){return Object.fromEntries(['allowHalfOpen','pauseOnConnect','noDelay','keepAlive','keepAliveInitialDelay','highWaterMark','_connections','listening'].map(name=>[name,server[name]]));}
function group(name,run){run();results.push(name);}
const Server=net.Server;
group('actual receiver, ordinary call and newTarget guards',()=>{
 const called=Server(),constructed=new Server();assert(called instanceof Server);assert(constructed instanceof Server);
 class Derived extends Server{}const derived=new Derived({allowHalfOpen:true});assert(derived instanceof Derived);assert.equal(derived.allowHalfOpen,true);assert.equal(derived.constructor,Derived);
 function Legacy(options){const result=Server.call(this,options);assert.equal(result,undefined);}Object.setPrototypeOf(Legacy.prototype,Server.prototype);const legacy=new Legacy({pauseOnConnect:true});assert(legacy instanceof Legacy);assert.equal(legacy.pauseOnConnect,true);
 const receiver=Object.create(Server.prototype);assert.equal(Server.call(receiver,{noDelay:true}),undefined);assert.equal(receiver.noDelay,true);assert(receiver instanceof events.EventEmitter);
 const unrelated={};const returned=Server.call(unrelated,{keepAlive:true});assert(returned instanceof Server);assert.equal(returned.keepAlive,true);assert(!Object.hasOwn(unrelated,'_events'));
 function Foreign(){}const foreign=Reflect.construct(Server,[{noDelay:true}],Foreign);assert(foreign instanceof Server);assert(!(foreign instanceof Foreign));
 assert.equal(Object.getPrototypeOf(Server),events.EventEmitter);assert.equal(Object.getPrototypeOf(Server.prototype),events.EventEmitter.prototype);
});
group('snapshot ordering, listener identity and failed initialization',()=>{
 const order=[],marker=Error('snapshot getter');const receiver=Object.create(Server.prototype);
 const listener=function(){};const options={get pauseOnConnect(){order.push('pause');return true;},get noDelay(){order.push('delay');return 7;}};
 Server.call(receiver,options,listener);assert.deepEqual(order,['pause','delay']);assert.equal(receiver.listeners('connection')[0],listener);
 assert.equal(receiver.pauseOnConnect,true);assert.equal(receiver.noDelay,true);
 const rejected=Object.create(Server.prototype);assert.throws(()=>Server.call(rejected,{get highWaterMark(){throw marker;}},listener),error=>error===marker);assert.equal(rejected.listenerCount('connection'),0);assert(Object.hasOwn(rejected,'_events'));
 const validated=Object.create(Server.prototype);assert.throws(()=>Server.call(validated,{highWaterMark:'wrong'},listener),{code:'ERR_INVALID_ARG_TYPE'});assert.equal(validated.listeners('connection')[0],listener);assert(!Object.hasOwn(validated,'_connections'));
 const late=Object.create(Server.prototype);assert.throws(()=>Server.call(late,{blockList:{}},listener),{code:'ERR_INVALID_ARG_TYPE'});assert.equal(late._connections,0);assert.equal(late.listeners('connection')[0],listener);
 const first=new Server(listener,()=>{throw Error('ignored second listener');});assert.equal(first.listeners('connection')[0],listener);assert.equal(first.listenerCount('connection'),1);
});
group('pinned options overloads, number semantics and block-list brand',()=>{
 for(const value of [false,true,0,1,'value',Symbol('invalid'),()=>{}]){if(typeof value==='function')continue;assert.throws(()=>new Server(value),{code:'ERR_INVALID_ARG_TYPE'});}
 for(const options of [undefined,null,{},[],new Date(0)]){const server=new Server(options);assert.equal(server.highWaterMark,getDefaultHighWaterMark());assert.equal(server.keepAliveInitialDelay,0);assert.equal(server.allowHalfOpen,false);}
 for(const highWaterMark of [-1,0,0.5,NaN,Infinity]){const server=new Server({highWaterMark});assert.equal(server.highWaterMark,highWaterMark<0?getDefaultHighWaterMark():highWaterMark);}
 for(const keepAliveInitialDelay of [-1,0,1500,NaN,Infinity]){const server=new Server({keepAliveInitialDelay});assert.equal(server.keepAliveInitialDelay,~~(Math.max(0,keepAliveInitialDelay)/1000));}
 const blockList=new nativeNet.BlockList();assert.equal(new Server({blockList}).blockList,blockList);
 const truthy={};assert.equal(new Server({allowHalfOpen:truthy}).allowHalfOpen,truthy);assert.equal(new Server({},'ignored').listenerCount('connection'),0);
});
group('real prototype descriptors and no public listening assignment',()=>{
 assert.deepEqual(Object.getOwnPropertyDescriptor(Server.prototype,'constructor'),{value:Server,writable:true,enumerable:false,configurable:true});
 for(const name of ['listen','address','getConnections','close','ref','unref']){const d=Object.getOwnPropertyDescriptor(Server.prototype,name);assert.equal(typeof d.value,'function');assert.equal(d.writable,true);assert.equal(d.enumerable,true);assert.equal(d.configurable,true);}
 const descriptor=Object.getOwnPropertyDescriptor(Server.prototype,'listening');assert.equal(typeof descriptor.get,'function');assert.equal(descriptor.get.name,'get');assert.equal(descriptor.set,undefined);assert.equal(descriptor.enumerable,true);assert.equal(descriptor.configurable,true);
 const server=new Server();assert.equal(server.listening,false);assert(!Object.hasOwn(server,'listening'));assert.throws(()=>{server.listening=true;},TypeError);assert.equal(server.address(),null);
});
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('deadline: '+label)),5000);})]);}finally{clearTimeout(timer);}}
async function listen(server){server.listen({host:'127.0.0.1',port:0});await bounded(events.once(server,'listening'),'listen');assert.equal(server.listening,true);return server.address();}
async function connect(port){const peer=nativeNet.connect(port,'127.0.0.1');clients.add(peer);peer.on('error',()=>{});await bounded(events.once(peer,'connect'),'connect');return peer;}
async function connectAccepted(server,port){const promise=events.once(server,'connection');const peer=await connect(port);const [socket]=await bounded(promise,'accepted');assert.equal(socket.server,server);return{peer,socket};}
async function shutdown(server,sockets){for(const socket of sockets)socket.destroy();await bounded(new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),'close');}
(async()=>{
 try{
  {
   class Derived extends Server{}const server=new Derived({pauseOnConnect:true,noDelay:true,keepAlive:true,keepAliveInitialDelay:1500,highWaterMark:12345});
   let callbackThis;server.on('connection',function(){callbackThis=this;});
   for(const key of ['_accept','_closeServerOwner','_maybeClose'])server[key]=()=>{throw Error('mutable helper must not receive private owner');};
   const first=await listen(server);server._fd=123456;server._generation=-900;server._referenced=false;assert.equal(server.address().port,first.port);
   const {peer,socket}=await connectAccepted(server,first.port);
   assert.equal(callbackThis,server);assert.equal(socket.server,server);assert.equal(socket.readableHighWaterMark,12345);assert.equal(socket.writableHighWaterMark,12345);assert.equal(socket.readableFlowing,false);assert.equal(server._connections,1);
   assert.equal(server.unref(),server);assert.equal(server.ref(),server);assert.equal(server.listening,true);
   peer.destroy();await shutdown(server,[socket]);assert.equal(server.listening,false);assert.equal(server.address(),null);assert.equal(server._connections,0);
   const second=await listen(server);const accepted=await connectAccepted(server,second.port);accepted.peer.destroy();await shutdown(server,[accepted.socket]);
   results.push('derived receiver uses actual TCP accept owner, options, close and relisten');
  }
  {
   const server=new Server({pauseOnConnect:true}),old=await listen(server);const oldNative=mode==='native'?server._handle:listeners.get([...listeners.keys()].find(fd=>address(listeners.get(fd).handle).port===old.port)).handle;
   assert.equal(Server.call(server,{pauseOnConnect:true}),undefined);assert.equal(server.listening,false);assert.equal(server.address(),null);assert.equal(server._connections,0);assert(oldNative.fd>=0);
   const oldFirst=await connectAccepted(server,old.port);assert.equal(server.listening,false);assert.equal(server._connections,1);
   const next=await listen(server);assert.notEqual(next.port,old.port);const oldAgain=await connectAccepted(server,old.port);const fresh=await connectAccepted(server,next.port);
   assert.equal(server._connections,3);assert.equal(server.address().port,next.port);
   for(const item of [oldFirst,oldAgain,fresh]){item.peer.destroy();item.socket.destroy();}
   await bounded(new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),'current close after reinit');
   assert(oldNative.fd>=0,'old actual owner remains active until explicitly cleaned by fixture');await close(oldNative);
   results.push('active callable reinitialization retains distinct actual old listener across new binding');
  }
  {
   const server=new Server({pauseOnConnect:true}),initial=await listen(server),originalEvents=server.listenerCount('listening');
   assert.throws(()=>Server.call(server,{highWaterMark:'invalid'}),{code:'ERR_INVALID_ARG_TYPE'});assert.equal(server.listening,true);assert.equal(server.address().port,initial.port);assert.equal(server.listenerCount('listening'),originalEvents);
   const item=await connectAccepted(server,initial.port);item.peer.destroy();await shutdown(server,[item.socket]);
   results.push('pre-owner option failure preserves actual admitted listener and receiver events');
  }
  {
   const first=new Server({pauseOnConnect:true});const active=await listen(first);const second=new Server({pauseOnConnect:true});const failure=events.once(second,'error');second.listen({host:'127.0.0.1',port:active.port});const [error]=await bounded(failure,'EADDRINUSE');
   assert(mode==='candidate'?error.errno===-48:error.code==='EADDRINUSE');assert.equal(second.listening,false);assert.equal(second.address(),null);await shutdown(first,[]);
   await new Promise(resolve=>second.close(()=>resolve()));results.push('real bind failure rolls back unadmitted owner');
  }
  {
   const dns=require('node:dns'),original=dns.lookup;let release,entered;
   const admitted=new Promise(resolve=>{entered=resolve;});
   dns.lookup=function(...args){const callback=args.pop();return Reflect.apply(original,this,[...args,(...answer)=>{release=()=>callback(...answer);entered();}]);};
   const server=new Server({pauseOnConnect:true});let listeningEvents=0;server.on('listening',()=>listeningEvents++);
   try{server.listen({host:'localhost',port:0});await bounded(admitted,'actual DNS result');Server.call(server,{pauseOnConnect:true});release();await new Promise(setImmediate);assert.equal(server.listening,false);assert.equal(server.address(),null);assert.equal(listeningEvents,0);}
   finally{dns.lookup=original;}
   results.push('reinitialization rejects stale actual DNS result before native bind');
  }
  {
   const handle=new TCP(constants.SERVER);assert.equal(handle.bind('127.0.0.1',0),0);assert.equal(handle.listen(1),0);const fd=handle.fd;assert(fd>=0);await close(handle);assert(handle.fd<0);assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});
   results.push('native raw handle close uses actual invalid-fd state and EBADF');
  }
  if(mode==='candidate'){
   const server=new Server({pauseOnConnect:true,noDelay:true});const point=await listen(server),marker=Error('actual option control failure');failSetup=marker;const before=acceptedCount,prior=failures.length;const peer=await connect(point.port);
   await bounded(new Promise(resolve=>{const next=()=>failures.length>prior?resolve():setImmediate(next);next();}),'unpublished setup failure');assert.equal(acceptedCount,before+1);assert.equal(failures.at(-1),marker);assert.equal(server._connections,0);
   const handle=[...accepted].at(-1);assert(closing.has(handle));await closing.get(handle);assert(handle.fd<0,'closed native TCPWrap has no valid fd');failSetup=null;peer.destroy();await shutdown(server,[]);results.push('actual adopted-owner setup failure closes resource and preserves original throw');
   assert(optionCalls.some(call=>call[0]==='noDelay'&&call[1]===true));assert(optionCalls.some(call=>call[0]==='keepAlive'&&call[1]===true&&call[2]===1));
  }
  const report={mode,native:process.version,groups:results.length,results,actualTCPAccepts:mode==='candidate'?acceptedCount:'native provider',candidateProductionConstructor:mode==='candidate',candidateProductionServerOwners:mode==='candidate',boundaries:'Native pinned EventEmitter/Duplex/TCPWrap/DNS/clone prohibition; candidate values, constructor, complete extracted Server owner, accepted adoption and socket option algorithms. No guest JSAPI/provider/kernel/async-init/fatal/worker/full-net proof.',globalSetup:0,newNativeCompiles:0,engineBuilds:0};
  fs.writeFileSync(process.env.NET_SERVER_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{
  for(const peer of clients)peer.destroy();for(const owner of listeners.values())for(const request of owner.pending.splice(0))request.reject(record('ECANCELED','cleanup'));
  for(const handle of allHandles)close(handle);await Promise.all([...closing.values()]);
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
