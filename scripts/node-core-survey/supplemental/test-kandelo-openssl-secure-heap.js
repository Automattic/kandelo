'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const probe = `
  const crypto = require('node:crypto');
  const dh = crypto.getDiffieHellman('modp14');
  dh.generateKeys();
  const heap = crypto.secureHeapUsed();
  console.log(JSON.stringify(heap, (_, value) => Number.isNaN(value) ? 'NaN' : value));`;
const guest = process.arch === 'wasm32';

for (const requested of [false, true]) {
  const flags = requested ? ['--secure-heap=65536', '--secure-heap-min=4'] : [];
  const result = spawnSync(process.execPath, [...flags, '-e', probe], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, requested && guest ? 'Unable to initialize openssl secure heap.\n' : '');
  const heap = JSON.parse(result.stdout);
  assert.equal(heap.total, requested ? 65536 : 0);
  assert.equal(heap.min, requested ? 4 : 2);
  if (requested && !guest) {
    assert.ok(heap.used > 0);
    assert.equal(heap.utilization, heap.used / heap.total);
  } else {
    assert.equal(heap.used, 0);
    assert.equal(heap.utilization, requested ? 0 : 'NaN');
  }
  console.log(JSON.stringify({ arch: process.arch, requested, heap, stderr: result.stderr }));
}
