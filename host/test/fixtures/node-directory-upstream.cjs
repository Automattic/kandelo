'use strict';
// Only selected directory APIs are candidate code. All remaining fs methods,
// Node engine/requests/assert/common and POSIX backends are native controls.
const Module = require('node:module');
const native = require('node:fs');
const candidate = require('./node-directory-platform.cjs').create();
const promises = { ...native.promises, ...candidate.promises };
const api = { ...native, ...candidate.api, promises };
const load = Module._load;
Module._load = function(name) {
  if (name === 'fs' || name === 'node:fs') return api;
  if (name === 'fs/promises' || name === 'node:fs/promises') return promises;
  return Reflect.apply(load, this, arguments);
};
