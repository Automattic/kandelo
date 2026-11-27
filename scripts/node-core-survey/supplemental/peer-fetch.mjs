import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { setDefaultCACertificates } from 'node:tls';

const [mode, address, port, otherAddress] = process.argv.slice(2);
const certificate = readFileSync(new URL('./peer-cert.pem', import.meta.url));
const upload = Buffer.alloc(128 * 1024, 0x41);
const reply = Buffer.alloc(128 * 1024, 0x42);
const prefix = Buffer.from('body started');

async function serve() {
  const key = readFileSync(new URL('./peer-key.pem', import.meta.url));
  let reportCancelled;
  const cancelled = new Promise(resolve => { reportCancelled = resolve; });
  const server = createServer({ key, cert: certificate, highWaterMark: 16 * 1024 }, async (req, res) => {
    assert.equal(req.socket.remoteAddress, otherAddress);
    if (req.url === '/stream') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), upload);
      assert.equal(res.write(reply), false);
      await once(res, 'drain');
      res.end(reply);
    } else if (req.url === '/cancel') {
      res.write(prefix);
      req.socket.once('close', () => {
        assert.equal(res.writableFinished, false);
        reportCancelled();
      });
    } else if (req.url === '/finish') {
      await cancelled;
      res.setHeader('Connection', 'close');
      res.end('peer socket closed');
      server.close();
    } else {
      assert.fail(`Unexpected request ${req.url}`);
    }
  });
  const sockets = new Map();
  server.on('connection', socket => {
    sockets.set(socket, new Promise(resolve => socket.once('close', () => {
      sockets.delete(socket);
      resolve();
    })));
  });
  const closed = once(server, 'close');
  server.listen(Number(port), address);
  await once(server, 'listening');
  console.log(JSON.stringify({ listening: server.address() }));
  await closed;
  await Promise.all(sockets.values());
  assert.equal(sockets.size, 0);
  console.log('Verified peer source address, HTTPS drain, cancelled socket and listener close');
}

async function check() {
  const url = `https://${address}:${port}`;
  await assert.rejects(fetch(url + '/stream'), error => {
    assert.equal(error.cause?.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    return true;
  });
  setDefaultCACertificates([certificate.toString()]);
  const body = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < upload.length; offset += 16384) {
        controller.enqueue(upload.subarray(offset, offset + 16384));
      }
      controller.close();
    },
  });
  const response = await fetch(url + '/stream', { method: 'POST', body, duplex: 'half' });
  assert.equal(response.status, 200);
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([reply, reply]));

  const controller = new AbortController();
  const cancelling = await fetch(url + '/cancel', { signal: controller.signal });
  assert.equal(cancelling.status, 200);
  const reader = cancelling.body.getReader();
  const starting = [];
  let received = 0;
  while (received < prefix.length) {
    const next = await reader.read();
    assert.equal(next.done, false);
    starting.push(Buffer.from(next.value));
    received += next.value.byteLength;
  }
  assert.deepEqual(Buffer.concat(starting), prefix);
  const rejectedRead = assert.rejects(reader.read(), { name: 'AbortError' });
  controller.abort();
  await rejectedRead;
  assert.equal(await (await fetch(url + '/finish')).text(), 'peer socket closed');
  console.log('Verified trusted HTTPS streaming and abort from the fetch client');
}

assert.ok(mode === 'server' || mode === 'client');
await (mode === 'server' ? serve() : check());
