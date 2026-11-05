'use strict';
// Candidate public Module/record/require source only. Native Node still owns
// the upstream test, assert/common, VM/filesystem/URL/environment boundaries.
const Module = require('node:module');
const candidate = require('./node-module-records.cjs').create();
const load = Module._load;
Module._load = function(name) {
  if (name === 'module' || name === 'node:module') return candidate.Module;
  return Reflect.apply(load, this, arguments);
};
