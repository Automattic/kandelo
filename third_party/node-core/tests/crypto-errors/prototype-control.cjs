'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),tls=require('node:tls'),vm=require('node:vm');
assert.equal(process.version,'v26.13.0');
const root=process.env.CRYPTO_ERRORS_REPO,privateRoot=root;
const component=require(process.env.TLS_CREDENTIALS_COMPONENT),util=require('node:util');
const factories=Function(fs.readFileSync(path.join(privateRoot,'third_party/node-core/node-core.js'),'utf8')+'\nreturn{values:_createNodeValuesPlatform,create:_createNodeTlsContextTrust};')();
const values=factories.values({process,Buffer,util,inspection:util,os:{},signals:require('node:os').constants.signals});
const adapter=fs.readFileSync(path.join(privateRoot,'packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
const forwarder=adapter.match(/        tlsContext\(\.\.\.args\) \{ return native\.__kandeloTlsContextOperation\(\.\.\.args\); \},/)[0];
const routed=Function('native','return ({'+forwarder+'}).tlsContext')({__kandeloTlsContextOperation:component.operation});
const candidate=factories.create({native:{tlsContext:routed},values,types:util.types,Buffer});
const key=n=>fs.readFileSync(path.join(process.env.NODE26_SOURCE,'test/fixtures/keys',n));
const cert=key('agent1-cert.pem'),priv=key('agent1-key.pem'),ca=key('ca1-cert.pem');
const encrypted=crypto.createPrivateKey(priv).export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:'secret'});
const cases=[['PEM',{cert:Buffer.from('invalid')}],['mismatch',{cert,key:key('agent2-key.pem'),ca}],['encrypted',{cert,key:encrypted,passphrase:'wrong',ca}],['PFXplain',{pfx:key('agent1.pfx'),passphrase:'wrong'}],['coded',{pfx:key('agent1.pfx'),passphrase:1}]];
const fields=['opensslErrorStack','library','function','reason','code'];
function capture(mode,options,behavior){
 const descriptors=Object.fromEntries(fields.map(n=>[n,Object.getOwnPropertyDescriptor(Error.prototype,n)]));
 let trace='',receiver,thrown,arrayWrites=0;const marker={originalThrownValue:true};
 const arrayDescriptor=Object.getOwnPropertyDescriptor(Array.prototype,'0');
 const add=(field,value)=>{trace+=JSON.stringify([field,Array.isArray(value)?[...value]:value])+'\n'};
 try{
  if(behavior==='array-prototype')Object.defineProperty(Array.prototype,'0',{configurable:true,set(){arrayWrites++},get(){return undefined}});
  for(const field of fields){
   if(behavior==='readonly')Object.defineProperty(Error.prototype,field,{configurable:true,writable:false,value:'inherited:'+field});
   else if(behavior==='own-readonly'&&field==='code')Object.defineProperty(Error.prototype,field,{configurable:true,set(value){add(field,value);Object.defineProperty(this,field,{value,writable:false,enumerable:true,configurable:true})}});
   else Object.defineProperty(Error.prototype,field,{configurable:true,set(value){receiver=this;add(field,value);if(behavior==='gc')global.gc();if(behavior==='throw-'+field)throw marker;if(behavior==='freeze'&&field==='opensslErrorStack')Object.preventExtensions(this)}});
  }
  try{mode==='native'?tls.createSecureContext(options):candidate.create(options)}catch(error){thrown=error}
 }finally{
  for(const field of fields){if(descriptors[field])Object.defineProperty(Error.prototype,field,descriptors[field]);else delete Error.prototype[field]}
  if(arrayDescriptor)Object.defineProperty(Array.prototype,'0',arrayDescriptor);else delete Array.prototype[0];
 }
 const selected={};if(thrown&&thrown!==marker)for(const field of fields){const d=Object.getOwnPropertyDescriptor(thrown,field);if(d)selected[field]={value:d.value,writable:d.writable,enumerable:d.enumerable,configurable:d.configurable};}
 return{trace,arrayWrites,marker:thrown===marker,sameReceiver:receiver===thrown,error:thrown&&thrown!==marker?{nativeError:util.types.isNativeError(thrown),name:thrown.name,message:thrown.message,selected}:undefined};
}
const rows=[];
for(const [name,options]of cases){
 for(const behavior of ['observe','readonly','own-readonly','freeze','gc','array-prototype',...fields.map(n=>'throw-'+n)]){
  // Native coded macros intentionally abort if their code setter throws; that
  // exact checked policy is exercised separately in isolated subprocesses.
  if(name==='coded'&&behavior==='throw-code')continue;
  const expected=capture('native',options,behavior),actual=capture('candidate',options,behavior);
  assert.deepEqual(actual,expected,name+':'+behavior);rows.push({name,behavior,pass:true});
 }
}
const foreign=vm.runInNewContext('(options,create)=>{try{create(options)}catch(error){return error}}');
for(const create of [tls.createSecureContext,o=>candidate.create(o)]){const error=foreign({cert:Buffer.from('invalid')},create);assert(util.types.isNativeError(error));assert.equal(Object.getPrototypeOf(error),Error.prototype)}
rows.push({name:'foreign caller retains native function owning error realm',pass:true});
console.log(JSON.stringify({scope:'actual native Node public TLS versus actual shared captured-error owner and unchanged production forwarder; stock/prototype/GC controls on native host only',passed:rows.length,rows}));
