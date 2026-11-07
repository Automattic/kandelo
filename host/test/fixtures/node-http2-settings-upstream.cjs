'use strict';
// Execute the complete unchanged upstream settings test with only the module
// and Buffer owners selected by this explicit component boundary. Assertions
// always delegate to the actual native assert implementation.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto'),nativeAssert=require('node:assert/strict');
nativeAssert.equal(process.version,'v26.13.0');
const mode=process.argv[2],pinnedRoot=path.resolve(process.argv[3]);nativeAssert(['native','candidate'].includes(mode));
const subject=mode==='native'?{api:require('node:http2'),Buffer}:require('./node-http2-settings-platform.cjs').create();
const file=path.join(pinnedRoot,'test/parallel/test-http2-getpackedsettings.js'),raw=fs.readFileSync(file,'utf8');
const common=require(path.join(pinnedRoot,'test/common'));nativeAssert.equal(common.hasCrypto,true);
const counts={call:0};const counted=new Proxy(require('node:assert'),{apply(target,thisArg,args){counts.call++;return Reflect.apply(target,thisArg,args)},get(target,key){const value=Reflect.get(target,key);if(!['strictEqual','deepStrictEqual','throws'].includes(key))return value;return function(...args){counts[key]=(counts[key]||0)+1;return Reflect.apply(value,target,args)}}});
const owner=new Module(file,module);owner.filename=file;owner.paths=Module._nodeModulePaths(path.dirname(file));const actualRequire=owner.require.bind(owner);const selectedRequire=name=>name==='http2'?subject.api:name==='assert'?counted:name==='../common'?common:actualRequire(name);
const wrapped=Function('Buffer','return '+Module.wrap(raw))(subject.Buffer);wrapped.call(owner.exports,owner.exports,selectedRequire,owner,file,path.dirname(file));owner.loaded=true;
console.log(JSON.stringify({mode,passed:true,testSourceSha256:crypto.createHash('sha256').update(raw).digest('hex'),completeSource:true,discoveredFiles:1,runFiles:1,excludedFiles:0,skips:0,assertionCalls:counts,source:'test/parallel/test-http2-getpackedsettings.js',scope:'Unchanged upstream test over selected actual module/Buffer owner; native memory/type/process dependencies, no guest/production JSAPI/session support'}));
