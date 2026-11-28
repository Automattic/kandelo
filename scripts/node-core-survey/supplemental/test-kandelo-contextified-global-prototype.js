'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');

const sandbox = { label: 'sandbox' };
const sandboxPrototype = Object.getPrototypeOf(sandbox);
const first = vm.createContext(sandbox);
const second = vm.createContext({});
const plain = vm.createContext(vm.constants.DONT_CONTEXTIFY);

function verifyGlobal(contextified) {
  const prototype = Object.getPrototypeOf(globalThis);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  const constructor = descriptor?.value;
  return (
    Object.getPrototypeOf(prototype) === Object.prototype &&
    Reflect.ownKeys(prototype).length === 1 &&
    descriptor?.writable === true &&
    descriptor?.enumerable === false &&
    descriptor?.configurable === true &&
    Object.getPrototypeOf(constructor) === Function.prototype &&
    (constructor === Object) === !contextified &&
    (constructor.prototype === prototype) === contextified &&
    globalThis instanceof constructor &&
    Object.getPrototypeOf(new constructor()) === constructor.prototype
  );
}

const compare = '(' + verifyGlobal.toString() + ')';
assert.strictEqual(verifyGlobal(false), true);
assert.strictEqual(vm.runInContext(compare + '(false)', plain), true);
assert.strictEqual(vm.runInContext(compare + '(true)', first), true);
assert.strictEqual(vm.runInContext(compare + '(true)', second), true);

const constructorSource = 'Object.getPrototypeOf(globalThis).constructor';
const firstConstructor = vm.runInContext(constructorSource, first);
const secondConstructor = vm.runInContext(constructorSource, second);
assert.strictEqual(vm.runInContext(constructorSource, first), firstConstructor);
assert.notStrictEqual(firstConstructor, secondConstructor);
assert.notStrictEqual(firstConstructor.prototype, secondConstructor.prototype);
assert.strictEqual(vm.runInContext('label', first), 'sandbox');
vm.runInContext('label = "updated"', first);
assert.strictEqual(sandbox.label, 'updated');
assert.strictEqual(Object.getPrototypeOf(sandbox), sandboxPrototype);
