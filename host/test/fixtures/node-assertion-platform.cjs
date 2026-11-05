'use strict';
// Candidate assertion/error/diff/validator algorithms. Native inspection and
// intrinsic brands are explicit dependencies, not substitutes for these owners.
const fs = require('node:fs'), path = require('node:path');
const util = require('node:util'), os = require('node:os');
const bundle = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(bundle + ';return { core:_createNodeCore, types:_createNodeCoreTypes, values:_createNodeValuesPlatform, primordials:_createNodePrimordials };')();
exports.create = function create({ noCapture = false } = {}) {
  let createCore = factories.core, createValues = factories.values;
  if (noCapture) {
    const descriptors = Object.getOwnPropertyDescriptors(factories.primordials());
    descriptors.ErrorCaptureStackTrace = { value: undefined };
    const primordials = Object.create(null, descriptors);
    const getPrimordials = () => primordials;
    createCore = Function('_createNodeCoreTypes', '_createNodePrimordials', 'return ' + factories.core.toString())(factories.types, getPrimordials);
    createValues = Function('_createNodePrimordials', 'return ' + factories.values.toString())(getPrimordials);
  }
  const core = createCore({ process, getValues: () => values,
    Buffer, URL, inspect: util.inspect, format: util.format, ...util.types,
    hasObjectKind(value, kind) {
      const name = { Arguments: 'isArgumentsObject', AsyncFunction: 'isAsyncFunction',
        GeneratorFunction: 'isGeneratorFunction', GeneratorObject: 'isGeneratorObject',
        MapIterator: 'isMapIterator', SetIterator: 'isSetIterator', ModuleNamespace: 'isModuleNamespaceObject' }[kind];
      if (!name) throw Error('Uncontrolled engine metadata: ' + kind);
      return util.types[name](value);
    } });
  const values = createValues({ process, Buffer, util,
    inspection: { inspect: util.inspect, format: util.format }, os,
    signals: os.constants.signals, getDOMException: () => DOMException });
  return core;
};
