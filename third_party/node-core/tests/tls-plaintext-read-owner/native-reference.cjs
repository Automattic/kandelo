'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const tls=require('node:tls'),net=require('node:net'),asyncHooks=require('node:async_hooks'),{once}=require('node:events');
assert.equal(process.version,'v26.13.0');
(async()=>{
 const events=[];const hook=asyncHooks.createHook({init(id,type,trigger,resource){if(type==='TLSWRAP'||type==='TCPWRAP')events.push({id,type,trigger,resource});}});hook.enable();
 const socket=new tls.TLSSocket();hook.disable();
 const deadline=setTimeout(()=>{throw Error('native TLS close deadline');},2000);deadline.unref();
 try{
  const owner=socket._handle;const order=events.map(x=>x.type);assert.deepEqual(order,['TCPWRAP','TLSWRAP']);
  assert.equal(typeof owner.hasPendingRead,'function');assert.equal(owner._parent,events[0].resource);
  assert.equal(typeof owner._parent.hasPendingRead,'function');assert.equal(owner.hasPendingRead(),owner._parent.hasPendingRead());assert.equal(typeof owner.onread,'function');
  assert.equal(owner.getAsyncId(),events[1].id);assert.equal(Object.getPrototypeOf(tls.TLSSocket.prototype),net.Socket.prototype);
  const production=fs.readFileSync(path.resolve(__dirname,'../../../../packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
  const method=production.match(/        tlsReadRelease\([^)]*\) \{ return native\.tlsReadRelease\([^)]*\); \},/);assert(method);
  const promise=Promise.resolve('real native Promise'),fault={actualBeforeNativeBoundary:true};let received;
  const bridge=Function('native','return {'+method[0]+'};')({tlsReadRelease(...args){received=args;throw fault;}});
  assert.throws(()=>bridge.tlsReadRelease(owner,promise,'tail'),error=>error===fault);
  assert.equal(received[0],owner);assert.equal(received[1],promise);assert.equal(received[2],'tail');
  const closed=once(socket,'close');socket.destroy();await closed;
  console.log(JSON.stringify({passed:true,scope:'Pinned native TLS constructor/handle reference and actual extracted curated release forwarder with expected pre-native thrown boundary; no Kandelo admission or guest proof',order,hasPendingRead:'real-parent-proxy',onread:'function',nativeTLSAsyncId:events[1].id,rawTCPAsyncId:events[0].id,constructorBeforeAnyConnect:true,retainedActualTCPParent:true,realCloseObserved:true,forwardedActualResourceAndPromise:true}));
 }finally{clearTimeout(deadline);socket.destroy();hook.disable();}
})().catch(error=>{console.error(error);process.exitCode=1;});
