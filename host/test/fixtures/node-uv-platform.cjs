'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const util = require('node:util');
const os = require('node:os');
const root = path.resolve(__dirname, '../../..');
const target = require(path.join(root, 'packages/registry/node-compat/target.json'));
assert.equal(process.versions.node, target.version);
const source = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const factories = Function(`${source}; return { uv: _createNodeUvPlatform, values: _createNodeValuesPlatform };`)();
const uv = factories.uv({ native: { getUvErrorData: () => [...util.getSystemErrorMap()]
  .map(([number, [name, message]]) => [number, name, message]) } });
const values = factories.values({ process: { platform: 'kandelo', emitWarning() { throw Error('Unexpected warning'); } },
  uv, Buffer, util, inspection: util, os, signals: os.constants.signals, getDOMException: () => DOMException });
const native = require('internal/errors');
function fields(error) {
  return { name: error.name, message: error.message, code: error.code, errno: error.errno,
    syscall: error.syscall, hostname: error.hostname, path: error.path, dest: error.dest,
    keys: Object.keys(error), constructor: error.constructor.name };
}
const name = process.argv[2];
if (name === 'dnsNumericErrorFields') {
  for (const code of [-3008, -3007, -3001, -3005, -3006, -3004, 'ECANCELLED', 'ETIMEOUT']) {
    assert.deepEqual(fields(new values.errors.DNSException(code, 'getaddrinfo', 'example.test')),
      fields(new native.DNSException(code, 'getaddrinfo', 'example.test')));
  }
} else if (name === 'uvExceptionMapIsolation') {
  const publicMap = uv.getSystemErrorMap();
  for (const value of publicMap.values()) value[0] = 'mutated';
  publicMap.clear();
  for (const [number] of util.getSystemErrorMap()) {
    const context = { errno: number, syscall: 'open', path: '/fixture-source', dest: '/fixture-target' };
    assert.deepEqual(fields(new values.errors.UVException(context)), fields(new native.UVException(context)));
  }
} else {
  throw Error('Unknown UV control case');
}
console.log(JSON.stringify({ case: name, passed: true,
  scope: 'Candidate error algorithms/UV owner over real native error-data/engine boundaries; no guest engine conformance' }));
