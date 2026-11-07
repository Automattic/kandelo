'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
assert.equal(process.version,'v26.13.0');
const component=require(process.env.PKCS12_COMPONENT),candidate=require('./key-platform.cjs').create({component});
const fixtures=path.join(process.env.NODE26_SOURCE,'test/fixtures/keys');
const key=name=>fs.readFileSync(path.join(fixtures,name));
const rows=[];
function summary(value){return{privateKey:value.privateKey===null?null:{type:value.privateKey.type,algorithm:value.privateKey.asymmetricKeyType,pem:value.privateKey.export({format:'pem',type:'pkcs8'}).toString()},certificate:value.certificate===null?null:{raw:value.certificate.raw.toString('hex'),subject:value.certificate.subject,keyMatches:value.certificate.checkPrivateKey(value.privateKey)},additionalCertificates:value.additionalCertificates.map(cert=>({raw:cert.raw.toString('hex'),subject:cert.subject,realX509:require('internal/crypto/x509').isX509Certificate(cert)}))};}
function error(fn){try{return{value:fn()};}catch(e){return{error:{name:e.name,code:e.code,message:e.message,library:e.library,reason:e.reason,opensslErrorStack:e.opensslErrorStack}};}}
for(const [name,passphrase] of [['rsa_cert.pfx','sample'],['agent1.pfx','sample'],['ec.pfx',''],['ec.pfx',undefined],['cert-without-key.pfx','test']]){
 const bundle=key(name);const expected=summary(crypto.parsePKCS12(bundle,{passphrase}));
 for(const [kind,input]of [['buffer',bundle],['offset',Buffer.concat([Buffer.from('xx'),bundle,Buffer.from('zz')]).subarray(2,bundle.length+2)],['arraybuffer',bundle.buffer.slice(bundle.byteOffset,bundle.byteOffset+bundle.length)],['dataview',new DataView(bundle.buffer,bundle.byteOffset,bundle.length)],['foreign',vm.runInNewContext('new Uint8Array(input)',{input:[...bundle]})]]){
  const actual=summary(candidate.parsePKCS12(input,{passphrase}));assert.deepEqual(actual,expected);rows.push({name:name+':'+kind+':'+String(passphrase),pass:true});
 }
}
for(const [name,passphrase]of [['rsa_cert.pfx','bad'],['legacy.pfx','legacy'],['ec.pfx','sample']]){
 const bundle=key(name);assert.deepEqual(error(()=>candidate.parsePKCS12(bundle,{passphrase})),error(()=>crypto.parsePKCS12(bundle,{passphrase})));rows.push({name:'error:'+name+':'+passphrase,pass:true});
}
for(const input of [Buffer.from('not a bundle'),Buffer.alloc(0),new Uint8Array(3)]){assert.deepEqual(error(()=>candidate.parsePKCS12(input)),error(()=>crypto.parsePKCS12(input)));rows.push({name:'malformed:'+input.byteLength,pass:true});}
for(const passphrase of ['sample\0junk',Buffer.from('sample\0junk'),new Uint8Array([0]),new DataView(Uint8Array.from([0]).buffer)]){assert.deepEqual(error(()=>candidate.parsePKCS12(key('rsa_cert.pfx'),{passphrase})),error(()=>crypto.parsePKCS12(key('rsa_cert.pfx'),{passphrase})));rows.push({name:'nul-password:'+typeof passphrase,pass:true});}
for(const [bundle,options]of [['invalid',undefined],[Buffer.alloc(0),'bad'],[null,{}],[Buffer.alloc(0),{passphrase:1}],[Buffer.alloc(0),null]]){assert.deepEqual(error(()=>candidate.parsePKCS12(bundle,options)),error(()=>crypto.parsePKCS12(bundle,options)));rows.push({name:'validation:'+typeof bundle+':'+typeof options,pass:true});}
const parsed=candidate.parsePKCS12(key('rsa_cert.pfx'),{passphrase:'sample'});assert(parsed.certificate instanceof candidate.X509Certificate);assert.equal(parsed.privateKey.type,'private');assert(parsed.certificate.checkPrivateKey(parsed.privateKey));const input=key('rsa_cert.pfx'),owned=candidate.parsePKCS12(input,{passphrase:'sample'});input.fill(0);assert.deepEqual(summary(owned),summary(parsed));rows.push({name:'actual-key-certificate-and-independent-parsed-storage',pass:true});
for(const [mode,password] of [[0,'test'],[1,'test'],[1,'päss世界']]){
 const bundle=component.variant(mode,key('rsa_cert.pfx'),'sample',password);
 fs.writeFileSync(path.join(path.dirname(process.env.PKCS12_CONTROL_REPORT),'variant-'+mode+'-'+Buffer.from(password).toString('hex')+'.pfx'),bundle);
 const actual=candidate.parsePKCS12(bundle,{passphrase:password}),expected=crypto.parsePKCS12(bundle,{passphrase:password});assert.deepEqual(summary(actual),summary(expected));
 assert.equal(actual.certificate,null);assert.equal(actual.additionalCertificates.length,0);assert.equal(actual.privateKey===null,mode===0);
 rows.push({name:'actual-generated-'+(mode?'key-only':'empty')+':'+password,pass:true});
 assert.deepEqual(error(()=>candidate.parsePKCS12(bundle,{passphrase:'bad'})),error(()=>crypto.parsePKCS12(bundle,{passphrase:'bad'})));rows.push({name:'actual-generated-wrong-password:'+mode+':'+password,pass:true});
}
const report={scope:'Pinned public crypto key algorithms + production native PKCS12 parser with real OpenSSL/ncrypto, then declared PEM/DER transport into genuine native Node key/X509 owners; no candidate SM identity/GC or TLS claim',native:process.version,openssl:process.versions.openssl,pass:rows.length,rows};fs.writeFileSync(process.env.PKCS12_CONTROL_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:rows.length,scope:report.scope}));
