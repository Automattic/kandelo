'use strict';
const common = require('../common');
const assert = require('node:assert/strict');
const { runInNewContext } = require('node:vm');
const { Worker } = require('node:worker_threads');

function observeCoercions() {
  const value = Symbol('coercion');
  const operations = [
    () => '' + value,
    () => new RegExp(value),
    () => String(Object(value)),
  ];
  return [
    String(value),
    value.toString(),
    ...operations.map((convert) => {
      try {
        convert();
        return null;
      } catch (error) {
        return [error.name, error.message];
      }
    }),
  ];
}

const error = ['TypeError', 'Cannot convert a Symbol value to a string'];
const expected = ['Symbol(coercion)', 'Symbol(coercion)', error, error, error];
const expression = `(${observeCoercions.toString()})()`;
assert.deepEqual(observeCoercions(), expected);
assert.deepEqual(runInNewContext(`JSON.stringify(${expression})`), JSON.stringify(expected));

const worker = new Worker(`
  const { parentPort } = require('node:worker_threads');
  parentPort.postMessage(${expression});
`, { eval: true });
worker.once('message', common.mustCall((result) => assert.deepEqual(result, expected)));
worker.once('exit', common.mustCall((status) => assert.equal(status, 0)));
