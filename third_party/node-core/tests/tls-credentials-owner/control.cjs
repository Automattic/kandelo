'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),tls=require('node:tls'),vm=require('node:vm');
assert.equal(process.version,'v26.13.0');
const root=process.env.TLS_CREDENTIALS_TEST_REPO || path.resolve(__dirname,'../../../..'),privateRoot=root;
const component=require(process.env.TLS_CREDENTIALS_COMPONENT);
const factories=Function(fs.readFileSync(path.join(privateRoot,'third_party/node-core/node-core.js'),'utf8')+'\nreturn{values:_createNodeValuesPlatform,create:_createNodeTlsContextTrust};')();
const util=require('node:util'),values=factories.values({process,Buffer,util,inspection:util,os:{},signals:require('node:os').constants.signals});
const adapter=fs.readFileSync(path.join(privateRoot,'packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
const forwarder=adapter.match(/        tlsContext\(\.\.\.args\) \{ return native\.__kandeloTlsContextOperation\(\.\.\.args\); \},/)[0];
const actualForwarder=Function('native','return ({'+forwarder+'}).tlsContext')({__kandeloTlsContextOperation:component.operation});
const candidate=factories.create({native:{tlsContext:actualForwarder},values,types:util.types,Buffer});
const key=name=>fs.readFileSync(path.join(process.env.NODE26_SOURCE,'test/fixtures/keys',name));
const der=value=>value==null?null:Buffer.from(value).toString('hex');
const failure=fn=>{try{return{value:fn()}}catch(e){return{error:{name:e.name,message:e.message,code:e.code,library:e.library,reason:e.reason,opensslErrorStack:e.opensslErrorStack}}}};
function expected(options){const owner=tls.createSecureContext(options).context;return{certificate:der(owner.getCertificate()),issuer:der(owner.getIssuer())}}
function actual(options){const owner=candidate.create(options),info=component.snapshot(owner);return{certificate:der(info.certificate),issuer:der(info.issuer)}}
const rows=[];const test=(name,options)=>{assert.deepEqual(failure(()=>actual(options)),failure(()=>expected(options)),name);rows.push({name,pass:true})};
const cert=key('agent1-cert.pem'),privateKey=key('agent1-key.pem'),ca=key('ca1-cert.pem');
for(const [label,input] of [['buffer',cert],['string',cert.toString()],['offset',Buffer.concat([Buffer.from('xx'),cert,Buffer.from('yy')]).subarray(2,cert.length+2)],['dataview',new DataView(cert.buffer,cert.byteOffset,cert.length)],['uint16',new Uint16Array(Uint8Array.from(cert.length%2?[...cert,10]:cert).buffer)],['foreign',vm.runInNewContext('new Uint8Array(bytes)',{bytes:[...cert]})]])test('cert-'+label,{cert:input,key:privateKey,ca});
for(const [label,input] of [['buffer',privateKey],['string',privateKey.toString()],['dataview',new DataView(privateKey.buffer,privateKey.byteOffset,privateKey.length)]])test('key-'+label,{cert,key:input,ca});
test('cert-float16-view',{cert:new Float16Array(Uint8Array.from(cert.length%2?[...cert,10]:cert).buffer),key:privateKey,ca});
test('CA-array-and-chain-issuer',{cert,key:privateKey,ca:[ca,ca]});
test('certificate-PEM-chain',{cert:Buffer.concat([cert,ca]),key:privateKey,ca:[]});
test('certificate-array',{cert:[ca,cert],key:privateKey,ca});
test('key-array-with-pem-wrapper',{cert,key:[{pem:privateKey,passphrase:''}],ca});
test('falsy-options-permitted',{cert:'',key:0,ca:false});
for(const [name,value] of [['arraybuffer',cert.buffer.slice(cert.byteOffset,cert.byteOffset+cert.length)],['plain',{}],['null-element',null],['number',1]])test('cert-validation-'+name,{cert:[value]});
for(const [name,keyValue,passphrase] of [['object',{},undefined],['password-number',privateKey,1],['password-null',privateKey,null],['password-empty',privateKey,'']])test('key-'+name,{cert,key:keyValue,passphrase});
for(const [name,value] of [['invalid',Buffer.from('invalid')],['empty',Buffer.alloc(0)],['mismatched',key('agent2-key.pem')]])test('key-parse-'+name,{cert,key:value});
for(const value of [Buffer.from('invalid'),Buffer.alloc(0),Buffer.concat([cert,Buffer.from('-----BEGIN CERTIFICATE-----\nnot-valid\n-----END CERTIFICATE-----\n')])])test('certificate-parse-'+value.length,{cert:value});
for(const [name,password] of [['rsa_cert.pfx','sample'],['agent1.pfx','sample'],['ec.pfx',''],['ec.pfx',undefined],['cert-without-key.pfx','test'],['legacy.pfx','legacy']]){
 test('pfx-'+name+'-'+String(password),{pfx:key(name),passphrase:password});
 if(name==='rsa_cert.pfx'){
  test('pfx-array-override',{pfx:[{buf:key(name),passphrase:password}],passphrase:'wrong'});
  const bytes=key(name);test('pfx-offset-view',{pfx:new DataView(bytes.buffer,bytes.byteOffset,bytes.length),passphrase:password});
  test('pfx-embedded-NUL-password',{pfx:key(name),passphrase:password+'\0ignored'});
  test('pfx-wrong-password',{pfx:key(name),passphrase:'bad'});
 }
}
for(const [name,value,password] of [['invalid',Buffer.from('invalid'),undefined],['empty',Buffer.alloc(0),undefined],['bare-arraybuffer',new ArrayBuffer(8),1],['password-number',key('rsa_cert.pfx'),1],['password-object',key('rsa_cert.pfx'),{}]])test('pfx-errors-'+name,{pfx:value,passphrase:password});
for(const [name,password] of [['empty',''],['utf8','päss世界'],['NUL','sample\0tail']]){
 const keyObject=crypto.createPrivateKey(privateKey);const pem=keyObject.export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:password});
 test('encrypted-pem-'+name,{cert,key:pem,passphrase:password});
 test('encrypted-pem-wrong-'+name,{cert,key:pem,passphrase:'wrong'});
 test('encrypted-pem-missing-'+name,{cert,key:pem});
}
for(const option of ['cert','key','pfx']){const detached=new Uint8Array([1,2,3]);structuredClone(detached.buffer,{transfer:[detached.buffer]});test('detached-'+option,{[option]:detached});}
const ownedCert=Buffer.from(cert),ownedKey=Buffer.from(privateKey),ownedCA=Buffer.from(ca),owner=candidate.create({cert:ownedCert,key:ownedKey,ca:ownedCA});const original=component.snapshot(owner);ownedCert.fill(0);ownedKey.fill(0);ownedCA.fill(0);assert.deepEqual(component.snapshot(owner),original);rows.push({name:'real-parsed-independent-material',pass:true});
console.log(JSON.stringify({scope:'exact pinned public credential selections + actual SSL_CTX/ncrypto/OpenSSL portable owner on native host; not guest JSAPI/four-host execution',native:process.version,openssl:process.versions.openssl,passed:rows.length,rows}));
