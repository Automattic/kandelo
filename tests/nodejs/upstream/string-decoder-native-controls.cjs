'use strict';
const { internalBinding } = require('internal/test/binding');
const { writeSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const binding = internalBinding('string_decoder');
const observations = [], matrix = [];
let failures = 0;
function assert(condition, message) { if (!condition) throw new Error(message); }
function check(name, run) {
  try { const detail = run(); observations.push({ name, status: 'pass', detail }); }
  catch (error) { failures++; observations.push({ name, status: 'fail', error: { name: error.name, message: error.message, stack: error.stack } }); }
}
function state(encoding) {
  const storage = new Uint8Array(binding.kSize);
  storage[binding.kEncodingField] = binding.encodings.indexOf(encoding);
  assert(storage[binding.kEncodingField] !== 255, 'unknown reference encoding');
  return storage;
}
check('native-export-descriptors-and-encoding-layout', () => Object.fromEntries(
  Reflect.ownKeys(binding).map(name => {
    const d = Object.getOwnPropertyDescriptor(binding, name), v = d.value;
    return [name, { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable,
      value: typeof v === 'function' ? { type: 'function', name: v.name, length: v.length } : v }];
  })));
for (const [encoding, input, expected] of [
  ['utf8', [0x41, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80], 'Aé😀'],
  ['utf16le', [0x41, 0, 0x3d, 0xd8, 0, 0xde], 'A😀'],
  ['ascii', [0x41, 0xc1, 0xff], 'AA\x7f'],
  ['latin1', [0x41, 0xc1, 0xff], 'AÁÿ'],
  ['hex', [0x41, 0x42, 0xff], '4142ff'],
  ['base64', [1, 2, 3, 4], 'AQIDBA=='],
  ['base64url', [0xfb, 0xff, 0xff, 0xfe], '-____g'],
]) check('incremental-known-output-' + encoding, () => {
  const s = state(encoding); let actual = '';
  for (const byte of input) { gc(); actual += binding.decode(s, Uint8Array.of(byte)); }
  actual += binding.flush(s);
  assert(actual === expected, JSON.stringify({ actual, expected }));
  assert(s[binding.kMissingBytes] === 0 && s[binding.kBufferedBytes] === 0, 'state not cleared');
  return { actual, state: Array.from(s) };
});
check('input-view-offset-and-byte-length-use-actual-backing-memory', () => {
  const bytes = Uint8Array.of(0xff, 0x41, 0x42, 0xff), s = state('utf8');
  const output = binding.decode(s, new DataView(bytes.buffer, 1, 2));
  assert(output === 'AB', output); return output;
});
check('state-view-offset-writes-only-the-decoder-bytes', () => {
  const bytes = new Uint8Array(binding.kSize + 4).fill(0xa5), s = bytes.subarray(2, 2 + binding.kSize);
  s.fill(0); s[binding.kEncodingField] = binding.encodings.indexOf('utf8');
  assert(binding.decode(s, Uint8Array.of(0xe2)) === '', 'unexpected incomplete output'); gc();
  assert(binding.decode(s, Uint8Array.of(0x82, 0xac)) === '€', 'lost decoder state');
  assert(bytes[0] === 0xa5 && bytes[1] === 0xa5 && bytes.at(-1) === 0xa5 && bytes.at(-2) === 0xa5, 'state escaped its view');
  return Array.from(bytes);
});
check('shared-input-and-state-are-real-backing-storage', () => {
  const s = new Uint8Array(new SharedArrayBuffer(binding.kSize));
  s[binding.kEncodingField] = binding.encodings.indexOf('utf8');
  const bytes = new Uint8Array(new SharedArrayBuffer(3)); bytes.set([0xe2, 0x82, 0xac]);
  assert(binding.decode(s, bytes.subarray(0, 1)) === '', 'unexpected partial shared output');
  assert(s[binding.kMissingBytes] === 2, 'shared state was not written'); gc();
  assert(binding.decode(s, bytes.subarray(1)) === '€', 'shared decoding failed');
  return Array.from(s);
});
check('detached-input-is-observed-as-an-empty-view', () => {
  const bytes = Uint8Array.of(0x41), s = state('utf8');
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  const output = binding.decode(s, bytes); assert(output === '', 'detached input was read'); return output;
});
check('record-chunk-boundaries-and-state-against-original-public-module', () => {
  const inputs = [[], [0x41], [0xc3], [0xc3, 0xa9], [0xf0, 0x9f, 0x98, 0x80],
    [0xe2, 0x82, 0x41, 0xac], [0xc0, 0x80, 0xff, 0x41], [0xed, 0xa0, 0x80],
    [0x3d, 0xd8, 0, 0xde, 0x41], [0xff, 0xfe, 1, 2, 3, 4, 5]];
  for (const encoding of ['ascii', 'utf8', 'base64', 'utf16le', 'latin1', 'hex', 'base64url']) {
    for (const input of inputs) for (const width of [1, 2, 3, 8]) {
      const s = state(encoding), publicDecoder = new StringDecoder(encoding), chunks = [];
      for (let offset = 0; offset < input.length; offset += width) {
        const bytes = Uint8Array.from(input.slice(offset, offset + width));
        const output = binding.decode(s, bytes), expected = publicDecoder.write(bytes);
        assert(output === expected, 'original public and native chunk outputs differ');
        chunks.push({ input: Array.from(bytes), output, state: Array.from(s) });
      }
      const flushed = binding.flush(s), expected = publicDecoder.end();
      assert(flushed === expected, 'original public and native flush outputs differ');
      matrix.push({ encoding, input, width, chunks, flushed, state: Array.from(s) });
    }
  }
  return { entries: matrix.length };
});
writeSync(1, JSON.stringify({ kind: 'native-string-decoder-reference', cases: observations.length, failures, observations, matrix }) + '\n');
if (failures) process.exitCode = 1;
