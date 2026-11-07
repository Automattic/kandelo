// Captures use real OpenSSL queues on real native threads. Guest JSAPI remains uncompiled.
'use strict';
const assert=require('node:assert/strict'),util=require('node:util');
assert.equal(process.version,'v26.13.0');
const {operation}=require(process.env.CRYPTO_ERRORS_COMPONENT);
let passes=0;
const empty=operation(0);assert(util.types.isNativeError(empty));assert.equal(empty.message,'Ok');assert.deepEqual(Object.keys(empty),[]);passes++;
const worker=operation(1);assert.equal(worker.message,'error:0480006C:PEM routines::no start line');assert.deepEqual(worker.opensslErrorStack,['error:03000064:digital envelope routines::bad decrypt']);assert.equal(worker.library,'PEM routines');assert.equal(worker.reason,'no start line');assert.equal(worker.code,'ERR_OSSL_PEM_NO_START_LINE');passes++;
const explicit=operation(2);assert.equal(explicit.message,'worker failed');assert.deepEqual(explicit.opensslErrorStack,['error:03000064:digital envelope routines::bad decrypt','error:0480006C:PEM routines::no start line']);passes++;
const marker={marker:true};let actual;Object.defineProperty(Error.prototype,'code',{configurable:true,set(){throw marker}});try{operation(3)}catch(error){actual=error}finally{delete Error.prototype.code}assert.equal(actual,marker);passes++;
const store=operation(3);assert.equal(store.name,'Error');assert.equal(store.code,'ERR_CRYPTO_INVALID_STATE');assert.equal(store.message,'Ok');passes++;
console.log(JSON.stringify({passes,scope:'actual shared captured native OpenSSL queue owner, empty/no-message/node-code store and worker-to-owner transfer; native component only'}));
