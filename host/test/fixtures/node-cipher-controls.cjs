'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const candidate = require('./node-cipher-platform.cjs').create();
const key = Buffer.alloc(16, 1), iv = Buffer.alloc(16, 2), message = Buffer.from('incremental cipher payload');
const error = fn => { try { fn(); return null; } catch (e) { return { name: e.name, code: e.code, message: e.message }; } };
function output(api, name, options = {}) {
  const cipher = api.createCipheriv(name, key, name.includes('gcm') ? iv.subarray(0, 12) : iv, options);
  const data = Buffer.concat([cipher.update(message.subarray(0, 3)), cipher.update(message.subarray(3)), cipher.final()]);
  return { data, cipher };
}
const cases = {
  validation() {
    for (const args of [[null, key, iv], ['unknown', key, iv], ['aes-128-cbc', key, null],
      ['aes-128-cbc', Buffer.alloc(3), iv], ['aes-128-gcm', key, iv, { authTagLength: 3 }],
      ['aes-128-ccm', key, iv.subarray(0, 12)], ['aes-128-cbc', key, iv, { ctsMode: 'bad' }],
      ['aes-128-cbc', key, iv, { xtsStandard: 'bad' }]])
      assert.deepEqual(error(() => candidate.createCipheriv(...args)), error(() => crypto.createCipheriv(...args)));
  },
  incremental() {
    for (const name of ['aes-128-cbc', 'aes-128-ctr']) {
      const actual = output(candidate, name), expected = output(crypto, name);
      assert.deepEqual(actual.data, expected.data);
      assert(actual.cipher instanceof candidate.Cipheriv);
      assert.deepEqual(error(() => actual.cipher.update(message)), error(() => expected.cipher.update(message)));
      assert.deepEqual(error(() => actual.cipher.final()), error(() => expected.cipher.final()));
      const decipher = candidate.Decipheriv(name, key, iv);
      assert(decipher instanceof candidate.Decipheriv);
      assert.deepEqual(Buffer.concat([decipher.update(actual.data), decipher.final()]), message);
    }
    const owned = crypto.createSecretKey(key);
    const cipher = candidate.Cipheriv('aes-128-cbc', owned, iv);
    assert.equal(cipher.update('616263', 'hex', 'base64') + cipher.final('base64'),
      (() => { const c = crypto.Cipheriv('aes-128-cbc', owned, iv); return c.update('616263', 'hex', 'base64') + c.final('base64'); })());
  },
  authenticated() {
    for (const api of [candidate, crypto]) {
      const cipher = api.createCipheriv('aes-128-gcm', key, iv.subarray(0, 12));
      assert.equal(cipher.setAAD(Buffer.from('aad')), cipher);
      const data = Buffer.concat([cipher.update(message), cipher.final()]), tag = cipher.getAuthTag();
      const decipher = api.createDecipheriv('aes-128-gcm', key, iv.subarray(0, 12));
      decipher.setAAD(Buffer.from('aad')); decipher.setAuthTag(tag);
      assert.deepEqual(Buffer.concat([decipher.update(data), decipher.final()]), message);
      const wrong = api.createDecipheriv('aes-128-gcm', key, iv.subarray(0, 12));
      wrong.setAAD(Buffer.from('aad')); wrong.setAuthTag(Buffer.alloc(16)); wrong.update(data);
      assert.throws(() => wrong.final(), /authenticate/);
      assert.throws(() => wrong.final(), { code: 'ERR_CRYPTO_INVALID_STATE' });
      const fresh = api.createDecipheriv('aes-128-gcm', key, iv.subarray(0, 12));
      assert.throws(() => fresh.setAuthTag(Buffer.alloc(8)), { code: 'ERR_CRYPTO_INVALID_AUTH_TAG' });
    }
  },
  metadata() {
    for (const name of ['aes-128-cbc', 'aes-128-gcm', 'chacha20', 'aes-128-ecb', 'unknown', '', 419, -1, 0.5])
      for (const options of [undefined, { keyLength: 3 }, { ivLength: 0 }, { ivLength: 8 }])
        assert.deepEqual(candidate.getCipherInfo(name, options), crypto.getCipherInfo(name, options));
    assert.deepEqual(candidate.getCiphers(), crypto.getCiphers());
    const list = candidate.getCiphers(); list.length = 0;
    assert(candidate.getCiphers().includes('aes-128-cbc'));
    for (const name of ['Cipheriv', 'Decipheriv', 'createCipheriv', 'createDecipheriv', 'getCipherInfo', 'getCiphers']) {
      assert.equal(candidate[name].name, crypto[name].name); assert.equal(candidate[name].length, crypto[name].length);
    }
  },
  async streamsAndCodecs() {
    const cipher = candidate.createCipheriv('aes-128-cbc', key, iv);
    const chunks = [];
    // This fixture explicitly uses native Node streams, which normalize
    // Uint8Array chunks to their own Buffer. Guest brands need guest controls.
    cipher.on('data', chunk => { assert(Buffer.isBuffer(chunk)); chunks.push(Buffer.from(chunk)); });
    await pipeline(Readable.from([message.subarray(0, 2), message.subarray(2)]), cipher);
    assert.deepEqual(Buffer.concat(chunks), output(crypto, 'aes-128-cbc').data);
    const c = candidate.createCipheriv('aes-128-cbc', key, iv);
    const saved = candidate.Buffer.from, toString = candidate.Buffer.prototype.toString;
    try {
      candidate.Buffer.from = candidate.Buffer.prototype.toString = () => { throw Error('public codec called'); };
      const bytes = c.update('payload', 'utf8'); assert(candidate.Buffer.isBuffer(bytes)); c.final();
    } finally { candidate.Buffer.from = saved; candidate.Buffer.prototype.toString = toString; }
  },
};
(async () => { const name = process.argv[2]; assert.equal(typeof cases[name], 'function'); await cases[name](); console.log(JSON.stringify({ name, passed: true })); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
