'use strict';
// Actual bootstrap TLSSocket failure lifecycle with native Duplex as an explicit
// dependency. This does not execute the guest JSAPI/OpenSSL or socket transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stream = require('node:stream');
const root = path.resolve(__dirname, '../..');
const bootstrap = fs.readFileSync(path.join(root, 'packages/registry/node-compat/bootstrap.js'), 'utf8');
const start = bootstrap.indexOf('const tls = (() => {');
const end = bootstrap.indexOf('    function connect(options, cb)', start);
assert(start >= 0 && end > start);
const make = Function('_nodeNative', 'Buffer', 'stream',
  bootstrap.slice(start, end).replace('const tls = (() => {', '') + '\nreturn TLSSocket;');
async function check(mode) {
  const failure = new Error(mode + ' actual dependency failure');
  const handles = [];
  const TLSSocket = make({
    tlsConnect() { if (mode === 'synchronous') throw failure; return Promise.reject(failure); },
    tlsClose(handle) { handles.push(handle); },
  }, Buffer, stream);
  const socket = new TLSSocket({});
  const errors = [], writes = [];
  socket.on('error', error => errors.push(error));
  const closed = new Promise(resolve => socket.once('close', resolve));
  const deadline = setTimeout(() => { throw new Error(mode + ' close timed out'); }, 2000);
  try {
    socket.write(Buffer.from('queued'), error => writes.push(error));
    assert.doesNotThrow(() => socket._attach(7, 'localhost', {}));
    await closed;
    assert.deepEqual(errors, [failure]);
    assert.deepEqual(writes, [failure]);
    assert.equal(socket._handshakePending, false);
    assert.equal(socket._tlsHandle, -1);
    assert.equal(socket.destroyed, true);
    assert.equal(socket._writeQueue.length, 0);
    assert.deepEqual(handles, []);
    console.log(JSON.stringify({ mode, originalErrorIdentity: true,
      queuedWriteRetiredOnce: true, closed: true, handleNotPublished: true }));
  } finally {
    clearTimeout(deadline);
    if (!socket.destroyed) socket.destroy(failure);
    await closed;
  }
}
(async () => { await check('synchronous'); await check('rejection'); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
