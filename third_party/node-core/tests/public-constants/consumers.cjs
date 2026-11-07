'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),rows=[];
// Execute the actual curated native forwarding method plus exact production
// early constants initializer, over Node's real existing native constant bag.
const binding=require('internal/test/binding').internalBinding('constants');
const adapter=fs.readFileSync(path.join(root,'packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
const method=adapter.match(/        operatingSystem\([^)]*\) \{[^}]+\},/)[0];
let calls=0;
const forwarded=Function('native','return {'+method+'}')({operatingSystem(operation,first,second){
 assert.equal(operation,'constants');assert.equal(first,fs.constants);assert.equal(second,binding.os.signals);calls++;
 return{error:0,value:binding};
}});
const bootstrap=fs.readFileSync(path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
const start=bootstrap.indexOf('// One environment-owned native binding'),end=bootstrap.indexOf('// ============================================================\n// util module',start);
const initial=bootstrap.slice(start,end);
forwarded.signalOperation=function(operation){assert.equal(operation,'constants');return binding.os.signals;};
const actual=Function('_nodeNative','fs',initial+';return {binding:_nodeConstantBinding,nodeOs};')(forwarded,fs);
assert.equal(calls,1);assert.equal(actual.binding,binding);assert.equal(actual.nodeOs.constants,binding.os);
assert.equal(actual.nodeOs.constants.errno,binding.os.errno);rows.push('production argument forwarding and shared OS binding identity');
const crypto=require('node:crypto'),keys=require(path.join(root,'host/test/fixtures/node-key-platform.cjs')).create();
assert.deepEqual(Buffer.from(keys.createSecretKey(Buffer.from('actual secret')).export()),Buffer.from('actual secret'));
rows.push('secret key frontend consumes shared constants contract');
const fixture=path.join(process.env.NODE26_SOURCE,'test/fixtures/keys/ec-key.pem');
const pem=fs.readFileSync(fixture),expected=crypto.createPublicKey(pem);
const actualKey=keys.createPublicKey(pem);
assert.deepEqual(Buffer.from(actualKey.export({format:'der',type:'spki'})),expected.export({format:'der',type:'spki'}));
rows.push('EC public key DER export with actual native key owner');
assert.deepEqual(actualKey.export({format:'jwk'}),expected.export({format:'jwk'}));
rows.push('EC public key JWK export with actual native key owner');
console.log(JSON.stringify({scope:'Actual production forwarding/initializer and key frontend over explicit pinned Node native constants/key/codec boundaries; no guest JSAPI/GC/four-host claim',pass:rows.length,rows}));
