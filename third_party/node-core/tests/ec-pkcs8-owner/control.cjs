const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
const path=require('node:path'),hash=require('node:crypto').createHash;
const root=fs.realpathSync(process.env.KANDELO_EC_PKCS8_OUTPUT);const observations=path.join(root,'observations');
assert.equal(fs.realpathSync(path.dirname(observations)),root);if(!fs.existsSync(observations))fs.mkdirSync(observations);assert.ok(fs.realpathSync(observations).startsWith(root+path.sep));
function save(name,value){const file=path.join(observations,name.replace(/[^a-zA-Z0-9_-]/g,'_')+'.json');assert.equal(fs.realpathSync(path.dirname(file)),observations);if(fs.existsSync(file))assert.equal(fs.lstatSync(file).isSymbolicLink(),false);fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
const {internalBinding}=require('internal/test/binding');const binding=internalBinding('crypto');
const api=require('./platform.cjs'),component=require(process.env.KANDELO_EC_PKCS8_COMPONENT);
const from=Buffer.from.bind(Buffer),concat=Buffer.concat.bind(Buffer);
const result={groups:[],scope:'Actual shared helper/native private wrapper controls; native parsing/V8/DER-copy/GC dependencies, not guestJSAPI/Subtle/role-guard proof.'};
function group(name,fn){try{result.groups.push({name,status:'pass',value:fn()});}catch(e){result.groups.push({name,status:'fail',error:{name:e.name,code:e.code,message:e.message,stack:e.stack}});}}
function len(n){if(n<128)return from([n]);const a=[];while(n){a.unshift(n&255);n=Math.floor(n/256);}return from([128|a.length,...a]);}
function tlv(bytes,offset){const tag=bytes[offset++];let size=bytes[offset++];if(size&128){let count=size&127;size=0;while(count--)size=size*256+bytes[offset++];}return{tag,start:offset,end:offset+size};}
function children(bytes){const outer=tlv(bytes,0);assert.equal(outer.tag,48);const out=[];for(let i=outer.start;i<outer.end;){const next=tlv(bytes,i);out.push({start:i,...next});i=next.end;}return out;}
function noPoint(bytes){const outer=tlv(bytes,0),parts=[];let removed=0;for(let i=outer.start;i<outer.end;){const item=tlv(bytes,i);if(item.tag===161)removed++;else parts.push(bytes.subarray(i,item.end));i=item.end;}assert.equal(removed,1);const data=concat(parts);return concat([from([48]),len(data.length),data]);}
function pointPresent(der){const parts=children(der),privateOctet=parts.find(x=>x.tag===4);assert.ok(privateOctet);const ec=der.subarray(privateOctet.start,privateOctet.end);return children(ec).some(x=>x.tag===161);}
function key(bytes,type='sec1'){return crypto.createPrivateKey({key:bytes,format:'der',type});}
function nativeExport(object){return binding.getKeyObjectSlots(object)[1].exportECPrivatePkcs8();}
function publicDer(object){return crypto.createPublicKey(object).export({format:'der',type:'spki'});}
for(const [curve,paramEncoding]of [['prime256v1','named'],['secp384r1','named'],['secp521r1','named'],['secp256k1','named'],['prime256v1','explicit']]){
 const original=crypto.generateKeyPairSync('ec',{namedCurve:curve,paramEncoding}).privateKey.export({format:'der',type:'sec1'});
 for(const omitted of [false,true])group(curve+'/'+paramEncoding+'/'+(omitted?'omitted-point':'point'),()=>{
  const input=omitted?noPoint(original):original;
  const nativeKey=key(input),beforePrivate=nativeKey.export({format:'der',type:'sec1'}),beforePublic=publicDer(nativeKey);
  const expected=nativeExport(nativeKey),afterPrivate=nativeKey.export({format:'der',type:'sec1'}),afterPublic=publicDer(nativeKey);
  const actual=component.exportPkcs8(input,undefined,binding.kKeyEncodingSEC1,true);
  const referenceResultPublic=publicDer(key(expected,'pkcs8')),candidateResultPublic=publicDer(key(actual.value,'pkcs8'));
  // Save actual reference/candidate byte transformations BEFORE assertions.
  const data={input,reference:{beforePrivate,afterPrivate,beforePublic,afterPublic,output:expected,resultPublic:referenceResultPublic},candidate:actual,candidateResultPublic};
  save(curve+'_'+paramEncoding+'_'+omitted,data);
  assert.equal(Buffer.compare(actual.value,expected),0);assert.equal(pointPresent(actual.value),true);
  for(const [name,wanted]of Object.entries({beforePrivate,afterPrivate,beforePublic,afterPublic}))assert.equal(Buffer.compare(actual[name],wanted),0,name);
  assert.equal(Buffer.compare(candidateResultPublic,referenceResultPublic),0);
  assert.equal(crypto.createPublicKey(key(actual.value,'pkcs8')).equals(crypto.createPublicKey(nativeKey)),true);
  const wrapped=api.createPrivateKey({key:input,format:'der',type:'sec1'});
  const exposed=api.privateKeys.getKeyObjectHandle(wrapped).exportECPrivatePkcs8();
  assert.equal(api.Buffer.isBuffer(exposed),true);assert.equal(Buffer.compare(exposed,expected),0);
  return{curve,paramEncoding,omitted,point:true,matching:true,sourcePrivateStable:beforePrivate.equals(afterPrivate),sourcePublicStable:beforePublic.equals(afterPublic),referenceResultRepresentationStable:beforePublic.equals(referenceResultPublic),candidateResultRepresentationStable:actual.beforePublic.equals(candidateResultPublic),semanticKeyEqual:true};
 });
}
for(const type of ['rsa','ed25519','x25519'])group('wrong-type/'+type,()=>{
 const pair=crypto.generateKeyPairSync(type,type==='rsa'?{modulusLength:512}:undefined);
 const input=pair.privateKey.export({format:'der',type:'pkcs8'});let a,b;
 try{nativeExport(pair.privateKey);}catch(e){a={name:e.name,code:e.code,message:e.message};}
 try{component.exportPkcs8(input,undefined,binding.kKeyEncodingPKCS8);}catch(e){b={name:e.name,code:e.code,message:e.message};}
 assert.deepEqual(b,a);assert.equal(b.code,'ERR_CRYPTO_OPERATION_FAILED');assert.equal(b.message,'Failed to export EC private key');
 const wrapped=api.createPrivateKey({key:input,format:'der',type:'pkcs8'});assert.throws(()=>api.privateKeys.getKeyObjectHandle(wrapped).exportECPrivatePkcs8(),b);return a;
});
group('BIO/material ownership across GC/input mutation',()=>{
 const input=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'der',type:'sec1'});const expected=nativeExport(key(input));let called=0;
 const output=component.exportPkcs8(input,()=>{called++;input.fill(0);if(global.gc){global.gc();global.gc();}},binding.kKeyEncodingSEC1);
 assert.equal(called,1);assert.equal(Buffer.compare(output,expected),0);return{callback:called,independent:true};
});
group('no public Buffer.from publication hook',()=>{
 const privateKey=api.createPrivateKey(crypto.generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'pem',type:'pkcs8'}));
 const handle=api.privateKeys.getKeyObjectHandle(privateKey);let called=0;const old=Buffer.from,oldCandidate=api.Buffer.from;
 try{Buffer.from=api.Buffer.from=()=>{called++;throw Error('public Buffer hook');};const output=handle.exportECPrivatePkcs8();assert.ok(output.length>0);}finally{Buffer.from=old;api.Buffer.from=oldCandidate;}
 assert.equal(called,0);return{called};
});
result.passed=result.groups.filter(x=>x.status==='pass').length;result.failed=result.groups.length-result.passed;console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;
