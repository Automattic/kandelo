'use strict';

const assert = require('node:assert/strict');
const { kMaxLength } = require('node:buffer');
const vm = require('node:vm');
const { Worker, isMainThread } = require('node:worker_threads');

function check(assert, limit) {
  for (const ArrayType of [Uint8Array, Int32Array, Float64Array]) {
    for (const length of [-1, -1.5, Infinity, -Infinity, ' -01.5 ', limit + 1]) {
      assert.throws(() => new ArrayType(length), {
        name: 'RangeError',
        message: 'Invalid typed array length: ' + String(length),
      });
    }
    assert.equal(new ArrayType(-0.5).length, 0);
    assert.equal(new ArrayType('2.9').length, 2);
    for (const length of [1n, Symbol('length')]) {
      assert.throws(() => new ArrayType(length), { name: 'TypeError' });
    }
    const error = new Error('length getter');
    assert.throws(() => new ArrayType({ get length() { throw error; } }),
                  (caught) => caught === error);
  }
}

check(assert, kMaxLength);
if (isMainThread) {
  vm.runInNewContext('(' + check.toString() + ')(assert, limit)',
                     { assert, limit: kMaxLength });
  new Worker(__filename).once('exit', (code) => assert.equal(code, 0));
}
