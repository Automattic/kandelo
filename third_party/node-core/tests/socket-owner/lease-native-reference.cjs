'use strict';
const net=require('node:net'),async=require('node:async_hooks'),fs=require('node:fs'),assert=require('node:assert/strict');
assert.equal(process.versions.node,'26.13.0');let client,captured,observed=false;
const marker=Error('accepted-constructor-getter');
const hook=async.createHook({init(id,type,trigger,resource){if(type==='TCPWRAP')captured=resource}});
const server=net.createServer();const timer=setTimeout(()=>{console.error('native reference deadline');process.exitCode=1;client?.destroy();try{captured?.close()}catch{}server.close()},2500);
Object.defineProperty(server,'allowHalfOpen',{get(){assert(captured);assert.notEqual(captured,client._handle);assert(captured.fd>=0);assert(fs.fstatSync(captured.fd).isSocket());observed=true;throw marker}});
process.once('uncaughtException',error=>{assert.equal(error,marker);assert(observed);hook.disable();const handle=captured;handle.close(()=>{client.destroy();server.close(()=>{clearTimeout(timer);console.log(JSON.stringify({version:process.versions.node,acceptedNativeHandleOwnsSocketBeforeConstructorGetter:true,originalErrorIdentity:true}))})})});
server.listen(0,'127.0.0.1',()=>{hook.enable();client=net.connect(server.address().port,'127.0.0.1');client.on('error',()=>{})});
