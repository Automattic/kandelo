'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
assert.equal(process.version,'v26.13.0');
const candidate=require('./platform.cjs').create();
const fixture=n=>fs.readFileSync(path.join(process.env.NODE26_SOURCE,'test/fixtures/keys',n));
const privateKey=fixture('rsa_private.pem'),publicKey=fixture('rsa_public.pem'),message=Buffer.from('real RSA bytes');
const privateObject=crypto.createPrivateKey(privateKey),publicObject=crypto.createPublicKey(publicKey);
function bytesEqual(actual,expected){assert.deepEqual(Buffer.from(actual),Buffer.from(expected))}
const rows=[];function pass(name){rows.push({name,pass:true})}
function project(error){return Object.fromEntries(['name','message','code','library','function','reason','opensslErrorStack'].filter(k=>error[k]!==undefined).map(k=>[k,error[k]]))}
function failure(fn){try{fn();return undefined}catch(error){return project(error)}}
function compareFailure(name,method,options,input){assert.deepEqual(failure(()=>candidate[method](options,input)),failure(()=>crypto[method](options,input)),name);pass(name)}
for(const [name,options]of [['defaults',{}],['sha256',{oaepHash:'sha256'}],['MGF1',{oaepHash:'sha256',mgf1Hash:'sha1'}],['label',{oaepHash:'sha256',oaepLabel:Buffer.from('label\0bytes')}],['PKCS1',{padding:crypto.constants.RSA_PKCS1_PADDING}]]){
 const enc={...options,key:publicKey},dec={...options,key:privateKey};
 bytesEqual(crypto.privateDecrypt(dec,candidate.publicEncrypt(enc,message)),message);pass(name+' candidate encrypt/native decrypt');
 bytesEqual(candidate.privateDecrypt(dec,crypto.publicEncrypt(enc,message)),message);pass(name+' native encrypt/candidate decrypt');
}
for(const [name,priv,pub]of [['PEM',privateKey,publicKey],['KeyObject',privateObject,publicObject],['DER',{key:privateObject.export({format:'der',type:'pkcs8'}),format:'der',type:'pkcs8'},{key:publicObject.export({format:'der',type:'spki'}),format:'der',type:'spki'}],['JWK',{key:privateObject.export({format:'jwk'}),format:'jwk'},{key:publicObject.export({format:'jwk'}),format:'jwk'}]]){
 const signed=candidate.privateEncrypt(priv,message);bytesEqual(signed,crypto.privateEncrypt(priv,message));pass(name+' actual raw-RSA private encrypt');
 bytesEqual(candidate.publicDecrypt(pub,signed),message);pass(name+' candidate public decrypt');
 bytesEqual(crypto.privateDecrypt(priv,candidate.publicEncrypt(pub,message)),message);pass(name+' candidate public/native private');
}
const password='päss\0word',encrypted=privateObject.export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:password});
bytesEqual(candidate.privateDecrypt({key:encrypted,passphrase:password},crypto.publicEncrypt(publicKey,message)),message);pass('encrypted private material with actual password bytes');
for(const method of ['publicEncrypt','privateDecrypt','privateEncrypt','publicDecrypt']){
 const key=method.startsWith('private')?privateKey:publicKey;
 for(const [name,extra,data]of [['bad digest',{oaepHash:'no-such-digest'},message],['bad MGF1',{mgf1Hash:'no-such-digest'},message],['digest validation',{oaepHash:1},message],['MGF1 validation',{mgf1Hash:{}},message],['label validation',{oaepLabel:{}},message],['padding invalid',{padding:-1},message],['bad data',{},{}],['oversized data',{},Buffer.alloc(5000)],['malformed key',{key:Buffer.from('invalid')},message]])compareFailure(method+':'+name,method,{key,...extra},data);
}
for(const [name,view]of [['offset',Buffer.concat([Buffer.from('xx'),message,Buffer.from('yy')]).subarray(2,2+message.length)],['DataView',new DataView(Uint8Array.from(message).buffer)],['shared',new Uint8Array(new SharedArrayBuffer(message.length))]]){
 if(name==='shared')view.set(message);
 bytesEqual(crypto.privateDecrypt(privateKey,candidate.publicEncrypt(publicKey,view)),message);pass('actual byte input '+name);
}
// A genuine conversion callback mutates the original input after native span
// capture. Encryption must observe that mutation, not an early payload copy.
for(const subject of [crypto,candidate]){
 const bytes=Buffer.alloc(message.length,1);const padding={valueOf(){global.gc();bytes.set(message);return crypto.constants.RSA_PKCS1_OAEP_PADDING}};
 bytesEqual(crypto.privateDecrypt(privateKey,subject.publicEncrypt({key:publicKey,padding},bytes)),message);
}pass('native and candidate reentrant padding conversion sees original bytes');
for(const subject of [crypto,candidate]){
 const marker={original:true};let actual;try{subject.publicEncrypt({key:publicKey,padding:{valueOf(){throw marker}}},message)}catch(error){actual=error}assert.equal(actual,marker);
}pass('padding conversion preserves original exception');
const ciphertext=crypto.publicEncrypt({key:publicKey,oaepHash:'sha256',mgf1Hash:'sha1'},message);
compareFailure('actual MGF1 mismatch error','privateDecrypt',{key:privateKey,oaepHash:'sha256'},ciphertext);
compareFailure('wrong private material','privateDecrypt',{key:fixture('rsa_private_b.pem')},crypto.publicEncrypt(publicKey,message));
compareFailure('public key object rejected for private operation','privateDecrypt',publicObject,ciphertext);
// The actual implicit-rejection admission precedes digest selection.
compareFailure('implicit-rejection context error precedes invalid digest','privateDecrypt',
 {key:fixture('ec-key.pem'),padding:crypto.constants.RSA_PKCS1_PADDING,oaepHash:'invalid'},message);
for(const behavior of ['readonly-code','throw-code']){
 const marker={setter:true};let traces=[];
 for(const subject of [crypto,candidate]){
  let count=0,actual;Object.defineProperty(Error.prototype,'code',behavior==='readonly-code'?{configurable:true,writable:false,value:'inherited'}:{configurable:true,set(){count++;throw marker}});
  try{subject.privateDecrypt(privateKey,Buffer.alloc(128))}catch(error){actual=error}finally{delete Error.prototype.code}
  traces.push({count,marker:actual===marker,error:actual===marker?undefined:project(actual)});
 }
 assert.deepEqual(traces[1],traces[0]);pass('RSA actual failure '+behavior);
}
const ownedOutput=candidate.privateEncrypt(privateKey,message);
assert(candidate.Buffer.isBuffer(ownedOutput));assert.equal(Object.getPrototypeOf(ownedOutput),candidate.Buffer.prototype);
pass('RSA output consumes actual candidate private Buffer owner');
console.log(JSON.stringify({scope:'exact pinned RSA wrappers over actual portable ncrypto/OpenSSL owner; native key/stream/private codec and DER projection are explicit component dependencies, no guest JSAPI/GC/four-host claim',passed:rows.length,rows}));
