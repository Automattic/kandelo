'use strict';

require('../common');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const receiver = {};
function collect(...args) {
  assert.strictEqual(this, receiver);
  return args;
}

for (const args of [[], [undefined], [0, false], [1, 2, 3], [4, 5, 6, 7]]) {
  assert.deepStrictEqual(Reflect.apply(collect, receiver, args), args);
}

// Applying an array-like object reads the length and the indexed values in order.
const reads = [];
const list = {
  get length() { reads.push('length'); return 2; },
  get 0() { reads.push(0); return 'a'; },
  get 1() { reads.push(1); return 'b'; },
};
assert.deepStrictEqual(Reflect.apply(collect, receiver, list), ['a', 'b']);
assert.deepStrictEqual(reads, ['length', 0, 1]);
const sparse = new Array(2);
Object.setPrototypeOf(sparse, { 1: 'inherited' });
assert.deepStrictEqual(Reflect.apply(collect, receiver, sparse), [undefined, 'inherited']);

const sentinel = new Error('from callback');
assert.throws(() => Reflect.apply(() => { throw sentinel; }, receiver, []),
              (caught) => caught === sentinel);
let called = false;
assert.throws(() => Reflect.apply(() => { called = true; }, receiver,
                                 { length: 1, get 0() { throw sentinel; } }),
              (caught) => caught === sentinel);
assert.strictEqual(called, false);

const foreign = vm.runInNewContext('({ args: [2, 3], sum(a, b) { return this.base + a + b; } })');
assert.strictEqual(Reflect.apply(foreign.sum, { base: 1 }, foreign.args), 6);
const tagged = new Proxy(collect, {
  apply(target, thisArg, args) {
    assert.strictEqual(thisArg, receiver);
    assert.deepStrictEqual(args, [1, 2]);
    return Reflect.apply(target, thisArg, args);
  },
});
assert.deepStrictEqual(Reflect.apply(tagged, receiver, [1, 2]), [1, 2]);
