'use strict';
// Executes the actual curated method. The native-facing receiver here is an
// explicit argument-consumption fixture, not the SpiderMonkey clone backend.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
assert.equal(process.version,'v26.13.0');
const repo=path.resolve(process.env.CLONE_CONFIG_REPO||path.resolve(__dirname,'../../../..'));
const adapter=process.argv[2]?path.resolve(process.argv[2]):path.join(repo,'packages/registry/spidermonkey/node-compat/adapter.js');
const source=fs.readFileSync(adapter,'utf8');
const start=source.indexOf('        configureClone('),end=source.indexOf('        createCloneModeSymbol()',start);
assert(start>=0&&end>start,'actual curated configureClone method not found');
const actualMethod=Function('native',`'use strict';return ({${source.slice(start,end)}}).configureClone;`);
const rows=[];
function group(name,body){try{rows.push({name,pass:true,result:body()});}catch(error){rows.push({name,pass:false,error:error.stack});}}
group('all six original argument identities, native receiver and nested hook consumption',()=>{
 const nestedInput={},nestedResult={},nativeResult={};let consumed=false;
 const args=[Symbol('private-mode'),function errorFactory(){},function serialize(){},function create(){},function deserialize(){},function nested(value){assert.equal(value,nestedInput);consumed=true;return nestedResult;}];
 const native={configureClone(...received){assert.equal(this,native);assert.equal(received.length,6);for(let i=0;i<6;i++)assert.equal(received[i],args[i]);assert.equal(received[5](nestedInput),nestedResult);return nativeResult;}};
 const method=actualMethod(native);assert.equal(method.apply({publicReceiver:true},args),nativeResult);assert(consumed);return{hookIdentities:5,symbolIdentity:true,nativeReceiver:true,nestedHookConsumed:true};
});
group('extra opaque argument survives with exact result identity',()=>{
 const args=[Symbol(),()=>{},()=>{},()=>{},()=>{},()=>{},Object.freeze({opaque:true})],result={};
 const native={configureClone(...received){assert.equal(this,native);assert.equal(received.length,args.length);for(let i=0;i<args.length;i++)assert.equal(received[i],args[i]);return result;}};
 assert.equal(actualMethod(native)(...args),result);return{arguments:7,opaqueIdentity:true};
});
group('native failure propagates unchanged without replacement or swallowing',()=>{
 const failure=new Error('native configure failure sentinel');failure.code='ERR_FORWARDING_SENTINEL';
 const native={configureClone(){assert.equal(this,native);throw failure;}};
 assert.throws(()=>actualMethod(native)(Symbol(),()=>{},()=>{},()=>{},()=>{},()=>{}),error=>error===failure);return{exactThrownIdentity:true};
});
const pass=rows.filter(x=>x.pass).length,fail=rows.length-pass;
console.log(JSON.stringify({groups:rows.length,pass,fail,rows,adapterSha256:crypto.createHash('sha256').update(source).digest('hex'),guestBackendExecuted:false,scope:'Actual curated configureClone method over explicit native-facing argument-consumption fixture; not native clone or guest conformance'}));
process.exitCode=fail?1:0;
