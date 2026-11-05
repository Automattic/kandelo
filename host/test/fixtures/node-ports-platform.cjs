'use strict';
// Explicit native Node queue/serialization/engine boundary. Candidate public
// port/IO/event source runs here; guest native-ports.cpp and its loop do not.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const v8 = require('node:v8'); const wt = require('node:worker_threads');
const nativeMarks = { clone: wt.markAsUncloneable, transfer: wt.markAsUntransferable, markedTransfer: wt.isMarkedAsUntransferable };
const bindingGlobals = ['internalBinding', 'primordials'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const nativeMessaging = require('internal/test/binding').internalBinding('messaging');
for (const [key, descriptor] of bindingGlobals) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
}
const { AsyncResource } = require('node:async_hooks');
const { createNativeAdapter } = require('./node-native-adapter.cjs');
const bundle = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(bundle + '; return { ports: _createNodePortsPlatform, web: _createNodeFormDataPlatform, marks: _createNodeObjectMarks };')();
const handles = new Map();
function info(port) { return handles.get(port); }
const native = {
  objectMark(operation, value) {
    if (operation === 'clone') return nativeMarks.clone(value);
    if (operation === 'transfer') return nativeMarks.transfer(value);
    if (operation === 'markedTransfer') return nativeMarks.markedTransfer(value);
    throw Error('Unknown real native mark operation ' + operation);
  },
  markBufferUntransferable: wt.markAsUntransferable,
  serializeMessage(value, transfer) { return v8.serialize(structuredClone(value, { transfer })); },
  deserializeMessage: packet => v8.deserialize(packet),
  port(op, handle, value) {
    if (op === 'broadcast') {
      const port = nativeMessaging.broadcastChannel(handle);
      handles.set(port, { started: false, closing: false, closeReady: false, acknowledged: false });
      port.on('close', () => { info(port).closeReady = true; });
      return port;
    }
    if (op === 'pair') {
      const pair = new wt.MessageChannel();
      for (const port of [pair.port1, pair.port2]) {
        const state = { started: false, closing: false, closeReady: false, acknowledged: false };
        handles.set(port, state); port.on('close', () => { state.closeReady = true; });
      }
      return [pair.port1, pair.port2];
    }
    const state = info(handle);
    if (op === 'post') return handle.postMessage(value);
    if (op === 'start') { state.started = value; return; }
    if (op === 'ref') { value ? handle.ref() : handle.unref(); return; }
    if (op === 'hasRef') return state.closing ? undefined : handle.hasRef();
    if (op === 'close') { state.closing = true; handle.close(); return; }
    if (op === 'ackClose') { state.acknowledged = true; return; }
    if (op === 'receive') {
      if (state.closeReady && !state.acknowledged) return null;
      if (!value && !state.started) return undefined;
      const packet = wt.receiveMessageOnPort(handle); return packet?.message;
    }
    throw Error('Unknown native boundary op ' + op);
  },
};
let web;
const ports = factories.ports({
  native: createNativeAdapter(native), process, AsyncResource,
  values: { errors: require('internal/errors'), util: require('internal/util') },
  inspection: require('internal/util/inspect'), eventTarget: require('internal/event_target'), DOMException,
  clone: { privateSymbols: { transfer_mode_private_symbol: Symbol('private_native_control_only') } },
  markUncloneable: wt.markAsUncloneable, getMessageEvents: () => web.messageEvents,
});
const io = ports.initialize(require('node:stream'));
const marks = factories.marks({ native: createNativeAdapter(native), isArrayBuffer: require('node:util').types.isArrayBuffer });
web = factories.web({ Blob, File, ReadableStream, URL, URLSearchParams, AbortSignal,
  MessagePort: ports.MessagePort, Event, assert, util: require('node:util'), crypto: require('node:crypto'),
  values: { util: { kEnumerableProperty: { enumerable: true } } },
  clone: { protocol: { markTransferMode: wt.markAsUncloneable } },
});
async function turn() { await new Promise(resolve => setImmediate(resolve)); ports.dispatch(); }
async function close(pair) { pair.port1.close(); pair.port2.close(); await turn(); await turn(); }
const cases = {
  async broadcastSoloAndValidation() {
    const { BroadcastChannel } = io;
    for (const constructor of [BroadcastChannel, wt.BroadcastChannel]) {
      assert.throws(() => new constructor(), { code: 'ERR_MISSING_ARGS' });
      assert.throws(() => new constructor(Symbol('name')), { name: 'TypeError' });
      const channel = new constructor('solo-' + process.pid);
      try {
        assert.equal(channel.name, 'solo-' + process.pid);
        assert.equal(channel.ref(), channel); assert.equal(channel.unref(), channel);
        assert.throws(() => channel.postMessage(), { code: 'ERR_MISSING_ARGS' });
        let getters = 0;
        assert.equal(channel.postMessage({ get value() { getters++; return 1; } }), undefined);
        assert.equal(getters, 1, 'even a group with no recipients serializes once');
        assert.throws(() => channel.postMessage(() => {}), { name: 'DataCloneError' });
        channel.close(); channel.close();
        assert.throws(() => channel.postMessage(1), { name: 'InvalidStateError' });
        assert.equal(channel.ref(), channel); assert.equal(channel.unref(), channel);
      } finally { channel.close(); }
    }
  },
  async broadcastFanoutAndReceive() {
    const name = 'fanout-' + process.pid;
    const channels = [new io.BroadcastChannel(name), new io.BroadcastChannel(name),
      new io.BroadcastChannel(name), new io.BroadcastChannel(name + '-other')];
    const [a, b, c, other] = channels;
    try {
      const seen = [];
      c.onmessage = event => seen.push(event);
      other.onmessage = () => assert.fail('different named group');
      let getters = 0;
      const graph = { get value() { getters++; return { nested: [1, 2], map: new Map([['x', 3n]]) }; } };
      graph.self = graph;
      a.postMessage(graph); assert.equal(getters, 1); assert.equal(seen.length, 0);
      assert.equal(io.receiveMessageOnPort(a), undefined);
      const synchronous = io.receiveMessageOnPort(b).message;
      assert.equal(synchronous.self, synchronous);
      synchronous.value.nested.push(9);
      ports.dispatch(); assert.equal(seen.length, 1);
      const event = seen[0]; assert.equal(event.target, c);
      assert(event instanceof web.messageEvents.MessageEvent);
      assert.equal(event.data.self, event.data);
      assert.deepEqual(event.data.value.nested, [1, 2]);
      assert.equal(event.data.value.map.get('x'), 3n);
      assert.equal(io.receiveMessageOnPort(b), undefined);
      b.close(); a.postMessage('survivor'); ports.dispatch();
      assert.equal(seen.at(-1).data, 'survivor');
      a.close(); c.postMessage('no recipients');
    } finally { channels.forEach(channel => channel.close()); }
  },
  async broadcastNamesAndCoercion() {
    let coerced = 0;
    const prefix = 'names-' + process.pid;
    const a = new io.BroadcastChannel({ toString() { coerced++; return prefix + '\0a'; } });
    const b = new io.BroadcastChannel(prefix + '\0b');
    try {
      assert.equal(coerced, 1); assert.equal(a.name, prefix + '\0a');
      assert.equal(b.name, prefix + '\0b');
      // The pinned native Utf8Value/C-string group key stops at NUL; public
      // name getters preserve the complete coerced JS string independently.
      a.postMessage('same native group');
      assert.deepEqual(io.receiveMessageOnPort(b), { message: 'same native group' });
    } finally { a.close(); b.close(); }
  },
  async broadcastAcrossNativeWorker() {
    const name = 'worker-group-' + process.pid;
    const channel = new io.BroadcastChannel(name);
    const worker = new wt.Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const v8 = require('node:v8');
      const port = require('internal/test/binding').internalBinding('messaging').broadcastChannel(workerData);
      port.on('message', packet => {
        const value = v8.deserialize(packet);
        port.postMessage(v8.serialize({ ack: value.payload }));
        port.close(); parentPort.postMessage('done');
      });
      parentPort.postMessage('ready');
    `, { eval: true, workerData: name, execArgv: ['--expose-internals'] });
    try {
      function message(expected) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('worker handshake timeout')), 5000);
          worker.once('error', reject);
          worker.once('message', value => { clearTimeout(timer); assert.equal(value, expected); resolve(); });
        });
      }
      await message('ready'); const done = message('done');
      channel.postMessage({ payload: ['actual worker', 42] });
      await done;
      assert.deepEqual(io.receiveMessageOnPort(channel), { message: { ack: ['actual worker', 42] } });
    } finally { channel.close(); await worker.terminate(); }
  },
  markingExportsAndOwnPolicy() {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/registry/node-compat/bootstrap.js'), 'utf8');
    const begin = source.indexOf('Object.assign(_builtinModules.worker_threads, {');
    const end = source.indexOf('\n});', begin) + 4;
    assert.ok(begin >= 0 && end > begin);
    const builtins = { worker_threads: {} };
    Function('_builtinModules', '_nodePortIO', '_nodeObjectMarks', '_nodePortsPlatform', source.slice(begin, end))(builtins, io, marks, ports);
    const api = builtins.worker_threads;
    assert.equal(api.markAsUncloneable, io.markAsUncloneable);
    for (const name of ['markAsUncloneable', 'markAsUntransferable', 'isMarkedAsUntransferable']) {
      assert.equal(api[name].name, wt[name].name); assert.equal(api[name].length, wt[name].length);
      const actual = Object.getOwnPropertyDescriptor(api, name), expected = Object.getOwnPropertyDescriptor(wt, name);
      assert.deepEqual([actual.writable, actual.configurable, actual.enumerable], [expected.writable, expected.configurable, expected.enumerable]);
    }
    for (const primitive of [undefined, null, 1, 0n, false, 'text', Symbol('p')]) {
      assert.equal(api.markAsUntransferable(primitive), undefined);
      assert.equal(api.isMarkedAsUntransferable(primitive), false);
      assert.equal(api.markAsUncloneable(primitive), undefined);
    }
    for (const object of [Object.freeze({}), Object.seal({}), [], function f() {}]) {
      const keys = Reflect.ownKeys(object);
      assert.equal(api.markAsUntransferable(object), undefined);
      assert.equal(api.markAsUntransferable(object), undefined);
      assert.equal(api.isMarkedAsUntransferable(object), true);
      assert.deepEqual(Reflect.ownKeys(object), keys);
      assert.equal(api.isMarkedAsUntransferable(Object.create(object)), false);
    }
  },
  privateMarksDoNotInvokeTrapsOrInherit() {
    let traps = 0;
    const proxy = new Proxy({}, { get() { ++traps; throw Error('get'); }, set() { ++traps; throw Error('set'); },
      getOwnPropertyDescriptor() { ++traps; throw Error('descriptor'); }, ownKeys() { ++traps; throw Error('keys'); } });
    // The pinned V8 private-key assignment rejects proxies without invoking a
    // trap. This differs from ordinary frozen objects and must stay visible.
    const expected = { name: 'TypeError', message: 'Cannot pass private property name to proxy trap' };
    assert.throws(() => marks.markAsUntransferable(proxy), expected);
    assert.equal(marks.isMarkedAsUntransferable(proxy), false);
    assert.throws(() => io.markAsUncloneable(proxy), expected); assert.equal(traps, 0);
    const proto = {}; io.markAsUncloneable(proto);
    assert.throws(() => structuredClone(proto), { name: 'DataCloneError', code: 25 });
    const child = Object.create(proto); child.value = 1;
    assert.deepEqual(structuredClone(child), { value: 1 });
    const vm = require('node:vm');
    const other = vm.runInNewContext('Object.freeze({ value: 1 })');
    marks.markAsUntransferable(other); assert.equal(marks.isMarkedAsUntransferable(other), true);
    io.markAsUncloneable(other); assert.throws(() => structuredClone(other), { name: 'DataCloneError', code: 25 });
  },
  async transferMarkValidatesBeforeGraphAndDetachment() {
    const pair = new ports.MessageChannel();
    try {
      const first = new ArrayBuffer(4), denied = new ArrayBuffer(5);
      marks.markAsUntransferable(denied); let getters = 0;
      const payload = { get value() { ++getters; return first; } };
      assert.throws(() => pair.port1.postMessage(payload, [first, denied]), { name: 'DataCloneError', code: 25 });
      assert.equal(getters, 0); assert.equal(first.byteLength, 4); assert.equal(denied.byteLength, 5);
      // A mark does not forbid cloning, and it does not survive cloning.
      const copied = structuredClone(denied);
      assert.equal(copied.byteLength, 5); assert.equal(marks.isMarkedAsUntransferable(copied), false);
      const { Buffer } = require('./node-buffer-pool.cjs').create();
      const pooled = Buffer.from('small');
      assert.equal(marks.isMarkedAsUntransferable(pooled), false);
      assert.equal(marks.isMarkedAsUntransferable(pooled.buffer), true);
      assert.throws(() => pair.port1.postMessage(pooled, [pooled.buffer]), { name: 'DataCloneError', code: 25 });
      assert.equal(pooled.toString(), 'small');
    } finally { await close(pair); }
  },
  cloneMarkUsesNativeBuiltinAndHostDispatch() {
    let getters = 0;
    const denied = Object.freeze({ get value() { ++getters; return 1; } });
    io.markAsUncloneable(denied);
    assert.throws(() => structuredClone(denied), { name: 'DataCloneError', code: 25 }); assert.equal(getters, 0);
    for (const value of [[], new ArrayBuffer(3), new Uint8Array([1, 2]), new Map([['a', 1]]), new Set([1]), new Date(123), /a/g]) {
      io.markAsUncloneable(value); assert.deepEqual(structuredClone(value), value);
    }
    const buffer = new ArrayBuffer(3); io.markAsUncloneable(buffer);
    const moved = structuredClone(buffer, { transfer: [buffer] });
    assert.equal(buffer.byteLength, 0); assert.equal(moved.byteLength, 3);
    for (const value of [new Error('private'), new Blob(['data'])]) {
      io.markAsUncloneable(value); assert.throws(() => structuredClone(value), { name: 'DataCloneError', code: 25 });
    }
  },
  async graphQueueAndReceive() {
    const pair = new ports.MessageChannel();
    try {
      assert.equal(io.MessagePort, ports.MessagePort); assert.equal(io.MessageChannel, ports.MessageChannel);
      assert.throws(() => new ports.MessagePort(), { code: 'ERR_CONSTRUCT_CALL_INVALID' });
      function failure(fn) { try { fn(); } catch (error) { return { name: error.name, code: error.code, message: error.message }; } }
      assert.deepEqual(failure(() => new ports.MessagePort()), failure(() => new wt.MessagePort()));
      assert.deepEqual(failure(() => ports.MessageChannel()), failure(() => wt.MessageChannel()));
      assert.equal(pair.port1.hasRef(), false); assert.equal(pair.port2.hasRef(), false);
      const cycle = { n: 9007199254740993n, map: new Map([['a', 2]]) }; cycle.self = cycle;
      pair.port1.postMessage(cycle); cycle.map.set('a', 9);
      const message = io.receiveMessageOnPort(pair.port2).message;
      assert.equal(message.self, message); assert.equal(message.map.get('a'), 2); assert.equal(message.n, cycle.n);
      assert.equal(io.receiveMessageOnPort(pair.port2), undefined);
    } finally { await close(pair); }
  },
  async eventsRefAndClose() {
    const pair = new ports.MessageChannel();
    try {
      const seen = []; let event;
      pair.port2.onmessage = value => { event = value; seen.push(value.data); };
      assert.equal(pair.port2.hasRef(), true);
      pair.port1.postMessage('queued'); assert.deepEqual(seen, []);
      ports.dispatch(); assert.deepEqual(seen, ['queued']);
      assert.equal(event instanceof web.messageEvents.MessageEvent, true); assert.equal(event.target, pair.port2);
      assert.equal(event.origin, ''); assert.deepEqual(event.ports, []); assert.equal(Object.isFrozen(event.ports), true);
      pair.port2.onmessage = null; assert.equal(pair.port2.hasRef(), false);
      let closed = false; pair.port1.on('close', () => { closed = true; }); pair.port1.close();
      assert.equal(closed, false); await turn(); await turn(); assert.equal(closed, true);
    } finally { await close(pair); }
  },
  async byteTransferAndClosedValidation() {
    const pair = new ports.MessageChannel();
    try {
      const bytes = new Uint8Array([1, 0, 255]); let iterations = 0;
      const transfer = { get [Symbol.iterator]() { iterations++; return function* () { yield bytes.buffer; }; } };
      pair.port1.postMessage({ bytes }, transfer); assert.equal(bytes.byteLength, 0); assert.equal(iterations, 1);
      assert.deepEqual([...io.receiveMessageOnPort(pair.port2).message.bytes], [1, 0, 255]);
      pair.port1.close(); await turn(); await turn();
      assert.throws(() => pair.port1.postMessage(() => {}), { name: 'DataCloneError' });
      const empty = new ArrayBuffer(2); pair.port1.postMessage(empty, [empty]); assert.equal(empty.byteLength, 0);
    } finally { await close(pair); }
  },
};
module.exports = { ports, io, marks };
if (require.main === module) (async () => {
 const name = process.argv[2]; assert.equal(typeof cases[name], 'function'); await cases[name]();
 for (const handle of handles.keys()) handle.close();
 console.log(JSON.stringify({ case: name, passed: true, scope: 'Candidate port/IO/event source over actual native Node queues, graph/byte serialization and engine dependencies; not guest/four-host or port transfer conformance' }));
})().catch(error => { for (const handle of handles.keys()) handle.close(); console.error(error); process.exitCode = 1; });
