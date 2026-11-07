'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),util=require('node:util'),stream=require('node:stream');
const root=path.resolve(__dirname,'../../../..');
const source=fs.readFileSync(path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const forwardingSource=fs.readFileSync(path.join(root,'packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
const forwarding=forwardingSource.match(/    tlsContext\(([^)]*)\) \{ return native\.__kandeloTlsContextOperation\(([^)]*)\); \},/);
if(!forwarding)throw Error('Missing actual curated TLS native forwarding');
const factories=Function(bundle+';return {trust:_createNodeTlsContextTrust,modules:_createNodePublicConstantModules};')();
exports.create=function create(){
 const addon=require(process.env.TLS_POLICY_ADDON),binding=require('internal/test/binding').internalBinding('constants');
 const nativeCrypto=require('node:crypto');
 // Native crypto is an explicit existing API dependency. Its configurable
 // public-load side effect is removed to expose the real pre-public-init bag;
 // no numeric/string constant value or fake crypto method is manufactured.
 delete binding.crypto.defaultCipherList;
 const nativeOptions=require('internal/options');
 const cliOptions={tlsCipherList:nativeOptions.getOptionValue('--tls-cipher-list')};
 const contexts=[],trace=[],fault={intentionalBeforeTCP:true};let trust,publicOwner,tls,registry,proc;
 function operation(name,...args){trace.push(name);const result=addon.operation(name,...args);if(name==='create')contexts.push(result);return result;}
 const native=Function('native','return {'+forwarding[0]+'};')({__kandeloTlsContextOperation:operation});
 const fixture=require(path.join(root,'host/test/fixtures/node-module-records.cjs'));
 const api=fixture.create({skipESMResolver:true,configureBuiltins(builtins,boundary,values){
  registry=builtins;proc=boundary;proc.moduleLoadList=[];
  trust=factories.trust({native,values,types:util.types,Buffer,constants:binding,require:name=>builtins[name]});
  const a=source.indexOf('const tls = (() => {'),b=source.indexOf('// Trust still comes',a);
  if(a<0||b<a)throw Error('Missing actual TLS owner source');
  tls=Function('stream','Buffer','_nodeNative','_nodeTlsContextTrust','_nodeBeginSocketConnection','_nodePublicConstants',
   source.slice(a,b)+';return tls;')(stream,Buffer,native,trust,()=>{trace.push('TCP-fault-boundary');throw fault;},{load:id=>publicOwner.load(id)});
  publicOwner=factories.modules({process:proc,values,binding,crypto:nativeCrypto,tls,cliOptions,
   require:name=>builtins[name],compileSource:(text,filename)=>vm.runInThisContext(text,{filename})});
  const getters=['tls','https','crypto','constants'].map(id=>{
   const match=source.match(new RegExp('    get '+id+'\\(\\) \\{[^}]+\\},'));if(!match)throw Error('Missing actual '+id+' getter');return match[0];
  }).join('');
  // HTTPS is a real native existing API dependency here; only exact getter
  // identity/dependency initialization is tested. No HTTPS transport is claimed.
  const properties=Function('_nodePublicConstants','https','return Object.getOwnPropertyDescriptors({'+getters+'})')(publicOwner,require('node:https'));
  Object.defineProperties(builtins,properties);
 }});
 return {req:api.Module.createRequire(path.join(root,'tls-policy-main.cjs')),Module:api.Module,proc,tls,trust,contexts,trace,fault,addon,binding,
  close(){for(const context of contexts){try{addon.operation('close',context);}catch{}}}};
};
