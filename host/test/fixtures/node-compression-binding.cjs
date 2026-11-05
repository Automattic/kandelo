'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const native = require('node:zlib');
const root = resolve(__dirname, '../../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const target = JSON.parse(read('packages/registry/node-compat/target.json'));
assert.equal(process.versions.node, target.version);
const bundle = read('third_party/node-core/node-core.js');
const manifest = JSON.parse(read('third_party/node-core/sources.json'));
const source = read('third_party/node-core/' + manifest.streamPlatform.zlib.path);
assert.equal(createHash('sha256').update(source).digest('hex'), manifest.streamPlatform.zlib.sha256);
const makeBinding = Function(`${bundle};return _createNodeCompressionBinding;`)();

function subject() {
  // Only this isolated, explicitly flagged native subprocess exposes test
  // bindings. Public policy controls in the parent keep ordinary flags.
  const { internalBinding, primordials } = require('internal/test/binding');
  const backend = internalBinding('zlib'), constants = internalBinding('constants').zlib;
  const binding = makeBinding({ compressionConstants: constants, native: {
    crc32: backend.crc32,
    createCompressionHandle(mode, prototype) {
      const Handle = mode === constants.BROTLI_ENCODE ? backend.BrotliEncoder
        : mode === constants.BROTLI_DECODE ? backend.BrotliDecoder
        : mode === constants.ZSTD_COMPRESS ? backend.ZstdCompress
        : mode === constants.ZSTD_DECOMPRESS ? backend.ZstdDecompress : backend.Zlib;
      const handle = new Handle(mode);
      // Production defines methods on each real handle. Retain actual native
      // methods before applying the requested constructor prototype. Codec
      // work, buffers and errors here remain native reference boundaries.
      for (let current = Object.getPrototypeOf(handle); current && current !== Object.prototype;
        current = Object.getPrototypeOf(current)) {
        for (const key of Reflect.ownKeys(current)) if (key !== 'constructor' && !Object.hasOwn(handle, key)) {
          Object.defineProperty(handle, key, Object.getOwnPropertyDescriptor(current, key));
        }
      }
      Object.setPrototypeOf(handle, prototype);
      return handle;
    },
  } });
  const module = { exports: {} };
  // Actual pinned public algorithms and candidate private JS constructors.
  // Native streams/errors/ZIP/Buffer/async and codecs are explicit boundaries;
  // this does not compile or execute Kandelo's codec-handle.cpp.
  Function('module', 'exports', 'require', 'primordials', 'internalBinding', 'process', source)
    (module, module.exports, require, primordials,
      name => name === 'zlib' ? binding : internalBinding(name), process);
  return { api: module.exports, binding, constants };
}
function outcome(fn) {
  try { return { value: fn() }; } catch (error) {
    return { error: { name: error.name, code: error.code, message: error.message } };
  }
}
const data = Buffer.from('byte codec control: é\0世界 '.repeat(100));
const cases = {
  constructors() {
    const { binding, constants } = subject();
    class Derived extends binding.Zlib {}
    function initialize(handle) {
      handle.init(15, -1, 8, constants.Z_DEFAULT_STRATEGY, new Uint32Array(2), () => {}, undefined);
      return handle;
    }
    for (const handle of [new binding.Zlib(constants.DEFLATE), new Derived(constants.DEFLATE)]) {
      initialize(handle);
      try { assert.equal(handle instanceof binding.Zlib, true); assert.equal(Object.hasOwn(handle, 'init'), true); }
      finally { handle.close(); }
    }
    const handle = initialize(new Derived(constants.GZIP));
    try { assert.equal(Object.getPrototypeOf(handle), Derived.prototype); } finally { handle.close(); }
    assert.throws(() => binding.Zlib(constants.DEFLATE), TypeError);
  },
  fractionalOptions() {
    const { api } = subject();
    for (const options of [{ level: 6.75 }, { level: -0.75 }, { windowBits: 12.75 },
      { memLevel: 6.5 }, { strategy: 0.75 }, { chunkSize: 128.75 },
      { flush: 0.75 }, { finishFlush: 4.75 }]) {
      for (const method of ['deflateSync', 'gzipSync', 'deflateRawSync']) {
        assert.deepEqual(outcome(() => api[method](data, options)),
          outcome(() => native[method](data, options)), `${method}/${JSON.stringify(options)}`);
      }
    }
    assert.deepEqual(api.inflateSync(api.deflateSync(data, { level: 6.75 })), data);
  },
  async asyncSpansAndParams() {
    async function run(api) {
      const stream = api.createDeflate({ chunkSize: 128.75 }), chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      const ended = new Promise((resolve, reject) => { stream.once('end', resolve); stream.once('error', reject); });
      let calls = 0;
      try {
        stream.write(data.subarray(0, 400));
        await new Promise((resolve, reject) => stream.params(6.75, 0.75, error => {
          calls++; if (error) reject(error); else resolve();
        }));
        stream.end(data.subarray(400)); await ended;
        return { decoded: native.inflateSync(Buffer.concat(chunks)), calls, bytesWritten: stream.bytesWritten };
      } finally { stream.destroy(); }
    }
    assert.deepEqual(await run(subject().api), await run(native));
  },
  initializationErrors() {
    const { api } = subject();
    for (const [method, options] of [
      ['createBrotliCompress', { params: { [native.constants.BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING]: 2 } }],
      ['createZstdCompress', { params: { [native.constants.ZSTD_c_windowLog]: 200 } }],
      ['createZstdDecompress', { params: { [native.constants.ZSTD_d_windowLogMax]: 200 } }],
    ]) {
      function initialize(api) {
        return outcome(() => { const stream = api[method](options); stream.destroy(); return 'accepted'; });
      }
      const control = initialize(native);
      assert.equal(control.error?.code, 'ERR_ZLIB_INITIALIZATION_FAILED');
      assert.deepEqual(initialize(api), control);
    }
    // Brotli accepts quality then clamps it during encoding. Preserve this
    // reference finding rather than treating it as an init-error fixture.
    const options = { params: { [native.constants.BROTLI_PARAM_QUALITY]: 999 } };
    assert.deepEqual(api.brotliCompressSync(data, options), native.brotliCompressSync(data, options));
  },
  publicValidation() {
    const { api } = subject();
    for (const options of [{ level: 10.5 }, { level: -1.5 }, { windowBits: 16.25 },
      { memLevel: 0.75 }, { strategy: 5.5 }, { level: '6' }, { chunkSize: 2 }, { flush: 10 }]) {
      assert.deepEqual(outcome(() => api.deflateSync(data, options)), outcome(() => native.deflateSync(data, options)));
    }
  },
};
const name = process.argv[2];
assert.equal(Object.hasOwn(cases, name), true, 'Unknown source control');
Promise.resolve().then(() => cases[name]()).then(() => console.log(JSON.stringify({ case: name, passed: true })), error => {
  console.error(error); process.exitCode = 1;
});
