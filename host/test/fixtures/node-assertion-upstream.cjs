'use strict';
const Module = require('node:module');
const core = require('./node-assertion-platform.cjs').create();
const load = Module._load;
// Redirect subject modules only. Upstream files and their common harness stay
// unchanged; native node:test/inspection/engine dependencies remain explicit.
Module._load = function(request, parent, isMain) {
  if (request === 'assert' || request === 'node:assert') return core.assert;
  if (request === 'assert/strict' || request === 'node:assert/strict') return core.assert.strict;
  if (request === 'internal/assert/assertion_error' || request === 'internal/assert/myers_diff') return core.require(request);
  return Reflect.apply(load, this, [request, parent, isMain]);
};
