// Flags: --expose-gc
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const receiver = {};
const marker = {};

function collect(first, second, third) {
  return [this, arguments.length, first, second, third, ...Array.from(arguments).slice(3)];
}
for (const args of [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, marker, 5]]) {
  const expected = [receiver, args.length, args[0], args[1], args[2], ...args.slice(3)];
  assert.deepEqual(Reflect.apply(collect, receiver, args), expected);
  assert.deepEqual(collect.apply(receiver, args), expected);
  const object = { collect };
  assert.deepEqual(object.collect(...args), [object, ...expected.slice(1)]);
}

// Apply reads indexed properties, while spread consumes the iterator.
const indexed = [, 2];
const seen = [];
Object.setPrototypeOf(indexed, Object.create(Array.prototype, {
  0: { get() { seen.push(0); return marker; } },
}));
assert.equal(Reflect.apply(collect, receiver, indexed)[2], marker);
assert.deepEqual(seen, [0]);
const iterable = [1, 2];
iterable[Symbol.iterator] = function*() { yield marker; };
assert.equal(collect(...iterable)[2], marker);
assert.equal(Reflect.apply(collect, receiver, iterable)[2], 1);

function descend(depth, mode, value) {
  assert.equal(value, marker);
  if (depth === 0) {
    global.gc();
    if (mode.endsWith('-throw')) throw value;
    return value;
  }
  const args = [depth - 1, mode, value];
  if (mode.startsWith('apply')) return Reflect.apply(descend, receiver, args);
  return descend(...args);
}
for (const mode of ['apply', 'spread']) {
  assert.equal(descend(100, mode, marker), marker);
  assert.throws(() => descend(100, mode + '-throw', marker), (error) => error === marker);
}

for (const route of ['apply', 'spread']) {
  const old = { value: 31 };
  const data = [old, 1, 2];
  function liveArgs(arg) {
    data[0] = null;
    global.gc();
    assert.equal(arg, old);
    assert.equal(arguments[0], old);
    return arguments.length;
  }
  assert.equal(route === 'apply' ? Reflect.apply(liveArgs, null, data) : liveArgs(...data), 3);
}

const foreign = vm.runInNewContext('(function(...args) { return args[2]; })');
assert.equal(Reflect.apply(foreign, null, [0, 1, marker]), marker);
assert.equal(foreign(...[0, 1, marker]), marker);
class Box { constructor(value) { this.value = value; } }
assert.equal(new Box(...[marker]).value, marker);
assert.throws(() => Reflect.apply(Box, null, []), TypeError);
assert.throws(() => Box(...[]), TypeError);
function* values(...args) { yield* args; }
assert.deepEqual([...values(...[marker, 2])], [marker, 2]);
