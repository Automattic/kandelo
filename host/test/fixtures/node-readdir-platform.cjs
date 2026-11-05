'use strict';
// Actual candidate algorithms/private byte codecs. Native Node supplies the
// filesystem/request/engine boundary; this is not the guest JSAPI bridge.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util');
const { fileURLToPath } = require('node:url');
const globals = ['internalBinding', 'primordials'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
const { internalBinding } = require('internal/test/binding');
for (const [key, d] of globals) { if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key]; }
const binding = internalBinding('fs');
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return {values:_createNodeValuesPlatform,stats:_createNodeFsStats,readdir:_createNodeReaddirPlatform};')();
exports.create = function create(options = {}) {
  const bytes = require('./node-buffer-codecs.cjs').create();
  const values = factories.values({ process, Buffer: bytes.Buffer, util, inspection: util,
    os: require('node:os'), signals: require('node:os').constants.signals,
    uv: { binding: internalBinding('uv') }, getDOMException: () => DOMException });
  const truncation = { vfsState: { handlers: null }, FSReqCallback: binding.FSReqCallback,
    makeError(status, syscall, path) { return new values.errors.UVException({ errno: status,
      code: util.getSystemErrorName(status), syscall, path }); } };
  const utils = factories.stats({ fs, process, Buffer: bytes.Buffer, types: util.types, values,
    truncation, native: {}, permissionEnabled: () => false,
    toPathIfFileURL: value => value instanceof URL ? fileURLToPath(value) : value });
  function packet(result, recursive, withTypes) {
    if (recursive) return withTypes ? result : [result, [], [], []];
    if (options.forceUnknown) result[1] = result[1].map(() => 0);
    return [result[0], result[1], [result[0].length], [Buffer.alloc(0)]];
  }
  const native = {
    fsReaddirSync(path, recursive, withTypes, convert) {
      let result;
      try { result = recursive ? binding.readdirRecursive(path, 'buffer', withTypes) : binding.readdir(path, 'buffer', true); }
      catch (error) {
        if (typeof error.errno !== 'number') throw error;
        return convert([error.errno, Buffer.from(error.path)]);
      }
      return convert(packet(result, recursive, withTypes));
    },
    fsReaddirPromise(path, recursive, withTypes, request, convert) {
      const name = recursive ? 'readdirRecursive' : 'readdir', types = recursive ? withTypes : true;
      if (typeof request === 'function') {
        // Explicit native promise conversion control: this extra reaction is
        // fixture transport, not evidence for guest completion ordering.
        return binding[name](path, 'buffer', types, binding.kUsePromises)
          .then(result => convert(packet(result, recursive, withTypes)));
      }
      const complete = request.oncomplete;
      request.oncomplete = function(error, result) {
        if (error) return Reflect.apply(complete, this, [error]);
        let value;
        try { value = convert(packet(result, recursive, withTypes)); }
        catch (error) { return Reflect.apply(complete, this, [error]); }
        return Reflect.apply(complete, this, [null, value]);
      };
      return binding[name](path, 'buffer', types, request);
    },
  };
  const platform = factories.readdir({ fs: options.fs ?? fs, Buffer: bytes.Buffer, path, process,
    types: util.types, values, utils, truncation, codecs: bytes.codecs, native,
    promisify: util.promisify, permissionEnabled: () => false,
    internalModuleStat: path => binding.internalModuleStat(path) });
  return { ...platform, truncation, bytes, native, binding, values, utils,
    boundary: 'Candidate public/byte algorithms with native filesystem/request/engine dependencies' };
};
