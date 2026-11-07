'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),net=require('node:net'),{EventEmitter,once}=require('node:events');
assert.equal(process.versions.node,'26.13.0');
const out=path.resolve(process.argv[2]),addon=require(path.join(out,'lease-owner.node'));
const sourceRoot=path.resolve(process.argv[3]||path.join(out,'candidate'));
const sourcePath=process.env.KANDELO_LEASE_BOOTSTRAP_SOURCE||path.join(sourceRoot,'packages/registry/node-compat/bootstrap.js');
const source=fs.readFileSync(sourcePath,'utf8');
const a=source.indexOf('        _accept(generation) {'),b=source.indexOf('        address() {',a);assert(a>=0&&b>a);
const actualAccept=Function('nat','Socket','isIP','serverSocketChannel','connectError','return ({'+source.slice(a,b)+'})._accept;');
const x=source.indexOf('        _adoptAccepted(lease) {'),y=source.indexOf('        _adoptFd(',x);assert(x>=0&&y>x);
const actualAdopt=Function('nat','return ({'+source.slice(x,y)+'})._adoptAccepted;');
const results=[];
async function test(name,fn){try{await fn();results.push({name,status:'pass'})}catch(e){results.push({name,status:'fail',error:e.stack})}}
async function serverCase(mode){
 const host=net.createServer();host.listen(0,'127.0.0.1');await once(host,'listening');
 const marker=Object.assign(Error(mode),{code:'MARKER'});let token,originalFd,pending,replacement,owner,constructed=0;
 const sockets=[],errors=[],connections=[];
 const init=current=>{
  if(mode==='initThrow')throw marker;
  if(mode==='initClose')addon.closeOwner(current);
  if(mode==='initLeaseReuse'){replacement=addon.reuse(token);throw marker}
  if(mode==='initReentrant'){owner=addon.adopt(token);throw marker}
 };
 const nat={socketAcceptLease(fd){token=addon.make(fd);originalFd=addon.fd(token);const promise=Promise.resolve(token),then=promise.then;promise.then=function(...args){pending=Reflect.apply(then,this,args);return pending};return promise},socketRef(){throw Error('unref outside this fixture scope')},socketAcceptedFd(value){const fd=addon.fd(value);assert(fd>=0);return fd},socketAcceptedClose:value=>addon.close(value),socketOwnerAdoptAccepted:value=>addon.adopt(value,init),socketOwnerAbortAdoption:value=>addon.closeOwner(value),socketAddress:(...args)=>addon.address(...args)};
 class Socket {
  constructor(){constructed++;if(mode==='constructorThrow')throw marker;sockets.push(this)}
  _adoptFd(_,value){this.owner=value;owner=value;if(mode==='publicationReuse'){replacement=addon.reuse(owner,true);throw marker}}
  destroy(){if(this.owner)addon.closeOwner(this.owner)}
  _scheduleRead(){throw Error('read scheduling is outside this ownership component')}
 }
 Socket.prototype._adoptAccepted=actualAdopt(nat);
 if(mode==='adoptMethodGetterThrow')Object.defineProperty(Socket.prototype,'_adoptFd',{get(){throw marker}});
 const server=new EventEmitter();Object.assign(server,{_fd:host._handle.fd,_generation:1,_referenced:true,_connections:0,pauseOnConnect:true,allowHalfOpen:false,_accept(){},_maybeClose(){}});
 server.on('error',e=>errors.push(e));server.on('connection',s=>connections.push(s));
 if(mode==='getterThrow'||mode==='getterReuse')Object.defineProperty(server,'allowHalfOpen',{get(){if(mode==='getterReuse')replacement=addon.reuse(token);throw marker}});
 if(mode==='blockListThrow')Object.defineProperty(server,'blockList',{get(){throw marker}});
 if(mode==='dropThrow'){server.maxConnections=0;server.on('drop',()=>{throw marker})}
 if(mode==='stale'){server._generation=2}
 let rejected;
 try{
  Reflect.apply(actualAccept(nat,Socket,net.isIP,{hasSubscribers:false},x=>x),server,[mode==='stale'?1:1]);
  if(mode==='stale') {assert.equal(token,undefined);return}
  if(mode==='staleAfterResolve')server._generation++;
  try{await pending}catch(e){rejected=e}
  if(['constructorThrow','getterThrow','getterReuse','blockListThrow','dropThrow'].includes(mode))assert.equal(rejected,marker);
  else assert.equal(rejected,undefined);
  assert.equal(addon.fd(token),-1);
  if(mode==='success'){assert.equal(connections.length,1);assert.equal(addon.ownerFd(owner),originalFd);assert(addon.open(originalFd))}
  else if(mode==='initReentrant'){assert.equal(errors[0],marker);assert.equal(addon.ownerFd(owner),originalFd);assert(addon.open(originalFd))}
  else if(replacement){assert.equal(addon.fd(replacement),originalFd);assert(addon.open(originalFd));if(mode.startsWith('init')||mode==='publicationReuse')assert.equal(errors[0],marker)}
  else{assert.equal(addon.open(originalFd),false);if(mode==='initThrow'||mode==='adoptMethodGetterThrow')assert.equal(errors[0],marker);if(mode==='initClose')assert.equal(errors.length,1)}
 }finally{for(const s of sockets)s.destroy();if(owner)addon.closeOwner(owner);if(token)addon.close(token);if(replacement)addon.close(replacement);await new Promise(resolve=>host.close(resolve))}
}
(async()=>{
 for(const mode of ['success','constructorThrow','getterThrow','getterReuse','blockListThrow','dropThrow','initThrow','initClose','initLeaseReuse','initReentrant','publicationReuse','adoptMethodGetterThrow','staleAfterResolve'])await test('actual-server-source:'+mode,()=>serverCase(mode));
 await test('actual-portable-lease-allocation-failure',()=>{assert.throws(()=>addon.oom());assert.equal(addon.open(addon.failedFd()),false)});
 await test('actual-portable-transfer-and-rollback',()=>{const token=addon.make(),fd=addon.fd(token),owner=addon.adopt(token);addon.close(token);assert(addon.open(fd));addon.closeOwner(owner);addon.close(token);assert.equal(addon.open(fd),false)});
 await test('private-coercion-ABA-does-not-touch-replacement',()=>{const token=addon.make(),owner=addon.adopt(token);let replacement;try{const error=addon.keepAlive(owner,true,{valueOf(){replacement=addon.reuse(owner,true);return 1}});assert.equal(error,require('node:os').constants.errno.EBADF);assert.equal(addon.keepAliveFlag(replacement),0);assert(addon.open(addon.fd(replacement)))}finally{addon.closeOwner(owner);addon.close(token);if(replacement)addon.close(replacement)}});
 await test('private-coercion-preserves-primary-error',()=>{const token=addon.make(),owner=addon.adopt(token),marker=Error('coercion');try{assert.throws(()=>addon.keepAlive(owner,true,{valueOf(){throw marker}}),e=>e===marker);assert(addon.open(addon.ownerFd(owner)))}finally{addon.closeOwner(owner);addon.close(token)}});
 await test('actual-portable-keepalive-valid-operation',()=>{const token=addon.make(),owner=addon.adopt(token);try{assert.equal(addon.keepAlive(owner,true,1),0);assert.equal(addon.keepAlive(owner,false,0),0)}finally{addon.closeOwner(owner);addon.close(token)}});
 await test('native-VM-token-GC-retires-real-lease',async()=>{let token=addon.make();const fd=addon.fd(token);token=null;for(let i=0;i<3;i++){global.gc();await new Promise(setImmediate)}assert.equal(addon.open(fd),false)});
 const crypto=require('node:crypto'),sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const report={scope:'Actual extracted candidate Server accept/adopt source over explicit construction/publication/event dependencies and actual candidate portable Lease/Owner/keepalive via pinned N-API, real accepted INET fds, real fd reuse and native VM GC/coercion. Not SpiderMonkey promise/watch/classes/realm/context teardown or public net conformance.',version:process.versions.node,nativeSha256:sha(process.execPath),addonSha256:sha(path.join(out,'lease-owner.node')),bootstrapSourceInput:{path:sourcePath,sha256:sha(sourcePath)},sourceIdentities:{controlSha256:sha(__filename),addonSourceSha256:sha(path.join(sourceRoot,'third_party/node-core/tests/socket-owner/lease-owner-addon.cc')),bootstrapSha256:sha(path.join(sourceRoot,'packages/registry/node-compat/bootstrap.js')),headerSha256:sha(path.join(sourceRoot,'third_party/node-core/socket-owner.h'))},results,pass:results.filter(r=>r.status==='pass').length,fail:results.filter(r=>r.status==='fail').length,globalSetup:0,overallSuites:0};fs.writeFileSync(path.join(out,'controls-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.fail?1:0;
})().catch(e=>{console.error(e);process.exitCode=1});
