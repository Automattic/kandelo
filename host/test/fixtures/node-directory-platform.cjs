'use strict';
// Candidate pinned public wrappers, with actual native Node request/OS bindings
// as explicit control boundaries. The guest header/JSAPI is tested separately.
const { readFileSync } = require('node:fs');
const nativeFs = require('node:fs');
const nativeUtil = require('node:util');
const { resolve } = require('node:path');
const { fileURLToPath } = require('node:url');
// Node's test binding deliberately publishes two globals during preload.
// This fixture needs only the returned private handle; restore the surrounding
// realm before the unchanged upstream leak assertion inspects public globals.
const bindingGlobals = ['internalBinding', 'primordials'].map(name =>
  [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
const { internalBinding } = require('internal/test/binding');
for (const [name, descriptor] of bindingGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}
const binding = internalBinding('fs');
const root = resolve(__dirname, '../../..');
const source = readFileSync(resolve(root, 'third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return { values:_createNodeValuesPlatform, stats:_createNodeFsStats, directory:_createNodeDirectoryPlatform };')();
exports.create = function create() {
  const values = factories.values({ process, Buffer, util: nativeUtil, inspection: nativeUtil,
    uv: { binding: internalBinding('uv') }, os: require('node:os'),
    signals: require('node:os').constants.signals, getDOMException: () => DOMException });
  const truncation = { vfsState: { handlers: null }, FSReqCallback: binding.FSReqCallback,
    makeError(status, syscall, path) { return new values.errors.UVException({ errno: status,
      code: nativeUtil.getSystemErrorName(status), syscall, path }); } };
  const utils = factories.stats({ fs: nativeFs, process, Buffer, types: nativeUtil.types, values,
    truncation, native: {}, permissionEnabled: () => false,
    toPathIfFileURL: path => path instanceof URL ? fileURLToPath(path) : path });
  const calls = [];
  const native = {
    fsPathSync(name, path, mode, recursive) {
      calls.push({ name, mode, recursive, async: false });
      try { return name === 'mkdir' ? binding.mkdir(path, mode, recursive) : binding[name](path); }
      catch (error) { if (typeof error.errno !== 'number') throw error; return error.errno; }
    },
    fsPathPromise(name, path, mode, recursive, request) {
      calls.push({ name, mode, recursive, async: true });
      const owner = typeof request === 'function' ? binding.kUsePromises : request;
      return name === 'mkdir' ? binding.mkdir(path, mode, recursive, owner) : binding[name](path, owner);
    },
  };
  return { ...factories.directory({ values, utils, truncation, native }), calls, truncation };
};
