'use strict';
const common = require('../common');
const assert = require('node:assert/strict');
const { runInNewContext } = require('node:vm');
const { Worker } = require('node:worker_threads');

const probe = `(() => {
  const authored = function preserved(argument) { return argument; };
  const receivers = [
    Date,
    Math.abs,
    Function.prototype,
    Object.getOwnPropertyDescriptor(Map.prototype, 'size').get,
    Object.getOwnPropertyDescriptor(Object.prototype, '__proto__').set,
    Date.bind(null),
    new Proxy(Date, {}),
    authored,
  ];
  return receivers.map((receiver) => Function.prototype.toString.call(receiver));
})()`;

const expected = [
  'function Date() { [native code] }',
  'function abs() { [native code] }',
  'function () { [native code] }',
  'function get size() { [native code] }',
  'function set __proto__() { [native code] }',
  'function () { [native code] }',
  'function () { [native code] }',
  'function preserved(argument) { return argument; }',
];

assert.deepEqual(eval(probe), expected);
assert.deepEqual(Array.from(runInNewContext(probe)), expected);

const worker = new Worker(`
  const { parentPort } = require('node:worker_threads');
  parentPort.postMessage(${probe});
`, { eval: true });
worker.once('message', common.mustCall((result) => assert.deepEqual(result, expected)));
worker.once('exit', common.mustCall((status) => assert.equal(status, 0)));
