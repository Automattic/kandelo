'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.env.TLS_CREDENTIALS_TEST_REPO || path.resolve(__dirname,'../../../..'),privateRoot=root;
const component=require(process.env.TLS_CREDENTIALS_COMPONENT),util=require('node:util');
const factories=Function(fs.readFileSync(path.join(privateRoot,'third_party/node-core/node-core.js'),'utf8')+'\nreturn{values:_createNodeValuesPlatform,create:_createNodeTlsContextTrust};')();
const values=factories.values({process,Buffer,util,inspection:util,os:{},signals:require('node:os').constants.signals});
const candidate=factories.create({native:{tlsContext:component.operation},values,types:util.types,Buffer});
const key=name=>fs.readFileSync(path.join(process.env.NODE26_SOURCE,'test/fixtures/keys',name));
const cert=key('agent1-cert.pem'),priv=key('agent1-key.pem'),ca=key('ca1-cert.pem');
(async()=>{
 const rows=[];const create=options=>candidate.create({ca,...options});
 for(const [name,options] of [['PEM',{cert,key:priv}],['PFX',{pfx:key('agent1.pfx'),passphrase:'sample'}]]){
  const countBefore=component.live();let owner=create(options);const retained=component.claim(owner);owner=null;
  for(let i=0;i<4;i++){global.gc();await new Promise(setImmediate)}
  assert(component.live()<=countBefore+1,"original context wrapper was not actually finalized");
  const actual=component.handshake(retained,cert,priv,ca);
  assert.equal(actual.completed,1,name+':'+actual.reason);assert.equal(actual.clientVerify,0);assert.equal(actual.serverVerify,0);assert.equal(actual.actualEncryptedPayload,1);
  assert.deepEqual(actual.clientCertificate,new (require('node:crypto').X509Certificate)(cert).raw);assert.deepEqual(actual.serverCertificate,new (require('node:crypto').X509Certificate)(cert).raw);
  rows.push({name,protocol:actual.protocol,actualMutualAuth:true,contextClaimAfterOriginalGc:true,actualEncryptedPayload:true});
 }
 const absent=create({});assert.equal(component.handshake(absent,cert,priv,ca).completed,0);rows.push({name:'missing client credential fails actual client-auth handshake',pass:true});
 const wrongTrust=candidate.create({ca:key('ca2-cert.pem'),cert,key:priv});assert.equal(component.handshake(wrongTrust,cert,priv,ca).completed,0);rows.push({name:'wrong actual trust fails real peer verification',pass:true});
 const before=component.live();
 for(let i=0;i<20;i++){assert.throws(()=>create({cert,key:key('agent2-key.pem')}));assert.throws(()=>create({pfx:key('agent1.pfx'),passphrase:'wrong'}));}
 for(let i=0;i<8;i++){global.gc();await new Promise(setImmediate)}
 assert(component.live()<=before);rows.push({name:'failed admissions do not retain additional native context owners',before,after:component.live()});
 console.log(JSON.stringify({scope:'actual SSL_CTX refs and real local OpenSSL mutual-auth/record owners; V8 NAPI GC only, not guest TLS transport or SpiderMonkey finalization',passed:rows.length,rows}));
})().catch(error=>{console.error(error);process.exitCode=1});
