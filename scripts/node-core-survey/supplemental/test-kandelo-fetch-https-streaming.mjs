import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { on, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { setDefaultCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';

const uploadPrefix = Buffer.alloc(32 * 1024, 0x41);
const uploadSuffix = Buffer.alloc(32 * 1024, 0x42);
const downloadPrefix = Buffer.alloc(64 * 1024, 0x43);
const downloadSuffix = Buffer.alloc(128 * 1024, 0x44);
const cancelPrefix = Buffer.from('body started');

function key(name) {
  return readFileSync(new URL('../fixtures/keys/' + name, import.meta.url), 'utf8');
}

async function expectMessage(messages, type) {
  const { value, done } = await messages.next();
  assert.equal(done, false, `peer disconnected before ${type}`);
  assert.equal(value[0].type, type);
  return value[0];
}

async function serveUpload(req, res) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    if (length < uploadPrefix.length && length + chunk.length >= uploadPrefix.length) {
      process.send({ type: 'upload-prefix' });
    }
    chunks.push(chunk);
    length += chunk.length;
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([uploadPrefix, uploadSuffix]));

  // The client must see data while the response is still open. Drive the
  // transition with IPC so it does not depend on how TLS divides packets.
  const prefixRead = once(process, 'message');
  res.setHeader('Content-Type', 'application/octet-stream');
  assert.equal(res.write(downloadPrefix), false);
  const drain = once(res, 'drain');
  const [[message]] = await Promise.all([prefixRead, drain]);
  assert.equal(message.type, 'download-prefix-read');
  res.end(downloadSuffix);
}

function serveCancellation(req, res) {
  const socket = req.socket;
  socket.once('close', () => {
    assert.equal(res.writableFinished, false);
    process.send({ type: 'cancelled-socket', path: req.url });
  });
  res.write(cancelPrefix);
}

async function serve() {
  const server = createServer({
    cert: key('agent8-cert.pem'),
    key: key('agent8-key.pem'),
    highWaterMark: 16 * 1024,
  }, (req, res) => {
    switch (req.url) {
      case '/stream':
        serveUpload(req, res).catch(error => {
          console.error(error);
          process.exitCode = 1;
          res.destroy(error);
          server.closeAllConnections();
          server.close(() => process.disconnect());
        });
        break;
      case '/abort':
      case '/cancel':
        serveCancellation(req, res);
        break;
      case '/healthy':
        res.end('healthy');
        break;
      default:
        assert.fail(`Unexpected request ${req.url}`);
    }
  });
  const sockets = new Map();
  server.on('connection', socket => {
    sockets.set(socket, new Promise(resolve => {
      socket.once('close', () => {
        sockets.delete(socket);
        resolve();
      });
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.on('message', message => {
    if (message.type === 'stop') {
      server.close(async error => {
        assert.ifError(error);
        await Promise.all(sockets.values());
        assert.equal(sockets.size, 0);
        process.disconnect();
      });
    }
  });
  process.send({ type: 'listening', port: server.address().port });
}

async function checkStreaming(base, peer, messages) {
  const uploadReachedPeer = expectMessage(messages, 'upload-prefix');
  const upload = new ReadableStream({
    start(controller) { controller.enqueue(uploadPrefix); },
    async pull(controller) {
      await uploadReachedPeer;
      controller.enqueue(uploadSuffix);
      controller.close();
    },
  });
  const [response] = await Promise.all([
    fetch(base + '/stream', { method: 'POST', body: upload, duplex: 'half' }),
    uploadReachedPeer,
  ]);
  assert.equal(response.status, 200);

  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value.byteLength > 0 && first.value.byteLength <= downloadPrefix.length);
  peer.send({ type: 'download-prefix-read' });
  const chunks = [Buffer.from(first.value)];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([downloadPrefix, downloadSuffix]));
}

async function checkAbort(base, messages) {
  const controller = new AbortController();
  const response = await fetch(base + '/abort', { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await readCancellationPrefix(reader);
  const pendingRead = assert.rejects(reader.read(), { name: 'AbortError' });
  controller.abort();
  await pendingRead;
  assert.equal((await expectMessage(messages, 'cancelled-socket')).path, '/abort');
}

async function checkReaderCancel(base, messages) {
  const response = await fetch(base + '/cancel');
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await readCancellationPrefix(reader);
  await reader.cancel();
  assert.deepEqual(await reader.read(), { value: undefined, done: true });
  assert.equal((await expectMessage(messages, 'cancelled-socket')).path, '/cancel');
}

async function readCancellationPrefix(reader) {
  const chunks = [];
  let length = 0;
  while (length < cancelPrefix.length) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    chunks.push(Buffer.from(value));
    length += value.byteLength;
  }
  assert.deepEqual(Buffer.concat(chunks), cancelPrefix);
}

async function check() {
  setDefaultCACertificates([key('fake-startcom-root-cert.pem')]);
  const peer = fork(fileURLToPath(import.meta.url), ['serve']);
  const exit = once(peer, 'exit');
  const messages = on(peer, 'message', { close: ['disconnect'] });
  try {
    const { port } = await expectMessage(messages, 'listening');
    const base = `https://localhost:${port}`;
    await checkStreaming(base, peer, messages);
    await checkAbort(base, messages);
    await checkReaderCancel(base, messages);
    assert.equal(await (await fetch(base + '/healthy')).text(), 'healthy');
    peer.send({ type: 'stop' });
    assert.deepEqual(await exit, [0, null]);
    console.log('Verified HTTPS streaming, drain, cancellation and peer shutdown');
  } finally {
    await messages.return();
    if (peer.exitCode === null && peer.signalCode === null) {
      peer.kill();
      await exit;
    }
  }
}

if (process.argv[2] === 'serve') {
  await serve();
} else {
  await check();
}
