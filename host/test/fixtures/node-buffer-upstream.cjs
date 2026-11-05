'use strict';
// Run unchanged upstream assertions with actual candidate public Buffer source.
// Node still owns assert/common, the JS engine and all non-Buffer internals.
const Module = require('node:module');
const native = require('node:buffer');
const candidate = require('./node-buffer-codecs.cjs').create();
const api = { ...native, Buffer: candidate.Buffer, isLatin1: candidate.isLatin1 };
const load = Module._load;
globalThis.Buffer = candidate.Buffer;
Module._load = function(request) {
  if (request === 'buffer' || request === 'node:buffer') return api;
  return Reflect.apply(load, this, arguments);
};
