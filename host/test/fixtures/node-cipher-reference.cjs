'use strict';
const crypto = require('node:crypto');
const [name, direction, keyHex, ivHex, data, aad, tag, tagLength, cts, xts] = process.argv.slice(2);
try {
  const options = {};
  if (tagLength !== '-1') options.authTagLength = Number(tagLength);
  if (cts !== '-') options.ctsMode = cts;
  if (xts !== '-') options.xtsStandard = xts;
  const cipher = crypto[direction === 'encrypt' ? 'createCipheriv' : 'createDecipheriv'](name,
    Buffer.from(keyHex, 'hex'), ivHex ? Buffer.from(ivHex, 'hex') : null, options);
  if (tag !== '-') cipher.setAuthTag(Buffer.from(tag, 'hex'));
  if (aad !== '-') {
    const [hex, size] = aad.split(':');
    cipher.setAAD(Buffer.from(hex, 'hex'), size === undefined ? undefined : { plaintextLength: Number(size) });
  }
  const output = Buffer.concat([...data.split(',').map(chunk => cipher.update(Buffer.from(chunk, 'hex'))), cipher.final()]);
  console.log(JSON.stringify({ output: output.toString('hex'),
    tag: direction === 'encrypt' && /(?:gcm|ccm|ocb|poly1305|siv)/i.test(name) ? cipher.getAuthTag().toString('hex') : null }));
} catch (error) { console.log(JSON.stringify({ error: { message: error.message, code: error.code ?? null } })); }
