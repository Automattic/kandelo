'use strict';
// Inject candidate public algorithms only. Upstream test/common/assert source
// stays unchanged; real native Node request/engine/OS boundaries remain explicit.
const Module = require('node:module');
const { createDnsPlatform } = require('./node-dns-platform.cjs');
const load = Module._load;
let candidate;
function getCandidate() { return candidate ??= createDnsPlatform(); }
Module._load = function(request, parent, isMain) {
  if (request === 'dns' || request === 'node:dns') return getCandidate().api;
  if (request === 'dns/promises' || request === 'node:dns/promises') return getCandidate().promises;
  return Reflect.apply(load, this, arguments);
};
process.once('exit', () => { if (candidate) candidate.close(); });
