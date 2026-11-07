'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),tls=require('node:tls'),stream=require('node:stream'),events=require('node:events'),util=require('node:util');
const {primordials}=require('internal/test/binding'),nativeKeys=require('internal/crypto/keys');
assert.equal(process.version,'v26.13.0');assert.equal(process.versions.openssl,'3.5.9');
const p=fs.realpathSync(process.env.TLS_X509_DIR),root=path.resolve(p,'../..');
const keyRoot=path.join(root,'.context/nodejs-lts-cache-v2/node-v26.13.0/test/fixtures/keys');
const cert=fs.readFileSync(path.join(keyRoot,'agent1-cert.pem'),'utf8'),key=fs.readFileSync(path.join(keyRoot,'agent1-key.pem'),'utf8'),ca=fs.readFileSync(path.join(keyRoot,'ca1-cert.pem'),'utf8');
const addon=require(path.join(p,'component.node'));
const pinned=fs.readFileSync(path.join(root,'third_party/node-core/upstream/x509/lib/internal/crypto/x509.js'),'utf8');
const adapter=fs.readFileSync(path.join(root,'third_party/node-core/x509-platform-adapter.js'),'utf8');
const x509Factory=Function('_createNodePrimordials',adapter.replace('/* NODE_X509_MODULE */',pinned)+';return _createNodeX509Platform;')(()=>primordials);
const platform=x509Factory({native:{x509Operation(...args){return addon.x509Operation(...args);}},values:{util:require('internal/util'),validators:require('internal/validators'),errors:require('internal/errors')},keys:{...nativeKeys,nativeHandlePrototype:{}},types:util.types,inspection:{inspect:util.inspect},Buffer,codecs:{copyBytes:value=>Buffer.from(value.buffer,value.byteOffset,value.byteLength)}});
const source=fs.readFileSync(path.join(p,'repo/packages/registry/node-compat/bootstrap.js'),'utf8');
const a=source.indexOf('    class TLSSocket extends stream.Duplex {'),b=source.indexOf('    const attachTLS = TLSSocket.prototype._attach;',a);assert(a>=0&&b>a);
const owners=new WeakMap(),boundary={tlsX509(owner,local,prototype){return addon.session('certificate',owner,local,prototype);},tlsClose(owner){addon.session('close',owner);}};
const Candidate=Function('stream','nativeTLS','nat','_nodeX509',source.slice(a,b)+';return TLSSocket;')(stream,owners,boundary,platform);
const rows=[];function group(name,body){try{rows.push({name,pass:true,result:body()});}catch(error){rows.push({name,pass:false,error:error.stack});}}
function shape(prototype,name){const d=Object.getOwnPropertyDescriptor(prototype,name);return{writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,length:d.value.length,name:d.value.name};}
function summary(value){return value&&{subject:value.subject,issuer:value.issuer,serial:value.serialNumber,raw:value.raw.toString('hex'),fingerprint:value.fingerprint256};}
function bounded(promise){let timer;return Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('bounded native TLS reference timed out')),3000))]).finally(()=>clearTimeout(timer));}
(async()=>{
 const peers=new Set(),server=tls.createServer({key,cert:cert+ca});server.on('secureConnection',peer=>{peers.add(peer);peer.on('error',()=>{});peer.on('close',()=>peers.delete(peer));peer.resume();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let reference,socket,session,peerSnapshot,localSnapshot;
 try{
  reference=tls.connect({host:'127.0.0.1',port:server.address().port,rejectUnauthorized:false,key,cert});reference.on('error',()=>{});
  session=addon.session('create',cert,key,ca);socket=new Candidate({});owners.get(socket).owner=session;
  group('public method descriptors, arity and anonymous function identity',()=>{for(const name of ['getPeerX509Certificate','getX509Certificate'])assert.deepEqual(shape(Candidate.prototype,name),shape(tls.TLSSocket.prototype,name));return{methods:2};});
  group('prehandshake local owner present, peer absent',()=>{assert.equal(socket.getPeerX509Certificate(),undefined);localSnapshot=socket.getX509Certificate();assert(localSnapshot instanceof platform.X509Certificate);assert.deepEqual(summary(localSnapshot),summary(reference.getX509Certificate()));assert.equal(localSnapshot.issuerCertificate,undefined);assert.equal(addon.session('ownership',session,true),true);return{local:true,peer:false,borrowedLocalDuplicated:true};});
  await bounded(events.once(reference,'secureConnect'));addon.session('handshake',session);
  group('actual peer/issuer chain matches native TLS, new wrapper per call',()=>{peerSnapshot=socket.getPeerX509Certificate();const again=socket.getPeerX509Certificate(Symbol('ignored'));assert(peerSnapshot instanceof platform.X509Certificate);assert.equal(peerSnapshot.constructor,platform.X509Certificate);assert.equal(Object.getPrototypeOf(peerSnapshot),platform.InternalX509Certificate.prototype);assert.equal(reference.getPeerX509Certificate().constructor,crypto.X509Certificate);assert.notEqual(peerSnapshot,again);assert.deepEqual(summary(peerSnapshot),summary(reference.getPeerX509Certificate()));assert.deepEqual(summary(peerSnapshot.issuerCertificate),summary(reference.getPeerX509Certificate().issuerCertificate));assert.equal(peerSnapshot.issuerCertificate,peerSnapshot.issuerCertificate);assert.equal(peerSnapshot.issuerCertificate.issuerCertificate,undefined);assert.equal(addon.session('ownership',session,false),true);return{peer:true,issuer:true,freshWrapper:true,issuerCacheIdentity:true,peerChainLeafDuplicated:true};});
  group('actual SSL server with no client certificate reports absent peer',()=>{assert.equal(addon.session('certificate',session,false,platform.nativeHandlePrototype,true),undefined);return{serverPeer:undefined};});
  group('per-wrapper raw cache does not mutate other snapshots/native material',()=>{const other=socket.getPeerX509Certificate();assert.equal(peerSnapshot.raw,peerSnapshot.raw);assert.notEqual(peerSnapshot.raw,other.raw);const first=other.raw[0];peerSnapshot.raw[0]^=1;assert.equal(other.raw[0],first);const fresh=socket.getPeerX509Certificate();assert.equal(fresh.raw[0],first);return{independent:true};});
  group('generic receiver/absent-handle and null receiver match pinned policy',()=>{for(const name of ['getPeerX509Certificate','getX509Certificate']){assert.equal(Candidate.prototype[name].call({}),undefined);assert.throws(()=>Candidate.prototype[name].call(null),TypeError);}return{ordinaryAbsent:true,nullThrows:true};});
  const closed=events.once(socket,'close');socket.destroy();await bounded(closed);global.gc?.();
  group('closed socket methods are absent; old certificates survive SSL and context release',()=>{assert.equal(socket.getPeerX509Certificate(),undefined);assert.equal(socket.getX509Certificate(),undefined);assert.equal(peerSnapshot.validToDate instanceof Date,true);assert.equal(localSnapshot.serialNumber,new crypto.X509Certificate(cert).serialNumber);assert.equal(peerSnapshot.issuerCertificate.subject,new crypto.X509Certificate(ca).subject);return{closedReturnsUndefined:true,retainedCertificates:true};});
  group('standalone existing X509 issuer absence is truthful undefined',()=>{const parsed=new platform.X509Certificate(cert);assert.equal(parsed.issuerCertificate,undefined);return{issuerAbsent:true};});
 }finally{if(socket&&!socket.destroyed)socket.destroy();if(session)addon.session('close',session);reference?.destroy();for(const peer of peers)peer.destroy();await new Promise(resolve=>server.close(resolve));}
 console.log(JSON.stringify({rows,pass:rows.filter(x=>x.pass).length,fail:rows.filter(x=>!x.pass).length,scope:'Actual production X509Material/issuer owners and actual TLSSocket/getter source over explicit real native SSL session fixture plus pinned native TLS reference; new guest JSAPI/SSL/provider/realm path is uncompiled and unexecuted'}));process.exitCode=rows.some(x=>!x.pass)?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
