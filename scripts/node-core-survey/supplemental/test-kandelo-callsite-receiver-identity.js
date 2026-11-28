'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');

Error.prepareStackTrace = (_, sites) => sites;
function capture() {
  return new Error().stack[0];
}
function invoke(object) {
  return object.run();
}
class First {}
class Second {}
const a = Object.assign(new First(), { run: capture });
const b = Object.assign(new Second(), { run: capture });
const sites = [a, b].map(invoke);
const names = (frame) => [frame.getFunctionName(), frame.getTypeName(), frame.getMethodName()];
assert.deepEqual(names(sites[0]), ['capture', 'First', 'run']);
assert.deepEqual(names(sites[1]), ['capture', 'Second', 'run']);
delete a.run;
a.renamed = capture;
assert.deepEqual(names(sites[0]), ['capture', 'First', 'renamed']);
assert.match(sites[0].toString(), /^First\.capture \[as renamed\] \(/);
assert.deepEqual(names(sites[1]), ['capture', 'Second', 'run']);
a.another = capture;
assert.equal(sites[0].getMethodName(), null);
Object.defineProperty(a, 'capture', { value: capture });
assert.equal(sites[0].getMethodName(), 'capture');

let calls = 0;
Object.defineProperty(b, 'unrelated', { enumerable: true, get() { ++calls; } });
assert.equal(sites[1].getMethodName(), 'run');
const getter = Object.getOwnPropertyDescriptor({ get value() { return new Error().stack[0]; } }, 'value').get;
Object.defineProperty(b, 'value', { get: getter });
assert.equal(b.value.getMethodName(), 'value');
const proxy = new Proxy({}, {
  getOwnPropertyDescriptor() { ++calls; },
  ownKeys() { ++calls; return []; },
  getPrototypeOf() { ++calls; return null; },
});
const proxied = capture.call(proxy);
assert.equal(proxied.getTypeName(), 'Proxy');
assert.equal(proxied.getMethodName(), null);
assert.equal(calls, 0);
const other = vm.runInNewContext('({ run: capture })', { capture });
assert.deepEqual(names(invoke(other)), ['capture', 'Object', 'run']);
