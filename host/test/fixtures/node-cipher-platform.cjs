'use strict';
// Candidate pinned public classes, native bridge adapters and codecs. Actual
// Node private cipher/key/stream owners are explicit dependency controls.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util');
const saved = ['internalBinding', 'primordials'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const raw = require('internal/test/binding').internalBinding('crypto');
for (const [key, descriptor] of saved) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
}
const methods = Object.fromEntries(['update', 'final', 'getAuthTag', 'setAuthTag', 'setAAD', 'setAutoPadding']
  .map(name => [name, raw.CipherBase.prototype[name]]));
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return { values:_createNodeValuesPlatform, digest:_createNodeCryptoDigest, cipher:_createNodeCipherPlatform };')();
exports.create = function create() {
  const storage = require('./node-buffer-codecs.cjs').create();
  const values = factories.values({ process, Buffer: storage.Buffer, util, inspection: util,
    os: require('node:os'), signals: require('node:os').constants.signals, getDOMException: () => DOMException });
  let helpers;
  factories.digest({ values, Buffer: storage.Buffer, types: util.types, native: {}, captureHelpers(value) { helpers = value; } });
  const native = { cipherOperation(op, ...args) {
    try {
      let value;
      if (op === 'constants') value = require('node:crypto').constants;
      else if (op === 'new') {
        function Target() {} Target.prototype = args[0];
        value = Reflect.construct(raw.CipherBase, args.slice(1), Target);
      } else if (op === 'info') value = raw.getCipherInfo(...args);
      else if (op === 'list') value = raw.getCiphers();
      else if (op === 'encoding') value = args[0] === 'buffer' ? 'buffer' : values.util.normalizeEncoding(args[0]) || 'utf8';
      else {
        const method = { padding: 'setAutoPadding', getTag: 'getAuthTag', setTag: 'setAuthTag', aad: 'setAAD' }[op] || op;
        if (!methods[method]) throw Error('Uncontrolled cipher operation: ' + op);
        value = Reflect.apply(methods[method], args[0], args.slice(1));
      }
      return { value, error: undefined };
    } catch (error) {
      // Current native owners carry genuine Error objects, not flattened
      // records. Preserve the native value/identity and inherited metadata.
      // Undefined cannot be represented by the packet's no-error marker.
      if (error === undefined) throw error;
      return { error, value: undefined };
    }
  } };
  const api = factories.cipher({constants:{crypto:require('node:crypto').constants},  native, values, codecs: storage.codecs, types: util.types,
    keys: require('internal/crypto/keys'), digestHelpers: helpers, kHandle: Symbol('kHandle'),
    stringDecoder: require('node:string_decoder'), streams: { require(name) {
      if (name !== 'internal/streams/lazy_transform') throw Error(name);
      return require(name);
    } } });
  return { ...api, Buffer: storage.Buffer };
};
