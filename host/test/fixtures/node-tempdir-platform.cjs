'use strict';
// Public candidate wrappers and codecs over native Node's actual FS requests.
// The new guest C++/libc path is a distinct portable-owner/guest obligation.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { fileURLToPath } = require('node:url');
const globals = ['internalBinding', 'primordials'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const { internalBinding } = require('internal/test/binding');
for (const [key, descriptor] of globals) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
}
const binding = internalBinding('fs');
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return { stats:_createNodeFsStats, temp:_createNodeTempdirPlatform };')();
exports.create = function create() {
  const bytes = require('./node-buffer-codecs.cjs').create();
  const removal = require('./node-removal-platform.cjs').create();
  const { values, truncation } = removal;
  const utils = factories.stats({ fs, process, Buffer: bytes.Buffer, types: util.types,
    values, truncation, native: {}, permissionEnabled: () => false,
    toPathIfFileURL: value => value instanceof URL ? fileURLToPath(value) : value });
  const calls = [];
  const native = {
    fsPathSync(name, prefix) {
      if (name !== 'mkdtemp') throw Error(name);
      calls.push({ async: false });
      try { return binding.mkdtemp(prefix, 'buffer'); }
      catch (error) { if (typeof error.errno !== 'number') throw error; return error.errno; }
    },
    fsPathPromise(name, prefix, mode, recursive, request, convert) {
      if (name !== 'mkdtemp' || mode !== 0 || recursive !== false) throw Error('path dispatch');
      calls.push({ async: true });
      if (typeof request === 'function')
        return binding.mkdtemp(prefix, 'buffer', binding.kUsePromises).then(convert);
      const callback = request.oncomplete;
      request.oncomplete = function(error, result) {
        if (error) return Reflect.apply(callback, this, [error]);
        try { result = convert(result); }
        catch (error) { return Reflect.apply(callback, this, [error]); }
        return Reflect.apply(callback, this, [null, result]);
      };
      return binding.mkdtemp(prefix, 'buffer', request);
    },
  };
  return { ...factories.temp({ process, path, values, utils, truncation, native,
    codecs: bytes.codecs, removal }), calls, truncation, Buffer: bytes.Buffer };
};
