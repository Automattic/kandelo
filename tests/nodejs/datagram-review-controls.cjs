'use strict';
// Actual adapter conversion only: no guest/native JSAPI or UDP transport claim.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { FastBuffer } = require('internal/buffer');
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const uncurry = fn => Function.prototype.call.bind(fn);
const intrinsics = Object.fromEntries(['buffer', 'byteOffset', 'byteLength'].map(name =>
    [name, uncurry(Object.getOwnPropertyDescriptor(typed, name).get)]));
const primordials = { ObjectDefineProperty: Object.defineProperty, ReflectApply: Reflect.apply,
    SafeMap: Map, TypeError, ObjectKeys: Object.keys, TypedArrayPrototypeGetBuffer: intrinsics.buffer,
    TypedArrayPrototypeGetByteOffset: intrinsics.byteOffset, TypedArrayPrototypeGetByteLength: intrinsics.byteLength };
const source = fs.readFileSync(path.resolve(__dirname, '../../third_party/node-core/datagram-platform-adapter.js'), 'utf8')
    .replace('/* NODE_DATAGRAM_MODULES */', "'dgram': function(module, require, internalBinding) { module.exports = internalBinding('udp_wrap'); }");
let receive;
const factory = vm.runInNewContext(source + '; _createNodeDatagramPlatform', { _createNodePrimordials: () => primordials });
const platform = { FastBuffer, values: { errors: { codes: { ERR_METHOD_NOT_IMPLEMENTED: Error } } },
    native: { udp(op, ...args) {
        if (op === 'constants') return { AF_INET: 2, AF_INET6: 30 };
        if (op === 'create') return Object.create(args[0]);
        if (op === 'recvStart') { receive = args[1]; return 0; }
        throw Error(op);
    } } };
const { UDP } = factory(platform).api;
const handle = new UDP(); handle.recvStart();
let onmessageGets = 0, poisonedGets = 0;
Object.defineProperty(handle, 'onmessage', { get() { ++onmessageGets; throw Error('bridge reread onmessage'); } });
const results = [];
for (const name of ['buffer', 'byteOffset', 'byteLength']) {
    const descriptor = Object.getOwnPropertyDescriptor(typed, name);
    const bytes = new Uint8Array([11, 22, 33]);
    let delivered;
    Object.defineProperty(typed, name, { configurable: true, get() { ++poisonedGets; throw Error('poisoned ' + name); } });
    try {
        receive(function(nread, actual, message, info) {
            assert.equal(this, handle); assert.equal(actual, handle); assert.equal(nread, 3);
            assert.ok(Buffer.isBuffer(message)); delivered = [message[0], message[1], message[2]];
            assert.equal(info.port, 123);
        }, 3, handle, bytes, { port: 123 });
    } finally { Object.defineProperty(typed, name, descriptor); }
    assert.deepEqual(delivered, [11, 22, 33]); results.push(name);
}
for (const nread of [0, -5]) {
    let called = false;
    receive(function(length, actual, buffer, info) {
        called = true; assert.equal(length, nread); assert.equal(actual, handle);
        if (nread < 0) { assert.equal(buffer, undefined); assert.equal(info, undefined); }
        else { assert.ok(Buffer.isBuffer(buffer)); assert.equal(buffer.length, 0); }
    }, nread, handle, nread < 0 ? undefined : new Uint8Array(), undefined);
    assert.equal(called, true);
}
const failure = Error('actual user callback failure');
assert.throws(() => receive(() => { throw failure; }, 0, handle, new Uint8Array(), {}), error => error === failure);
assert.equal(onmessageGets, 0); assert.equal(poisonedGets, 0);
console.log(JSON.stringify({ suite: 'datagram-adapter-review', source: 'actual adapter converter',
    intrinsicCases: results, zeroAndError: true, resolvedCallbackOnly: true, userExceptionPreserved: true,
    nativeJsapi: 'uncompiled/unvalidated', node: process.version }));
