'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const name = process.argv[1];
function run(mode, key, iv, data, options, aad) {
  const cipher = crypto.createCipheriv(mode, key, iv, options);
  if (aad) cipher.setAAD(aad, { plaintextLength: data.length });
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = typeof cipher.getAuthTag === 'function' && /gcm|ccm|ocb|poly1305|siv/.test(mode) ? cipher.getAuthTag() : undefined;
  const decipher = crypto.createDecipheriv(mode, key, iv, options);
  if (tag) decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad, { plaintextLength: data.length });
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  assert.deepEqual(decrypted, data);
  assert.throws(() => cipher.final(), { code: 'ERR_CRYPTO_INVALID_STATE' });
  return [encrypted.toString('hex'), tag ? tag.toString('hex') : null];
}
async function main() {
  let output;
  if (name === 'incremental') {
    const key = Buffer.alloc(16, 1), iv = Buffer.alloc(16, 2);
    const c = crypto.createCipheriv('aes-128-cbc', crypto.createSecretKey(key), iv);
    const bytes = Buffer.concat([c.update('hello ', 'utf8'), c.update('world', 'utf8'), c.final()]);
    const d = new crypto.Decipheriv('aes-128-cbc', key, iv);
    const text = d.update(bytes, undefined, 'utf8') + d.final('utf8');
    assert.equal(text, 'hello world');
    assert.throws(() => c.setAutoPadding(), { code: 'ERR_CRYPTO_INVALID_STATE' });
    output = [bytes.toString('hex'), text, run('aes-128-cbc', key, iv, Buffer.alloc(0))];
  } else if (name === 'authenticated') {
    output = [];
    for (const mode of ['aes-128-gcm', 'aes-128-ccm']) {
      const key = Buffer.alloc(16, 3), iv = Buffer.alloc(12, 4), opts = { authTagLength: 12 };
      output.push(run(mode, key, iv, Buffer.from('authenticated data'), opts, Buffer.from('header')));
      const c = crypto.createCipheriv(mode, key, iv, opts);
      const data = Buffer.from('bad tag');
      c.setAAD(Buffer.from('header'), { plaintextLength: data.length });
      const encrypted = Buffer.concat([c.update(data), c.final()]);
      const d = crypto.createDecipheriv(mode, key, iv, opts);
      d.setAuthTag(Buffer.alloc(12)); d.setAAD(Buffer.from('header'), { plaintextLength: data.length });
      d.update(encrypted);
      assert.throws(() => d.final(), /authenticate data/);
      assert.throws(() => d.final(), { code: 'ERR_CRYPTO_INVALID_STATE' });
    }
    output.push(run('aes-128-gcm', Buffer.alloc(16), Buffer.alloc(12), Buffer.alloc(0)));
  } else if (name === 'modes') {
    output = [];
    for (const [mode, size, ivSize, options] of [
      ['aes-128-xts', 32, 16, {}], ['aes-128-cbc-cts', 16, 16, { ctsMode: 'CS3' }],
      ['aes-128-wrap', 16, 8, {}], ['aes-128-siv', 32, 0, { authTagLength: 16 }],
      ['aes-128-gcm-siv', 16, 12, { authTagLength: 16 }],
    ]) {
      const key = Buffer.from(Array.from({ length: size }, (_, i) => i));
      const iv = ivSize ? Buffer.alloc(ivSize, 7) : null;
      output.push(run(mode, key, iv, Buffer.alloc(32, 8), options));
      const c = crypto.createCipheriv(mode, key, iv, options);
      c.update(Buffer.alloc(32, 8));
      assert.throws(() => c.update(Buffer.alloc(32, 8)), /unsupported state/);
    }
  } else if (name === 'metadata') {
    const info = crypto.getCipherInfo('aes-128-cbc');
    assert.equal(Object.getPrototypeOf(info), null);
    assert.equal(info.keyLength, 16); assert.equal(info.ivLength, 16); assert.equal(info.blockSize, 16);
    assert.equal(crypto.getCipherInfo('missing-cipher'), undefined);
    assert.equal(crypto.getCipherInfo('aes-128-cbc', { keyLength: 1 }), undefined);
    assert.deepEqual(crypto.getCipherInfo(info.nid), info);
    assert.throws(() => crypto.createCipheriv('aes-128-cbc', Buffer.alloc(1), Buffer.alloc(16)), { code: 'ERR_CRYPTO_INVALID_KEYLEN' });
    assert.throws(() => crypto.createCipheriv('aes-128-cbc', Buffer.alloc(16), Buffer.alloc(1)), { code: 'ERR_CRYPTO_INVALID_IV' });
    const list = crypto.getCiphers(); assert(list.includes('aes-128-cbc'));
    list.length = 0; assert(crypto.getCiphers().includes('aes-128-cbc'));
    output = [Object.keys(info), info];
  } else if (name === 'stream') {
    const c = crypto.createCipheriv('aes-128-cbc', Buffer.alloc(16, 1), Buffer.alloc(16, 2));
    const chunks = [];
    const complete = new Promise((resolve, reject) => { c.on('data', b => { assert(Buffer.isBuffer(b)); chunks.push(b); }); c.on('end', resolve); c.on('error', reject); });
    c.write('hello '); c.end('world'); await complete;
    output = Buffer.concat(chunks).toString('hex');
  } else throw Error('Unknown case ' + name);
  console.log('CONTROL_RESULT:' + JSON.stringify({ name, output }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
