// Flags: --expose-internals
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { kTransferList, kTransfer } = require('internal/worker/js_transferable');

async function run(kind, rejectFirst) {
  const { port1, port2 } = new MessageChannel();
  const sender = kind === 'file' ? await fs.open(__filename) :
    new ReadableStream({ start(controller) {
      controller.enqueue(42);
      controller.close();
    } });
  const effects = [];
  for (const [key, label] of [[kTransferList, 'list'], [kTransfer, 'transfer']]) {
    const original = sender[key];
    Object.defineProperty(sender, key, { value(...args) {
      effects.push(label);
      return Reflect.apply(original, this, args);
    } });
  }
  let receiver;
  try {
    if (rejectFirst) {
      assert.throws(() => port1.postMessage(sender), { name: 'DataCloneError' });
    }
    port1.postMessage(sender, [sender]);
    const detached = kind === 'file' ? sender.fd === -1 : sender.locked;
    receiver = receiveMessageOnPort(port2)?.message;
    let bytesMatch = false;
    if (receiver) {
      if (kind === 'file') {
        bytesMatch = (await receiver.readFile()).equals(await fs.readFile(__filename));
      } else {
        const reader = receiver.getReader();
        const first = await reader.read();
        bytesMatch = first.value === 42 && !first.done && (await reader.read()).done;
        reader.releaseLock();
      }
    }
    return { kind, rejectFirst, effects, detached, bytesMatch };
  } finally {
    if (kind === 'file') {
      if (receiver) await receiver.close();
      if (sender.fd !== -1) await sender.close();
    }
    port1.close();
    port2.close();
  }
}

(async () => {
  const rows = [];
  for (const kind of ['stream', 'file']) {
    for (const rejectFirst of [false, true]) {
      const row = await run(kind, rejectFirst);
      console.log(JSON.stringify(row));
      rows.push(row);
    }
  }
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.deepEqual(row.effects, ['list', 'transfer']);
    assert.equal(row.detached, true);
    assert.equal(row.bytesMatch, true);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
