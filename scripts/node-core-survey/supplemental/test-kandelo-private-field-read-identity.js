'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');

class Holder {
  #π = 11;
  static #value = 22;

  static read(receiver) { return receiver.#π; }
  static readStatic(receiver) { return receiver.#value; }
  static has(receiver) { return #π in receiver; }
  static readFromEval(receiver) { return eval('receiver.#π'); }
}

class Other {
  #π = 33;
  read() { return this.#π; }
}
class Derived extends Holder {}

const holder = new Holder();
const other = new Other();
const missingField = {
  name: 'TypeError',
  message: 'Cannot read private member #π from an object whose class did not declare it',
};

assert.equal(Holder.read(holder), 11);
assert.equal(Holder.read(new Derived()), 11);
assert.equal(other.read(), 33);
assert.equal(Holder.has(holder), true);
assert.equal(Holder.has(other), false);
assert.equal(Holder.readStatic(Holder), 22);
assert.throws(() => Holder.readStatic(Derived), {
  name: 'TypeError',
  message: 'Cannot read private member #value from an object whose class did not declare it',
});
assert.throws(() => Holder.read(other), missingField);
assert.throws(() => Holder.read(Object.create(holder)), missingField);
assert.throws(() => Holder.read(1), missingField);
assert.throws(() => Holder.read(null), {
  name: 'TypeError',
  message: "Cannot read properties of null (reading '#π')",
});
assert.throws(() => Holder.read(undefined), {
  name: 'TypeError',
  message: "Cannot read properties of undefined (reading '#π')",
});
assert.equal(Holder.readFromEval(holder), 11);
assert.throws(() => Holder.readFromEval(other), missingField);

const proxy = new Proxy(holder, {
  getOwnPropertyDescriptor() { assert.fail('Private read consulted proxy traps'); },
});
assert.equal(Holder.has(proxy), false);
assert.throws(() => Holder.read(proxy), missingField);

const source = `(() => {
  class Cached {
    #value = 42;
    read() { return this.#value; }
  }
  const item = new Cached();
  try {
    item.read.call({});
  } catch (error) {
    return [item.read(), error.name, error.message].join('|');
  }
})()`;
const first = new vm.Script(source);
const second = new vm.Script(source, { cachedData: first.createCachedData() });
const expected =
  '42|TypeError|Cannot read private member #value from an object whose class did not declare it';
assert.equal(second.cachedDataRejected, false);
assert.equal(first.runInNewContext(), expected);
assert.equal(second.runInNewContext(), expected);
