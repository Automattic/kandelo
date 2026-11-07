'use strict';
// Actual extracted Server publication/adoption over explicit native Node
// TCPWrap/capability/scheduling and limited Socket construction boundaries.
// The candidate SpiderMonkey accept/init/watch implementation is not executed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const net=require('node:net'),async=require('node:async_hooks'),{EventEmitter,once}=require('node:events');
assert.equal(process.version,'v26.13.0');
const root=path.resolve(__dirname,'../../../..');
const source=fs.readFileSync(path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factories=Function(bundle+';return {values:_createNodeValuesPlatform,socket:_createNodeSocketStream};')();
const util=require('node:util'),os=require('node:os');
const values=factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const start=source.indexOf('    function acceptServer(server, owner, generation) {'),end=source.indexOf('    function closeServerOwner(',start);assert(start>=0&&end>start);
const acceptFactory=Function('nat','Socket','isIP','serverSocketChannel','connectError','serverOwnerTokens','socketNativeOwners','_nodeSocketStream','maybeCloseServer','serverOwner',source.slice(start,end)+';return acceptServer;');
const a=source.indexOf('        _adoptAccepted(lease) {'),b=source.indexOf('        _adoptFd(',a);assert(a>=0&&b>a);
const adoptFactory=Function('nat','return ({'+source.slice(a,b)+'})._adoptAccepted;');
const results=[];
async function scenario(mode,count){
 const host=net.createServer();host.listen(0,'127.0.0.1');await once(host,'listening');
 const listenerId=host._handle.getAsyncId(),capabilities=new WeakMap(),handles=new Set(),closing=new Map(),clients=[],pending=[],observations=[],inits=[],rejections=[];
 let ready,constructed=0,completed=0,unclaimed=0,thenReads=0,ownerPrototype,oldThen;
 const marker=Error('constructor-options');
 const hook=async.createHook({init(id,type,trigger,resource){if(type==='TCPWRAP'&&trigger===listenerId)inits.push({id,resource,trigger});}}).enable();
 function close(handle){if(closing.has(handle))return closing.get(handle);const promise=new Promise(resolve=>handle.close(resolve));closing.set(handle,promise);return promise;}
 const originalConnection=host._handle.onconnection;
 host._handle.onconnection=function(status,handle){
  const request=pending.shift();assert(request,'one actual pending accept request');
  if(status){request.reject(status);return;}
  handles.add(handle);ready=handle;
  if(mode==='thenPoison'&&!ownerPrototype){ownerPrototype=Object.getPrototypeOf(handle);oldThen=Object.getOwnPropertyDescriptor(ownerPrototype,'then');Object.defineProperty(ownerPrototype,'then',{configurable:true,get(){thenReads++;throw marker;}});}
  const init=inits.find(entry=>entry.resource===handle);assert(init);assert(handle.fd>=0);
  const capability=Object.create(null);capabilities.set(capability,{handle});request.resolve(capability);
 };
 const native={
  socketAcceptLease(fd){assert.equal(fd,host._handle.fd);const promise=new Promise((resolve,reject)=>pending.push({resolve,reject}));const then=promise.then;promise.then=function(...args){const child=Reflect.apply(then,this,args);child.catch(error=>{rejections.push(error);});return child;};return promise;},
  socketAcceptedFd(token){const record=capabilities.get(token);assert(record?.handle);return record.handle.fd;},
  socketAcceptedClose(token){const record=capabilities.get(token);if(record?.handle){const handle=record.handle;record.handle=null;unclaimed++;close(handle);}completed++;},
  socketOwnerAdoptAccepted(token){const record=capabilities.get(token);assert(record?.handle);const owner=record.handle;record.handle=null;return owner;},
  socketOwnerAbortAdoption:close,
  socketAddress(fd,peer){const handle=[...handles].find(handle=>handle.fd===fd);assert(handle);const value={};assert.equal((peer?handle.getpeername(value):handle.getsockname(value)),0);return value;},
  socketRef(){throw Error('Unref is outside this focused native publication component');},
 };
 const socketNativeOwners=new WeakMap();
 const socketStream=factories.socket({Buffer,FastBuffer:Buffer,async:{symbols:{owner_symbol:Symbol('component owner')}},values,types:util.types,native});
 class Socket extends EventEmitter{
  constructor(options){super();constructed++;this.options=options;socketStream.initOptions(this,options);assert(ready);assert(ready.fd>=0);this.expectedOwner=ready;}
  _adoptFd(_fd,owner){assert.equal(owner,this.expectedOwner);this._handle=owner;socketNativeOwners.set(this,owner);}
  destroy(){if(this._handle)close(this._handle);}
  _scheduleRead(){throw Error('This component intentionally uses pauseOnConnect');}
 }
 Socket.prototype._adoptAccepted=adoptFactory(native);
 const server=new EventEmitter();Object.assign(server,{_fd:host._handle.fd,_generation:1,_referenced:true,_connections:0,pauseOnConnect:true,_maybeClose(){}});
 Object.defineProperty(server,'allowHalfOpen',{get(){assert(ready);assert(inits.some(entry=>entry.resource===ready));assert(ready.fd>=0);if(mode==='getterThrow')throw marker;return false;}});
 if(mode==='drop')server.maxConnections=0;
 server.on('drop',data=>{assert.equal(data.localPort,host.address().port);observations.push({kind:'drop',remotePort:data.remotePort});});
 server.on('error',error=>{throw error;});
 server.on('connection',socket=>{assert.equal(socket._handle,socket.expectedOwner);assert.equal(socket._handle.getAsyncId(),inits.find(entry=>entry.resource===socket.expectedOwner).id);observations.push({kind:'connection',id:socket._handle.getAsyncId(),owner:socket._handle});});
 const owner={fd:host._handle.fd,generation:1,referenced:true};
 const accept=acceptFactory(native,Socket,net.isIP,{hasSubscribers:false},value=>value,new WeakSet([owner]),socketNativeOwners,socketStream,()=>{},()=>owner);
 accept(server,owner,1);
 const deadline=Date.now()+5000;
 try{
  for(let i=0;i<count;i++){const client=net.connect(host.address().port,'127.0.0.1');client.on('error',()=>{});clients.push(client);}
  await Promise.all(clients.map(client=>once(client,'connect')));
  while(completed<count){assert(Date.now()<deadline,'bounded completion deadline');await new Promise(setImmediate);}
  assert.equal(inits.length,count);assert.equal(new Set(inits.map(entry=>entry.id)).size,count);assert(inits.every(entry=>entry.trigger===listenerId));
  if(mode==='normal'||mode==='thenPoison'){assert.equal(constructed,count);assert.equal(server._connections,count);assert.equal(new Set(observations.map(entry=>entry.owner)).size,count);assert.equal(unclaimed,0);}
  else if(mode==='drop'){assert.equal(constructed,0);assert.equal(observations.length,count);assert.equal(unclaimed,count);}
  else{assert(rejections.every(error=>error===marker));assert.equal(rejections.length,count);assert.equal(constructed,0);assert.equal(unclaimed,count);}
  assert.equal(thenReads,0);
  return {mode,connections:count,actualDistinctOwners:inits.length,initBeforeConstructor:true,initDescriptorReadIntentionallyNotAttempted:true,fdAtConstructor:'actual live descriptor',sameOwnerPublished:(mode==='normal'||mode==='thenPoison')?count:0,thenReads,closedBeforeAdoption:unclaimed,originalErrorIdentity:mode==='getterThrow'?rejections.every(error=>error===marker):undefined};
 }finally{
  if(ownerPrototype){if(oldThen)Object.defineProperty(ownerPrototype,'then',oldThen);else delete ownerPrototype.then;}
  hook.disable();owner.generation++;owner.fd=-1;server._generation++;server._fd=-1;host._handle.onconnection=originalConnection;
  for(const handle of handles)close(handle);for(const client of clients)client.destroy();
  await Promise.all([...closing.values()]);await new Promise(resolve=>host.close(resolve));
 }
}
(async()=>{
 for(const [mode,count]of [['normal',5],['thenPoison',2],['drop',3],['getterThrow',2]])results.push(await scenario(mode,count));
 const report={scope:'Actual extracted candidate Server accept/adopt publication with real native Node accepted TCPWrap resources/IDs/descriptors and null-prototype capability boundary; limited Socket wrapper. Not candidate SpiderMonkey init/watch/fatal or full net conformance.',native:process.version,results,pass:results.length,globalSetup:0,engineBuilds:0};
 fs.writeFileSync(process.env.TCP_ACCEPT_CONTROL_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
