'use strict';
// Native-reference control for the real internal Private key contract.
// This requires --expose-internals; it is not a replacement key implementation.
const assert = require('node:assert/strict');
const { internalBinding } = require('internal/test/binding');
const { markAsUntransferable, isMarkedAsUntransferable } = require('node:worker_threads');
const { privateSymbols } = internalBinding('util');
const key = privateSymbols.transfer_mode_private_symbol;
const observations = [];
let failures = 0;
function check(name, callback) {
  try {
    const detail = callback();
    observations.push({ name, status: 'pass', detail });
  } catch (error) {
    failures++;
    observations.push({ name, status: 'fail', error: { name: error.name, message: error.message, code: error.code } });
  }
}
check('native-private-key-identity', () => {
  assert.equal(typeof key, 'symbol');
  assert.equal(Symbol.keyFor(key), undefined);
  assert.notEqual(key, Symbol('node:transfer_mode'));
});
check('hidden-from-normal-reflection', () => {
  const object = {};
  object[key] = 2;
  assert.equal(object[key], 2);
  assert.deepEqual(Reflect.ownKeys(object), []);
  assert.deepEqual(Object.getOwnPropertySymbols(object), []);
});
check('private-state-is-not-inherited', () => {
  const parent = {};
  parent[key] = 2;
  const child = Object.create(parent);
  assert.equal(child[key], undefined);
  child[key] = 3;
  assert.equal(parent[key], 2);
  assert.equal(child[key], 3);
});
check('new-private-write-after-prevent-extensions', () => {
  const object = Object.preventExtensions({});
  object[key] = 2;
  assert.equal(object[key], 2);
  assert.equal(Object.isExtensible(object), false);
});
check('private-write-and-update-after-freeze', () => {
  const object = Object.freeze({});
  object[key] = 2;
  object[key] = 3;
  assert.equal(object[key], 3);
  assert.equal(Object.isFrozen(object), true);
});
check('private-default-descriptor', () => {
  const object = {};
  object[key] = 2;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  assert.equal(descriptor.value, 2);
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.configurable, true);
});
check('missing-private-proxy-read-bypasses-trap', () => {
  let reads = 0;
  const proxy = new Proxy({}, { get() { reads++; throw new Error('unexpected get trap'); } });
  assert.equal(proxy[key], undefined);
  assert.equal(reads, 0);
});
check('first-private-proxy-write-rejects-without-trap', () => {
  let writes = 0;
  const proxy = new Proxy({}, { set() { writes++; return true; } });
  assert.throws(() => { proxy[key] = 2; }, TypeError);
  assert.equal(writes, 0);
});
check('absent-private-proxy-delete-bypasses-trap', () => {
  let deletes = 0;
  const proxy = new Proxy({}, { deleteProperty() { deletes++; throw new Error('unexpected delete trap'); } });
  assert.equal(delete proxy[key], true);
  assert.equal(deletes, 0);
});
check('public-untransferable-marker-is-own-only', () => {
  const parent = {};
  markAsUntransferable(parent);
  assert.equal(isMarkedAsUntransferable(parent), true);
  assert.equal(isMarkedAsUntransferable(Object.create(parent)), false);
});
check('public-untransferable-marker-on-frozen-object', () => {
  const object = Object.freeze({});
  markAsUntransferable(object);
  assert.equal(isMarkedAsUntransferable(object), true);
  assert.equal(Object.isFrozen(object), true);
});
process.stdout.write(JSON.stringify({
  kind: 'native-reference-only', version: process.version,
  platform: process.platform, arch: process.arch, execArgv: process.execArgv,
  v8: process.versions.v8, cases: observations.length, failures, observations,
  limits: ['No SpiderMonkey execution', 'No native SetPrivate or initialized-proxy delete coverage',
    'No cross-realm/security-wrapper/revoked-proxy/GC coverage', 'Not full private-key or core-module conformance'],
}) + '\n');
process.exitCode = failures ? 1 : 0;
