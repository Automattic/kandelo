"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
assert.equal(process.version,'v26.13.0');const phase=process.argv[2]||'after',repo=process.env.MAC_OWNER_REPO||path.resolve(__dirname,'../../../..'),baseline=process.env.MAC_BASELINE_REPO||repo;
const {internalBinding}=require('internal/test/binding'),binding=internalBinding('crypto');let api,privateGet,calls={names:0,generation:0};
if(phase==='native'){api=crypto;privateGet=require('internal/crypto/util').getMacs;}
else{
 const root=path.join(repo,'third_party/node-core'),spec=JSON.parse(fs.readFileSync(path.join(root,'sources.json'),'utf8')).digests,hash=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
 let adapter=fs.readFileSync(path.join(root,'crypto-digest-adapter.js'),'utf8');
 const names={HASH:'hash',NORMALIZATION:'normalization',FILTER_NAMES:'filterNames',BYTE_VALIDATION:'getArrayBufferOrView',BUFFER_BYTES:'getBufferSourceBytes',RUNTIME_PROVIDER_CACHE:'runtimeProviderCache',GET_MACS:'getMacs'};
 for(const [marker,key]of Object.entries(names)){
  const item=spec.algorithms[key],source=spec.sources[item.source],raw=fs.readFileSync(path.join(root,source.path));assert.equal(hash(raw),source.sha256);
  const text=raw.toString('utf8');assert.equal(text.split(item.start).length,2);const body=text.slice(text.indexOf(item.start),text.indexOf(item.start)+item.length);assert.equal(hash(Buffer.from(body)),item.sha256);const token='/* NODE_DIGEST_'+marker+' */';assert.equal(adapter.split(token).length,2);adapter=adapter.replace(token,body);
 }
 // In-memory focused fixture only: no normal/product generation or output core.
 const core=fs.readFileSync(path.join(baseline,'third_party/node-core/node-core.js'),'utf8');const primordials=Function(core+';return _createNodePrimordials;')();
 const create=Function('_createNodePrimordials',adapter+';return _createNodeCryptoDigest;')(primordials);
 api=create({Buffer,types:require('node:util').types,values:{validators:require('internal/validators'),errors:require('internal/errors'),util:require('internal/util')},native:{digestNames:()=>binding.getHashes(),macNames(){calls.names++;return binding.getMacs();},getFipsCryptoGeneration(){calls.generation++;return binding.getFipsCryptoGeneration();}},captureHelpers(value){privateGet=value.getMacs;}});
}
const rows=[];function group(name,fn){try{rows.push({name,pass:true,value:fn()});}catch(e){rows.push({name,pass:false,error:{name:e.name,code:e.code,message:e.message}});}}
group('actual provider names equal native public inventory',()=>{const result=api.getMacs();assert.deepEqual(result,crypto.getMacs());assert(result.every(x=>typeof x==='string'&&x===x.toLowerCase()&&!(/^\d[\d.]*\.\d/.test(x))));assert.deepEqual(result,[...new Set(result)].sort());return result;});
group('fresh result arrays preserve private cache after mutation',()=>{const first=api.getMacs(),second=api.getMacs();assert.notEqual(first,second);assert.deepEqual(first,second);first.push('__not_a_provider__');first[0]='__mutated__';assert.deepEqual(api.getMacs(),second);return{sameIdentity:false,cacheUnaffected:true};});
group('public method shape and ordinary returned elements',()=>{const f=api.getMacs,desc=Object.getOwnPropertyDescriptor(api,'getMacs'),result=f();assert.equal(f.length,0);const descriptors=Object.keys(result).map(k=>{const x=Object.getOwnPropertyDescriptor(result,k);return[x.enumerable,x.configurable,x.writable];});assert(descriptors.every(x=>x.every(Boolean)));return{length:f.length,name:f.name,property:[desc.enumerable,desc.configurable,desc.writable],array:Array.isArray(result),descriptors};});
group('ignored arguments and receiver never invoke user getters',()=>{let hooks=0;const value=new Proxy({},{get(){hooks++;throw Error('unexpected receiver/argument get');}});const got=Reflect.apply(api.getMacs,value,[value,Symbol('ignored')]);assert.deepEqual(got,crypto.getMacs());assert.equal(hooks,0);return{hooks};});
group('private captured inventory survives public method replacement',()=>{const saved=api.getMacs,expected=saved();try{api.getMacs=()=>{throw Error('public replacement');};assert.deepEqual(privateGet(),expected);}finally{api.getMacs=saved;}return{privateSurvives:true};});
group('cached slice retains actual Array species getter chronology',()=>{api.getMacs();const descriptor=Object.getOwnPropertyDescriptor(Array,Symbol.species);let hooks=0,result;try{Object.defineProperty(Array,Symbol.species,{configurable:true,get(){hooks++;return Array;}});result=api.getMacs();}finally{Object.defineProperty(Array,Symbol.species,descriptor);}assert.deepEqual(result,crypto.getMacs());return{speciesGetterCalls:hooks};});
if(phase!=='native'){assert.equal(calls.names,1);assert(calls.generation>1);}
console.log(JSON.stringify({phase,pass:rows.filter(x=>x.pass).length,fail:rows.filter(x=>!x.pass).length,rows,componentOnly:{nativeProviderBackend:true,candidateCppExecuted:false,normalProductGeneration:false,providerTransitionExecuted:false,snapshotSerializationExecuted:false},fixtureCounters:phase==='native'?undefined:calls}));if(rows.some(x=>!x.pass))process.exitCode=1;
