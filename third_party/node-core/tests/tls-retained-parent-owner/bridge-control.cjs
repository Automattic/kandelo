'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const nativeNet=require('node:net'),nativeTls=require('node:tls'),stream=require('node:stream'),asyncHooks=require('node:async_hooks'),{once}=require('node:events');
assert.equal(process.version,'v26.13.0');
const sourceRoot=path.resolve(process.argv[2]);
const bootstrap=fs.readFileSync(path.join(sourceRoot,'packages/registry/node-compat/bootstrap.js'),'utf8');
const adapter=fs.readFileSync(path.join(sourceRoot,'packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
const methods=['socketOwnerCreate','socketOwnerConnect','tlsPrepare','tlsConnect','tlsRef'];
const forwarding=[];
for(const name of methods){
 const match=adapter.match(new RegExp('        '+name+'\\([^)]*\\) \\{ return native\\.'+name+'\\([^)]*\\); \\},'));assert(match,name);
 const tail={},owner={},parent={},callback=()=>{},expected={socketOwnerCreate:[],socketOwnerConnect:['::1',443,6,'::',0,callback,parent],tlsPrepare:[parent,'example.test',{context:tail}],tlsConnect:[owner],tlsRef:[owner,false,tail]}[name];let actual;
 const api=Function('native','return {'+match[0]+'};')({[name](...args){actual=args;return tail;}});
 assert.equal(Reflect.apply(api[name],api,expected),tail);assert.deepEqual(actual,expected);forwarding.push(name);
}
const netStart=bootstrap.indexOf('const net = (() => {')+'const net = (() => {'.length;
const netEnd=bootstrap.indexOf('    const socketTimeout =',netStart);assert(netStart>20&&netEnd>netStart);
const tlsStart=bootstrap.indexOf('const tls = (() => {');const tlsEnd=bootstrap.indexOf('// Trust still comes',tlsStart);assert(tlsStart>netEnd&&tlsEnd>tlsStart);
function instantiate(boundary){
 const names=['_nodeNative','_nodeDiagnostics','_nodeNetworkIP','util','_nodeValues','_errnoToCode','_nodeEventPlatform','_nodeDispose','_nodeDnsLookup','stream','Buffer','_createNodePrimordials','_nodeTlsContextTrust','_nodePublicConstants'];
 const values=[boundary,{registerProducer:name=>require('node:diagnostics_channel').channel(name)},nativeNet,require('node:util'),{errors:{codes:{}}},()=> 'ECONNREFUSED',{addAbortListener:require('node:events').addAbortListener},Symbol.dispose,require('node:dns'),stream,Buffer,()=>({SafeWeakMap:WeakMap,ReflectApply:Reflect.apply,PromisePrototypeThen:Function.call.bind(Promise.prototype.then)}),{create:options=>({capturedTrustInput:options})},{load:name=>{assert.equal(name,'tls');}}];
 const body='let _nodeBeginSocketConnection;\n{'+bootstrap.slice(netStart,netEnd)+'}\n'+bootstrap.slice(tlsStart,tlsEnd)+'\nreturn tls;';
 return Function(...names,body)(...values);
}
function makeBoundary(failures=0){
 const calls=[],owners=new Map(),requests=[];let sequence=0;
 const b={calls,owners,requests,
  socketOwnerCreate(){const p=Object.create(null);Object.defineProperty(p,'fd',{get(){throw Error('borrowed public fd getter must not run in retained TLS path');}});calls.push(['tcp-birth',p]);return p;},
  tlsPrepare(parent,servername,options){const owner=Object.create(null);owners.set(owner,{parent,closed:false,referenced:true});calls.push(['ssl-birth',owner,parent,servername,options]);return owner;},
  tlsRef(owner,value){const s=owners.get(owner);assert(s);s.referenced=value;calls.push(['ref',owner,value]);},
  socketOwnerConnect(address,port,family,localAddress,localPort,callback,parent){assert(parent);const req={parent,id:++sequence};requests.push(req);calls.push(['connect',parent,address,port,family]);queueMicrotask(()=>callback(failures-->0?-61:0,parent));return req;},
  socketOwnerOfConnect(req){return req.parent;},
  socketOwnerRefConnect(req,value){calls.push(['connect-ref',req,value]);},
  socketOwnerCancelConnect(req){calls.push(['connect-cancel',req]);},
  socketOwnerAbortAdoption(parent){calls.push(['parent-abort',parent]);},
  tlsConnect(owner){assert(!owners.get(owner).closed);calls.push(['handshake',owner]);return Promise.resolve();},
  tlsInfo(owner,operation){assert.equal(operation,4);return null;},
  tlsRead(owner){calls.push(['read',owner]);return new Promise(()=>{});},
  tlsReadRelease(){throw Error('No read completion is injected by this routing control');},
  tlsClose(owner){const s=owners.get(owner);assert(s);s.closed=true;calls.push(['close',owner,s.parent]);},
 };
 return b;
}
async function routeScenario(failures){
 const boundary=makeBoundary(failures),tls=instantiate(boundary);let lookupComplete;
 const sock=tls.connect({host:'routing.invalid',port:443,lookup(host,options,callback){assert.equal(host,'routing.invalid');assert.equal(options.all,true);assert.deepEqual(boundary.calls.map(x=>x[0]),['tcp-birth','ssl-birth','ref']);lookupComplete=callback;}});
 const errors=[];sock.on('error',error=>errors.push(error));assert.equal(sock._handle,undefined);
 assert.equal(boundary.requests.length,0);sock.unref();assert.equal(boundary.owners.values().next().value.referenced,false);
 const secure=once(sock,'secureConnect');lookupComplete(null,[{address:'::1',family:6},{address:'127.0.0.1',family:4}]);await secure;
 assert.equal(boundary.requests.length,failures+1);assert.equal(errors.length,0);
 const births=boundary.calls.filter(x=>x[0]==='ssl-birth'),connects=boundary.calls.filter(x=>x[0]==='connect');assert.equal(births.length,connects.length);
 for(let i=0;i<births.length;i++){assert.equal(connects[i][1],births[i][2]);assert(boundary.calls.indexOf(births[i])<boundary.calls.indexOf(connects[i]));}
 if(failures){assert.notEqual(births[0][1],births[1][1]);assert.notEqual(births[0][2],births[1][2]);assert(boundary.owners.get(births[0][1]).closed);assert.equal(boundary.owners.get(births[1][1]).referenced,false);}
 sock.ref();assert.equal(boundary.owners.get(births.at(-1)[1]).referenced,true);
 const closed=once(sock,'close');sock.destroy();await closed;assert(boundary.owners.get(births.at(-1)[1]).closed);
 return {attempts:connects.length,freshParents:births.length,publicFdGetterInvocations:0,actualProductionTLSFragment:true,actualProductionDialPolicy:true};
}
async function cancelScenario(){
 const boundary=makeBoundary(),tls=instantiate(boundary);let lookupComplete;
 const sock=tls.connect({host:'cancel.invalid',port:443,lookup(_host,_options,callback){lookupComplete=callback;}});sock.on('error',()=>{});
 const closed=once(sock,'close');sock.destroy();await closed;lookupComplete(null,[{address:'127.0.0.1',family:4}]);await Promise.resolve();
 assert.equal(boundary.requests.length,0);assert.equal(boundary.calls.filter(x=>x[0]==='close').length,1);assert(boundary.owners.values().next().value.closed);
 return {beforeLookupCompletion:true,preparedOwnerClosed:true,noNativeConnectSubmitted:true};
}
async function nativeReference(){
 const events=[],hook=asyncHooks.createHook({init(id,type,trigger,resource){if(type==='TCPWRAP'||type==='TLSWRAP')events.push({id,type,trigger,resource});}});hook.enable();const sock=new nativeTls.TLSSocket();hook.disable();
 try{assert.deepEqual(events.map(x=>x.type),['TCPWRAP','TLSWRAP']);const wrap=sock._handle,parent=wrap._parent;assert.equal(parent,events[0].resource);assert.equal(parent.fd,-1);assert.equal(wrap.getAsyncId(),events[1].id);assert.equal(typeof wrap.onread,'function');assert.equal(typeof wrap.hasPendingRead,'function');assert.equal(wrap.hasPendingRead(),parent.hasPendingRead());sock.unref();assert.equal(parent.hasRef(),false);sock.ref();assert.equal(parent.hasRef(),true);const closed=once(sock,'close');sock.destroy();await closed;return {earlyOrder:events.map(x=>x.type),actualTCPParent:true,parentFdBeforeConnect:-1,parentRefDelegation:true,actualOnread:true};}
 finally{hook.disable();sock.destroy();}
}
(async()=>{const native=await nativeReference(),single=await routeScenario(0),fallback=await routeScenario(1),canceled=await cancelScenario();console.log(JSON.stringify({passed:true,scope:'Pinned native TLS reference plus actual extracted production forwarding/TLS/dial-policy JavaScript over explicit recording-only native boundary; no guest admission/AsyncWrap/runtime proof',nativeRuntime:{version:process.version,platform:process.platform,arch:process.arch,openssl:process.versions.openssl},forwarding,native,single,fallback,canceled}));})().catch(error=>{console.error(error);process.exitCode=1;});
