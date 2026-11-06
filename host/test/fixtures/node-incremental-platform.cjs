'use strict';
// Candidate public classes/codecs over native Node digest and stream owners.
// This is a source differential control, not guest JSAPI/GC/worker evidence.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util');
const { execFileSync } = require('node:child_process');
const { internalBinding } = require('internal/test/binding');
const binding = internalBinding('crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return { values:_createNodeValuesPlatform, digest:_createNodeCryptoDigest,' +
  ' incremental:_createNodeIncrementalCrypto, inspection:_createNodeInspection, primordials:_createNodePrimordials };')();
exports.create = function create() {
  const storage = require('./node-buffer-codecs.cjs').create();
  const warnings = [];
  // Install the actual pinned Buffer inspection owner omitted by the fixed
  // storage fixture. Metadata still comes from native Node in this control.
  const inspection = factories.inspection({ Buffer: storage.Buffer,
    native: { ...internalBinding('util'), ...util.types, hasObjectKind(value, kind) {
      const name = { Arguments: 'isArgumentsObject', AsyncFunction: 'isAsyncFunction',
        GeneratorFunction: 'isGeneratorFunction', GeneratorObject: 'isGeneratorObject',
        MapIterator: 'isMapIterator', SetIterator: 'isSetIterator', ModuleNamespace: 'isModuleNamespaceObject' }[kind];
      if (name) return util.types[name](value);
      throw Error('Uncontrolled engine metadata: ' + kind);
    } }, isBuiltin: require('node:module').isBuiltin, getURL: () => URL,
    pathToFileURL: require('node:url').pathToFileURL });
  const values = factories.values({ process: { platform: process.platform, emitWarning(...args) { warnings.push(args); } },
    Buffer: storage.Buffer, util, inspection, os: require('node:os'),
    signals: require('node:os').constants.signals, getDOMException: () => DOMException });
  let helpers;
  factories.digest({ values, Buffer: storage.Buffer, types: util.types, native: {},
    captureHelpers(value) { helpers = value; } });
  const parser = process.env.KANDELO_INCREMENTAL_NATIVE_HELPER;
  const native = { incrementalHash(operation, ...args) {
    try {
      let value;
      if (operation === 'encoding') {
        const [encoding, bufferDefault] = args;
        if (typeof encoding !== 'string') value = bufferDefault ? 'buffer' : 'utf8';
        else if (parser) value = execFileSync(parser, ['encoding', Buffer.from(encoding).toString('hex'), bufferDefault ? 'buffer' : 'utf8'],
          { encoding: 'utf8', timeout: 5000 }).trim();
        // The default source-only boundary covers canonical aliases only.
        // Native C++ parser quirks require the explicitly selected helper.
        else value = encoding === 'buffer' ? 'buffer' : values.util.normalizeEncoding(encoding) || (bufferDefault ? 'buffer' : 'utf8');
      } else if (operation === 'create') {
        if (args[2]) throw Error('Digest options are not supported');
        value = new binding.Hash(args[0], args[1], -1, Object.create(null));
      } else if (operation === 'copy') value = new binding.Hash(args[0], args[1], -1, Object.create(null));
      else if (operation === 'hmac') { value = new binding.Hmac(); value.init(args[0], args[1]); }
      else if (operation === 'update') value = args[0].update(args[1], args[2]);
      else if (operation === 'digest') value = args[0].digest();
      else throw Error('Unknown control operation');
      return { value, error: undefined };
    } catch (error) {
      const record = { message: error.message };
      for (const key of ['code', 'library', 'reason', 'opensslErrorStack'])
        if (Object.hasOwn(error, key)) record[key] = error[key];
      return { error: record, value: undefined };
    }
  } };
  const lazy = { exports: {} };
  const lazySource = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/upstream/incremental-crypto/lib/internal/streams/lazy_transform.js'), 'utf8');
  Function('primordials', 'require', 'module', lazySource)(factories.primordials(), require, lazy);
  const streams = { require(name) {
    if (name !== 'internal/streams/lazy_transform') throw Error('Unexpected stream dependency');
    return lazy.exports;
  } };
  const candidate = factories.incremental({ values, Buffer: storage.Buffer, types: util.types,
    native, codecs: storage.codecs, streams, digestHelpers: helpers });
  return { ...candidate.api, Buffer: storage.Buffer, warnings };
};
