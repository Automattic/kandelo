'use strict';
// Only temporary/disposable APIs and their candidate codec/removal consumers
// are replaced. Other fs APIs, common helpers and engine remain native controls.
const Module = require('node:module');
const native = require('node:fs');
const candidate = require('./node-tempdir-platform.cjs').create();
// This control deliberately preloads Node's private FSReq boundary. Its
// own exact warning must be expected independently of warnings from the
// unchanged test; common still rejects every unexpected warning.
const common = require(require('node:path').resolve(require('node:path').dirname(process.argv[1]), '../common'));
common.expectWarning('internal/test/binding', 'These APIs are for internal testing only. Do not use them.');
const promises = { ...native.promises, ...candidate.promises };
const api = { ...native, ...candidate.api, promises };
const load = Module._load;
Module._load = function(name) {
  if (name === 'fs' || name === 'node:fs') return api;
  if (name === 'fs/promises' || name === 'node:fs/promises') return promises;
  return Reflect.apply(load, this, arguments);
};
