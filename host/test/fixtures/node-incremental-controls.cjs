'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { once } = require('node:events');
const { Transform } = require('node:stream');
const { internalBinding } = require('internal/test/binding');
const fixture = require('./node-incremental-platform.cjs');
const target = require('../../../packages/registry/node-compat/target.json');
assert.equal(process.versions.node, target.version, 'Use the exact target native control');
function outcome(fn) {
  try { const value = fn(); return { value: ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value }; }
  catch (e) { return { name: e.name, code: e.code, message: e.message, library: e.library, reason: e.reason, opensslErrorStack: e.opensslErrorStack }; }
}
const scenarios = {
  constructors() {
    const c = fixture.create();
    for (const name of ['Hash', 'Hmac']) {
      const args = name === 'Hash' ? ['sha256'] : ['sha256', 'key'];
      const obj = c[name](...args);
      assert(obj instanceof c[name]); assert(obj instanceof Transform);
      assert.equal(c[name].name, crypto[name].name); assert.equal(c[name].length, crypto[name].length);
      for (const key of ['update', 'digest', '_transform', '_flush', ...(name === 'Hash' ? ['copy'] : [])]) {
        const a = Object.getOwnPropertyDescriptor(c[name].prototype, key), b = Object.getOwnPropertyDescriptor(crypto[name].prototype, key);
        assert.equal(a.value.name, b.value.name); assert.equal(a.value.length, b.value.length);
        for (const prop of ['writable', 'enumerable', 'configurable']) assert.equal(a[prop], b[prop]);
      }
    }
  },
  bytes() {
    const c = fixture.create(), backing = new Uint8Array([0,1,2,3,4,0]);
    const inputs = ['', 'a\0b😀\ud800', backing.subarray(1,5), new DataView(backing.buffer,2,3),new Uint16Array([1,256])];
    for (const alg of ['sha256','SHA256','sha512','md5','sha3-256','RSA-SHA256'])
      for (const input of inputs) for (const encoding of ['hex','buffer','base64','base64url','latin1','utf16le']) {
        assert.deepEqual(outcome(()=>c.createHash(alg).update(input).digest(encoding)), outcome(()=>crypto.createHash(alg).update(input).digest(encoding)));
        for (const key of ['key\0😀', backing.subarray(1,4), new DataView(backing.buffer,2,2),new ArrayBuffer(0)])
          assert.deepEqual(outcome(()=>c.createHmac(alg,key).update(input).digest(encoding)),outcome(()=>crypto.createHmac(alg,key).update(input).digest(encoding)));
      }
  },
  copying() {
    const c = fixture.create();
    for (const alg of ['sha256','shake128','shake256']) for (const length of [0,1,16,32,129]) {
      const options = alg === 'sha256' ? undefined : { outputLength:length };
      const a=c.createHash(alg,options).update('a'),b=crypto.createHash(alg,options).update('a');
      const x=a.copy(),y=b.copy();
      assert.equal(a.update('bc').digest('hex'),b.update('bc').digest('hex'));
      assert.equal(x.update('bd').digest('hex'),y.update('bd').digest('hex'));
      assert.deepEqual(outcome(()=>a.copy()),outcome(()=>b.copy()));
      assert.deepEqual(outcome(()=>a.update('x')),outcome(()=>b.update('x')));
      assert.deepEqual(outcome(()=>a.digest('hex')),outcome(()=>b.digest('hex')));
    }
  },
  encodings() {
    const c=fixture.create();
    const encodings=['utf8','UTF-8','ucs2','utf16le','latin1','binary','hex','base64','base64url','ascii','buffer','unknown','',undefined,null,1];
    if(process.env.KANDELO_INCREMENTAL_NATIVE_HELPER) encodings.push('utf16leJUNK','utf16LEjunk','UTF16LEjunk','hex\0ignored','base64\0ignored');
    for(const encoding of encodings) {
      assert.deepEqual(outcome(()=>c.createHash('sha256').update('616263',encoding).digest('hex')),outcome(()=>crypto.createHash('sha256').update('616263',encoding).digest('hex')));
      assert.deepEqual(outcome(()=>c.createHash('sha256').update('abc').digest(encoding)),outcome(()=>crypto.createHash('sha256').update('abc').digest(encoding)));
    }
  },
  validation() {
    const c=fixture.create();
    for(const alg of [null,1,{},'no-such-digest'])
      assert.deepEqual(outcome(()=>c.createHash(alg)),outcome(()=>crypto.createHash(alg)));
    for(const data of [null,{},[],new ArrayBuffer(1),new SharedArrayBuffer(1)])
      assert.deepEqual(outcome(()=>c.createHash('sha256').update(data)),outcome(()=>crypto.createHash('sha256').update(data)));
    for(const key of [null,{},[],undefined,1])
      assert.deepEqual(outcome(()=>c.createHmac('sha256',key)),outcome(()=>crypto.createHmac('sha256',key)));
    for(const options of [{outputLength:-1},{outputLength:NaN},{outputLength:'1'},{functionName:'\0'}])
      assert.deepEqual(outcome(()=>c.createHash('sha256',options)),outcome(()=>crypto.createHash('sha256',options)));
    const a=c.createHash('sha256'),b=crypto.createHash('sha256');
    assert.deepEqual(outcome(()=>a.digest(Symbol())),outcome(()=>b.digest(Symbol())));
    assert.equal(a.update('still-open').digest('hex'),b.update('still-open').digest('hex'));
    const m=c.createHmac('sha256','key').update('abc'),n=crypto.createHmac('sha256','key').update('abc');
    assert.equal(m.digest('hex'),n.digest('hex'));assert.deepEqual(outcome(()=>m.digest()),outcome(()=>n.digest()));
  },
  async streams() {
    const c=fixture.create();
    async function run(api,hmac) {
      const h=hmac?api.createHmac('sha256','key'):api.createHash('sha256');
      const chunks=[];h.on('data',data=>chunks.push(Buffer.from(data)));
      const ended=once(h,'end');h.write('a');h.end(Buffer.from('bc'));await ended;
      return { data:Buffer.concat(chunks).toString('hex'), digest:outcome(()=>h.digest('hex')),update:outcome(()=>h.update('later')) };
    }
    for(const hmac of [false,true]) {
      const a=await run(c,hmac),b=await run(crypto,hmac);
      // update returns the stream itself on success; compare the native
      // underlying cached-digest behavior without serializing host owners.
      if(a.update.value) {assert(b.update.value);a.update={success:true};b.update={success:true};}
      assert.deepEqual(a,b);
    }
  },
  nativeState() {
    const b=internalBinding('crypto');
    const hash=new b.Hash('sha256',undefined,-1,Object.create(null));hash.update(Buffer.from('abc'));
    const first=hash.digest().toString('hex');assert.equal(hash.digest().toString('hex'),first);
    const hmac=new b.Hmac();hmac.init('sha256',Buffer.from('key'));hmac.update(Buffer.from('abc'));
    assert.equal(hmac.digest().toString('hex'),crypto.createHmac('sha256','key').update('abc').digest('hex'));
    assert.equal(hmac.digest().length,0);assert.equal(hmac.update(Buffer.from('later')),false);
  },
};
const name=process.argv[2];
if(!Object.hasOwn(scenarios,name)) throw Error('Select one bounded control');
Promise.resolve().then(()=>scenarios[name]()).then(()=>console.log('PASS',name));
