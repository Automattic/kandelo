'use strict';
// Full candidate pinned key wrappers over actual native26 key handles and base
// classes. No fake key material/brands, guest slots or four-host claim.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util');
const { internalBinding } = require('internal/test/binding');
const raw = internalBinding('crypto'), nativeCrypto = require('node:crypto');
const NativeKeyObject = Object.getPrototypeOf(nativeCrypto.KeyObject);
const NativeCryptoKey = Object.getPrototypeOf(require('internal/crypto/keys').InternalCryptoKey);
const nativeKeyMethods = Object.fromEntries(Object.getOwnPropertyNames(raw.KeyObjectHandle.prototype)
  .filter(name => name !== 'constructor').map(name => [name, raw.KeyObjectHandle.prototype[name]]));
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return { values:_createNodeValuesPlatform, digest:_createNodeCryptoDigest,' +
  ' keys:_createNodeCryptoKeys, inspection:_createNodeInspection, core:_createNodeCore };')();
exports.create = function create(options = {}) {
  const storage = require('./node-buffer-codecs.cjs').create();
  const inspection = factories.inspection({ Buffer: storage.Buffer,
    native: { ...internalBinding('util'), ...util.types, hasObjectKind(value, kind) {
      const name = { Arguments: 'isArgumentsObject', AsyncFunction: 'isAsyncFunction',
        GeneratorFunction: 'isGeneratorFunction', GeneratorObject: 'isGeneratorObject',
        MapIterator: 'isMapIterator', SetIterator: 'isSetIterator', ModuleNamespace: 'isModuleNamespaceObject' }[kind];
      if (name) return util.types[name](value);
      throw Error('Uncontrolled engine metadata: ' + kind);
    } }, isBuiltin: require('node:module').isBuiltin, getURL: () => URL,
    pathToFileURL: require('node:url').pathToFileURL });
  const values = factories.values({ process: { platform: process.platform, emitWarning() {} },
    Buffer: storage.Buffer, util, inspection, os: require('node:os'),
    signals: require('node:os').constants.signals, getDOMException: () => DOMException });
  let helpers, handlePrototype;
  factories.digest({ values, Buffer: storage.Buffer, types: util.types, native: {},
    captureHelpers(value) { helpers = value; } });
  function construct(Base, prototype, args) {
    function Target() {}
    Target.prototype = prototype;
    return Reflect.construct(Base, args, Target);
  }
  const native = { keyOperation(operation, ...args) {
    if (options.forbidJwkCodecCallbacks && (operation === 'initJwk' || operation === 'exportJwk') && args.length !== 3)
      throw new Error('JWK native operation received a JavaScript codec callback');
    try {
      let value;
      if (operation === 'constants') {
        value = Object.fromEntries(Object.entries(raw).filter(([name]) => /^kKey(Type|Format|Encoding)/.test(name)));
        Object.assign(value, { POINT_CONVERSION_COMPRESSED: nativeCrypto.constants.POINT_CONVERSION_COMPRESSED,
          POINT_CONVERSION_UNCOMPRESSED: nativeCrypto.constants.POINT_CONVERSION_UNCOMPRESSED });
      } else if (operation === 'newHandle') {
        handlePrototype = args[0]; value = construct(raw.KeyObjectHandle, args[0], []);
      } else if (operation === 'newObject') value = construct(NativeKeyObject, args[0], [args[1]]);
      else if (operation === 'newCryptoKey') value = construct(NativeCryptoKey, args[0], args.slice(1));
      else if (operation === 'isKeyObject') value = raw.isKeyObject(args[0]);
      else if (operation === 'isCryptoKey') value = raw.isCryptoKey(args[0]);
      else if (operation === 'slots' || operation === 'cryptoSlots') {
        const isKey = operation === 'slots' ? raw.isKeyObject : raw.isCryptoKey;
        if (isKey(args[0])) {
          value = (operation === 'slots' ? raw.getKeyObjectSlots : raw.getCryptoKeySlots)(args[0]);
          Object.setPrototypeOf(value[operation === 'slots' ? 1 : 4], handlePrototype);
        }
      } else if (operation === 'initJwk') {
        value = Reflect.apply(nativeKeyMethods.init, args[0], [args[1], args[2], raw.kKeyFormatJWK, null, null, null]);
      } else if (operation === 'exportJwk') {
        value = Reflect.apply(nativeKeyMethods.exportJwk, args[0], args.slice(1, 3));
      } else {
        const name = { type: 'getKeyType', size: 'getSymmetricKeySize', asymmetricType: 'getAsymmetricKeyType',
          detail: 'keyDetail', rawPublic: 'rawPublicKey', rawPrivate: 'rawPrivateKey', rawSeed: 'rawSeed',
          ecPublic: 'exportECPublicRaw', ecPrivate: 'exportECPrivateRaw', ecPkcs8: 'exportECPrivatePkcs8', checkEc: 'checkEcKeyData' }[operation] || operation;
        if (!nativeKeyMethods[name]) throw Error('Uncontrolled native operation: ' + operation);
        value = Reflect.apply(nativeKeyMethods[name], args[0], args.slice(1));
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
  const url = require('internal/url');
  const keys = factories.keys({constants:{crypto:require('node:crypto').constants},  values, Buffer: storage.Buffer, types: util.types,
    native, codecs: options.forbidJwkCodecCallbacks ? new Proxy(storage.codecs, {
      get(target, key) {
        if (key === 'fromString' || key === 'decodeBytes')
          throw new Error('JWK reached mutable JavaScript codec: ' + key);
        return Reflect.get(target, key);
      },
    }) : storage.codecs, inspection, digestHelpers: helpers, url });
  // HMAC control consumes the actual native handle directly. Native public JS
  // keys have a different class's private fields and are separate controls.
  const core = factories.core({ process, getValues: () => values,
    Buffer: storage.Buffer, URL, inspect: inspection.inspect,
    format: inspection.format, ...util.types, getCryptoKeys: () => keys,
    hasObjectKind(value, kind) {
      const name = { Arguments: 'isArgumentsObject', AsyncFunction: 'isAsyncFunction',
        GeneratorFunction: 'isGeneratorFunction', GeneratorObject: 'isGeneratorObject',
        MapIterator: 'isMapIterator', SetIterator: 'isSetIterator', ModuleNamespace: 'isModuleNamespaceObject' }[kind];
      if (!name) throw Error('Uncontrolled engine metadata: ' + kind);
      return util.types[name](value);
    } });
  return { ...keys.api, Buffer: storage.Buffer, types: core.types,
    isDeepStrictEqual: core.comparisons.isDeepStrictEqual,
    createHmac(algorithm, key) {
      const handle = keys.isKeyObject(key) ? keys.getKeyObjectHandle(key) : key;
      const hmac = new raw.Hmac(); hmac.init(algorithm, handle);
      return { update(value) { hmac.update(value); return this; }, digest(encoding) {
        const bytes = hmac.digest(); return encoding ? Buffer.from(bytes).toString(encoding) : Buffer.from(bytes);
      } };
    } };
};
