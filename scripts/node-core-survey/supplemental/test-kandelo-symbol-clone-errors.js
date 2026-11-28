'use strict';

require('../common');
const assert = require('node:assert/strict');
const { serialize } = require('node:v8');
const { BroadcastChannel, MessageChannel } = require('node:worker_threads');

const channel = new BroadcastChannel('symbol-clone-errors');
const { port1, port2 } = new MessageChannel();
const toString = Symbol.prototype.toString;

const prefix = 'α'.repeat(56);
const suffix = 'ω'.repeat(56);
const limit = '界'.repeat(128);
const cases = [
  [Symbol(), ''],
  [Symbol('tag'), 'tag'],
  [Symbol('λ'), 'λ'],
  [Symbol('a\u0000b'), 'a\u0000b'],
  [Symbol('\ud800'), '\ud800'],
  [Symbol.iterator, 'Symbol.iterator'],
  [Symbol.for('shared'), 'shared'],
  [Symbol(limit), limit],
  [Symbol(prefix + 'x'.repeat(17) + suffix), prefix + '...<omitted>...' + suffix],
];

try {
  Symbol.prototype.toString = () => assert.fail('Serialization called Symbol.prototype.toString');
  for (const [symbol, description] of cases) {
    const message = `Symbol(${description}) could not be cloned.`;
    assert.throws(() => serialize(symbol), { name: 'Error', message });
    const cloneError = { name: 'DataCloneError', code: 25, message };
    assert.throws(() => structuredClone(symbol), cloneError);
    assert.throws(() => channel.postMessage(symbol), cloneError);
    assert.throws(() => port1.postMessage(symbol), cloneError);
    assert.throws(() => port1.postMessage({ nested: [symbol] }), cloneError);
  }
} finally {
  Symbol.prototype.toString = toString;
  channel.close();
  port1.close();
  port2.close();
}
