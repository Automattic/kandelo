'use strict';
// Real candidate factories; native Node supplies engine brands, error
// inspection and fixed-storage allocation in this source-level control.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util');
const { constants } = require('node:buffer');
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return { values:_createNodeValuesPlatform, decoder:_createNodeStringDecoder };')();
exports.environment = function environment(options = {}) {
  const storage = options.storage || require('./node-buffer-codecs.cjs').create();
  const values = factories.values({ process, Buffer: storage.Buffer, util, inspection: util,
    os: require('node:os'), signals: require('node:os').constants.signals,
    getDOMException: () => DOMException });
  return { Buffer: storage.Buffer, _createNodeStringDecoder: factories.decoder,
    _nodeValues: values, _nodeBufferCodecs: storage.codecs,
    _nodeBufferConstants: { MAX_STRING_LENGTH: options.kStringMaxLength ?? constants.MAX_STRING_LENGTH } };
};
exports.create = function create(options = {}) {
  const env = exports.environment(options);
  return { ...factories.decoder({ Buffer: env.Buffer, values: env._nodeValues,
    codecs: env._nodeBufferCodecs, kStringMaxLength: env._nodeBufferConstants.MAX_STRING_LENGTH }),
    Buffer: env.Buffer };
};
