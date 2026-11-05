'use strict';
const assert = require('node:assert/strict');
const { BroadcastChannel, receiveMessageOnPort, Worker } = require('node:worker_threads');
const cases = {
  async fanout() {
    const channels = Array.from({ length: 3 }, () => new BroadcastChannel('owned-group'));
    const [a, b, c] = channels;
    try {
      let calls = 0;
      const shared = new SharedArrayBuffer(4);
      const original = { shared, get value() { calls++; return [1, 2]; } };
      original.self = original;
      a.postMessage(original); assert.equal(calls, 1);
      assert.equal(receiveMessageOnPort(a), undefined);
      const first = receiveMessageOnPort(b).message, second = receiveMessageOnPort(c).message;
      assert.equal(first.self, first); assert.equal(second.self, second);
      assert.notEqual(first, second); first.value.push(3);
      assert.deepEqual(second.value, [1, 2]);
      new Uint8Array(first.shared)[0] = 42;
      assert.equal(new Uint8Array(second.shared)[0], 42);
      b.close(); a.postMessage('remaining');
      assert.deepEqual(receiveMessageOnPort(c), { message: 'remaining' });
      assert.equal(receiveMessageOnPort(c), undefined);
      c.close(); assert.equal(a.postMessage('no receivers'), undefined);
      return { recipients: 2, getterCalls: calls, sharedValue: 42, ownMessage: false };
    } finally { channels.forEach(channel => channel.close()); }
  },
  async events() {
    const a = new BroadcastChannel('event-group'), b = new BroadcastChannel('event-group');
    try {
      const result = new Promise(resolve => { b.onmessage = event => {
        assert.equal(event.target, b); assert.equal(event.data, 'event');
        assert.equal(event.origin, ''); assert.deepEqual(event.ports, []); resolve(true);
      }; });
      a.postMessage('event'); assert.equal(await result, true);
      b.close(); b.close();
      assert.throws(() => b.postMessage(1), { name: 'InvalidStateError' });
      return { eventDelivered: true, closedPostRejected: true };
    } finally { a.close(); b.close(); }
  },
  async worker() {
    const a = new BroadcastChannel('worker-group');
    const worker = new Worker(`
      const { BroadcastChannel, parentPort } = require('node:worker_threads');
      const channel = new BroadcastChannel('worker-group');
      channel.onmessage = event => {
        channel.postMessage({ ack: event.data }); channel.close(); parentPort.postMessage('done');
      };
      parentPort.postMessage('ready');
    `, { eval: true });
    let timer;
    try {
      const fail = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('worker exchange timeout')), 10000); });
      const exchange = (async () => {
        await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', value => { assert.equal(value, 'ready'); resolve(); }); });
        const ack = new Promise(resolve => { a.onmessage = event => resolve(event.data); });
        const done = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', value => { assert.equal(value, 'done'); resolve(); }); });
        a.postMessage([42, 'actual guest worker']);
        assert.deepEqual(await ack, { ack: [42, 'actual guest worker'] }); await done;
      })();
      await Promise.race([exchange, fail]);
      return { workerExchange: true };
    } finally { clearTimeout(timer); a.close(); await worker.terminate(); }
  },
  async tempdir() {
    const fs = require('node:fs');
    const sync = fs.mkdtempDisposableSync('/tmp/owned-temp-');
    const asynchronous = await fs.promises.mkdtempDisposable('/tmp/owned-async-');
    try {
      fs.writeFileSync(sync.path + '/data', 'payload');
      assert.equal(fs.readFileSync(sync.path + '/data', 'utf8'), 'payload');
      assert(fs.statSync(asynchronous.path).isDirectory());
      const one = sync.path, two = asynchronous.path;
      sync[Symbol.dispose](); await asynchronous[Symbol.asyncDispose]();
      assert.equal(fs.existsSync(one), false); assert.equal(fs.existsSync(two), false);
      sync.remove(); await asynchronous.remove();
      return { syncDisposed: true, asyncDisposed: true, repeatedRemoval: true };
    } finally { sync.remove(); await asynchronous.remove(); }
  },
};
(async () => {
  const name = process.argv[1]; assert.equal(typeof cases[name], 'function');
  console.log('PHASE:begin:' + name);
  const result = await cases[name]();
  console.log('CONTROL_RESULT:' + JSON.stringify({ name, result }));
})().catch(error => { console.error(error); process.exitCode = 1; });
