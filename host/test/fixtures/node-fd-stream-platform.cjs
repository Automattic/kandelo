'use strict';
// Exercise candidate fd owners and candidate pinned stream factories over
// actual native Node engine dependencies and OS pipe/file operations. This
// does not execute guest fd watches, VFS, async providers or four-host paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { internalBinding } = require('internal/test/binding');
const root = path.resolve(__dirname, '../../..');
const bundle = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const factories = Function(bundle + ';return { fd: _createNodeFdStreamPlatform, stream: _createNodeStreamPlatform };')();
const nativeUtilBinding = internalBinding('util');
const readableNative = require('internal/webstreams/readablestream');
const nativeStreamUtils = require('internal/streams/utils');
const nativeAsync = require('internal/async_hooks');
const nativeBlob = require('internal/blob');
const platform = factories.stream({
  process, ports: require('node:worker_threads'), Buffer, FastBuffer: require('internal/buffer').FastBuffer, events: require('node:events'), util: require('node:util'), buffer: require('node:buffer'), fs,
  fileHandles: require('internal/fs/promises'), fsUtils: require('internal/fs/utils'),
  toPathIfFileURL: require('internal/url').toPathIfFileURL,
  stringDecoder: require('node:string_decoder'),
  async: { api: require('node:async_hooks'), enabledHooksExist: nativeAsync.enabledHooksExist,
    symbols: nativeAsync.symbols, frame: require('internal/async_context_frame') },
  values: { errors: require('internal/errors'), validators: require('internal/validators'),
    util: require('internal/util'), require },
  event: { abort: require('internal/abort_controller'), dom: { DOMException },
    eventTarget: require('internal/event_target'), addAbortListener: require('node:events').addAbortListener,
    require },
  clone: { protocol: require('internal/worker/js_transferable') },
  native: nativeUtilBinding, experimentalStreamIter: false,
  compressionConstants: require('node:zlib').constants, TextEncoder, TextDecoder,
  queueMicrotask, webState: { isReadable: readableNative.isReadableStream,
    isDisturbed: nativeStreamUtils.isDisturbed },
  getBodyData: () => ({ Blob, blob: value => nativeBlob.isBlob(value) ? value : undefined }),
});
const controls = new Map();
function readFrom(source, limit) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const record = { cancel() { cleanup(); const error = Object.assign(Error('cancelled read'), { code: 'ECANCELED' }); reject(error); },
    reference(value) { value ? source.ref() : source.unref(); } };
  function cleanup() { source.off('readable', ready); source.off('end', ready); source.off('error', failed); controls.delete(promise); }
  function failed(error) { cleanup(); reject(error); }
  function ready() {
    const length = source.readableLength;
    if (length) {
      const bytes = source.read(Math.min(length, limit));
      if (bytes !== null) { cleanup(); resolve(Uint8Array.from(bytes)); return; }
    }
    source.read(0);
    if (source.readableEnded) { cleanup(); resolve(new Uint8Array(0)); }
  }
  controls.set(promise, record);
  source.on('readable', ready); source.on('end', ready); source.on('error', failed);
  ready();
  return promise;
}
function fdPlatform(input, output, calls = []) {
  return factories.fd({ stream: platform.api, Buffer, FastBuffer: require('internal/buffer').FastBuffer, process,
    native: {
      __kandeloFdWrite(fd, bytes) {
        calls.push(['write', fd, bytes.length]);
        return new Promise((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve(bytes.length)));
      },
      __kandeloFdRead(fd, limit, nonblocking) {
        calls.push(['read', fd, limit, nonblocking]); return readFrom(input, limit);
      },
      __kandeloFdReadControl(promise, mode) {
        const record = controls.get(promise); calls.push(['control', mode, !!record]);
        if (!record) return false;
        if (mode === null) record.cancel(); else record.reference(mode);
        return true;
      },
    },
  });
}
async function child(script) {
  const result = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = once(result, 'exit');
  return { result, completion, async close() {
    result.stdin.destroy(); result.stdout.destroy(); result.stderr.destroy();
    if (result.exitCode === null && result.signalCode === null) result.kill();
    await completion;
  } };
}
const cases = {
  async outputCompletionAndBackpressure() {
    const c = await child("setTimeout(() => process.stdin.pipe(process.stdout), 40)");
    try {
      const received = []; c.result.stdout.on('data', chunk => received.push(chunk));
      const calls = [], owner = fdPlatform(null, c.result.stdin, calls);
      const output = owner.writable(c.result.stdin._handle.fd, { highWaterMark: 32 });
      assert.ok(output instanceof platform.api.Writable);
      const data = Buffer.alloc(256 * 1024, 0x63);
      let called = false;
      assert.equal(output.write(data, () => { called = true; }), false);
      assert.equal(called, false); assert.equal(output.writableNeedDrain, true);
      await once(output, 'drain'); assert.equal(called, true);
      const finish = once(output, 'finish'); output.end('done'); await finish;
      c.result.stdin.end(); await once(c.result.stdout, 'end');
      assert.deepEqual(Buffer.concat(received), Buffer.concat([data, Buffer.from('done')]));
      assert.equal(calls.filter(x => x[0] === 'write').length, 2);
    } finally { await c.close(); }
  },
  async inputBufferingEncodingAndEof() {
    const c = await child("process.stdout.write(Buffer.from([0xe9,0,0xff]));process.stdout.end()");
    try {
      const owner = fdPlatform(c.result.stdout), input = owner.readable(c.result.stdout._handle.fd, { highWaterMark: 2 });
      assert.ok(input instanceof platform.api.Readable); assert.equal(input.readableLength, 0);
      input.setEncoding('latin1'); let text = '';
      const originalFrom = Buffer.from;
      Buffer.from = () => { throw Error('public Buffer.from must not intercept owned fd input'); };
      try { for await (const chunk of input) text += chunk; }
      finally { Buffer.from = originalFrom; }
      assert.equal(text, '\xe9\0\xff'); assert.equal(input.readableEnded, true);
      assert.equal(input.destroyed, true);
    } finally { await c.close(); }
  },
  async pauseRefResumeAndDestroy() {
    const c = await child("process.stdin.on('data', value => { process.stdout.write(value); });");
    try {
      const calls = [], owner = fdPlatform(c.result.stdout, null, calls);
      const input = owner.readable(c.result.stdout._handle.fd);
      input.resume(); await new Promise(resolve => process.nextTick(resolve));
      assert.equal(controls.size, 1);
      input.unref(); assert.ok(calls.some(x => x[0] === 'control' && x[1] === false && x[2]));
      input.ref(); input.pause(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(controls.size, 0); assert.equal(input.readableFlowing, false);
      c.result.stdin.write('retained'); const data = once(input, 'data'); input.resume();
      assert.equal((await data)[0].toString(), 'retained');
      const closed = once(input, 'close'); input.destroy(); await closed;
      assert.equal(controls.size, 0);
      assert.equal(c.result.stdout.destroyed, false); // Borrowed fd remains owned by process.
    } finally { await c.close(); }
  },
  async actualFileErrorAndBorrowedOutputLifetime() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kandelo-fd-stream-'));
    const fd = fs.openSync(path.join(dir, 'out'), 'w');
    let realError;
    try {
      const sink = { write(bytes, callback) { fs.write(fd, bytes, 0, bytes.length, null, callback); } };
      const owner = fdPlatform(null, sink), output = owner.writable(fd);
      const close = once(output, 'close'); output.destroy(); await close;
      assert.equal(output.destroyed, false); fs.fstatSync(fd);
      await new Promise((resolve, reject) => output.write('actual file', error => error ? reject(error) : resolve()));
      assert.equal(fs.readFileSync(path.join(dir, 'out'), 'utf8'), 'actual file');
      fs.closeSync(fd);
      try { fs.writeSync(fd, Buffer.from('x')); } catch (error) { realError = error; }
      const errored = once(output, 'error'); let writeError;
      output.write('x', error => { writeError = error; });
      const [error] = await errored;
      assert.equal(error.code, realError.code); assert.equal(writeError, error);
    } finally { try { fs.closeSync(fd); } catch {} fs.rmSync(dir, { recursive: true }); }
  },
};
(async () => {
  const name = process.argv[2]; assert.equal(typeof cases[name], 'function');
  await cases[name](); assert.equal(controls.size, 0);
  console.log(JSON.stringify({ case: name, passed: true,
    scope: 'Candidate fd owners and pinned stream factories over actual native dependencies/pipes/files; not guest/four-host conformance' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
