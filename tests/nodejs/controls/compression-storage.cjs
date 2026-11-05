'use strict';
// Same public-API source runs on the exact native reference and admitted guest.
// Each named case owns its completion; no sleeps, private bindings or host shim.
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const data = Buffer.from('offset byte control: é\0世界 and repeating dictionary '.repeat(80));
const pairs = [['deflateSync', 'inflateSync'], ['gzipSync', 'gunzipSync'],
  ['deflateRawSync', 'inflateRawSync'], ['brotliCompressSync', 'brotliDecompressSync'],
  ['zstdCompressSync', 'zstdDecompressSync']];
function input(kind, bytes = data) {
  const size = bytes.length + 16;
  const buffer = kind === 'shared' ? new SharedArrayBuffer(size)
    : kind === 'growable' ? new SharedArrayBuffer(size, { maxByteLength: size * 2 })
    : new ArrayBuffer(size, { maxByteLength: size * 2 });
  new Uint8Array(buffer).set(bytes, 8);
  return { buffer, view: new Uint8Array(buffer, 8, bytes.length) };
}
const checksum = bytes => [bytes.length, zlib.crc32(bytes)];
const invoke = (method, bytes, options) => new Promise((resolve, reject) =>
  zlib[method](bytes, options, (error, output) => error ? reject(error) : resolve(output)));
const cases = {
  crc() {
    const results = [];
    for (const kind of ['shared', 'growable', 'resizable']) {
      const { buffer, view } = input(kind);
      const variants = [view, new DataView(buffer, 8, view.byteLength),
        new Uint16Array(buffer, 8, view.byteLength / 2)];
      for (const value of variants) {
        assert.equal(zlib.crc32(value), zlib.crc32(data));
        assert.equal(zlib.crc32(value, 0xffffffff), zlib.crc32(data, 0xffffffff));
      }
      if (kind === 'growable') buffer.grow(buffer.byteLength * 2);
      if (kind === 'resizable') buffer.resize(buffer.byteLength * 2);
      results.push(checksum(view));
    }
    return results;
  },
  sync() {
    const results = [];
    for (const kind of ['shared', 'growable', 'resizable']) {
      const { view } = input(kind);
      for (const [encode, decode] of pairs) {
        const encoded = zlib[encode](view);
        assert.deepEqual(zlib[decode](encoded), data);
        results.push([kind, encode, ...checksum(encoded)]);
      }
    }
    return results;
  },
  dictionaries() {
    const results = [];
    for (const kind of ['shared', 'growable', 'resizable']) {
      const { view } = input(kind, data.subarray(0, 1500));
      const options = { dictionary: view };
      for (const [encode, decode] of [pairs[0], pairs[2], pairs[3], pairs[4]]) {
        const encoded = zlib[encode](data, options);
        assert.deepEqual(zlib[decode](encoded, options), data);
        results.push([kind, encode, ...checksum(encoded)]);
      }
    }
    return results;
  },
  async asyncShared() {
    const results = [];
    for (const kind of ['shared', 'growable']) {
      const { view } = input(kind);
      for (const [encode, decode] of pairs) {
        const encoded = await invoke(encode.replace('Sync', ''), view, {});
        assert.deepEqual(zlib[decode](encoded), data);
        results.push([kind, encode, ...checksum(encoded)]);
      }
    }
    return results;
  },
  async growth() {
    const bytes = Buffer.alloc(512 * 1024, 0x61);
    const { buffer } = input('growable', bytes);
    const view = new Uint8Array(buffer, 8); // Deliberately length-tracking.
    const expected = Buffer.from(view);
    const pending = invoke('gzip', view, {});
    const initial = buffer.byteLength;
    buffer.grow(initial * 2);
    new Uint8Array(buffer, initial).fill(0x62);
    const encoded = await pending;
    assert.deepEqual(zlib.gunzipSync(encoded), expected);
    return [buffer.byteLength, ...checksum(encoded)];
  },
  async concurrent() {
    const { buffer, view } = input('shared');
    const part = new Uint8Array(buffer, 8 + 10, data.length - 10);
    const pending = [invoke('gzip', view, {}), invoke('gzip', part, {}),
      invoke('deflate', view, {}).then(() => invoke('gzip', view, {}))];
    const outputs = await Promise.all(pending);
    for (let i = 0; i < outputs.length; ++i)
      assert.deepEqual(zlib.gunzipSync(outputs[i]), i === 1 ? data.subarray(10) : data);
    return outputs.map(checksum);
  },
  async fileConsumer() {
    const fs = require('node:fs');
    const path = '/tmp/kandelo-codec-storage-' + process.pid;
    const { view } = input('shared');
    try {
      await new Promise((resolve, reject) => fs.writeFile(path, view, error => error ? reject(error) : resolve()));
      const actual = fs.readFileSync(path);
      assert.deepEqual(actual, data);
      return checksum(actual);
    } finally { if (fs.existsSync(path)) fs.unlinkSync(path); }
  },
};
const name = process.argv[1];
if (!Object.hasOwn(cases, name)) throw new Error('Unknown control: ' + name);
Promise.resolve().then(() => cases[name]()).then(result => {
  console.log('CONTROL_RESULT:' + JSON.stringify(result));
}, error => { console.error(error); process.exitCode = 1; });
