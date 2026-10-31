/** The same programs run unchanged on the pinned native and guest runtimes. */
export const nodeTcpServerCases = [
  ...(['127.0.0.1', '::1'] as const).map(host => ({
    name: host === '::1' ? 'ipv6-half-close' : 'ipv4-half-close',
    source: `
const assert = require('assert');
const net = require('net');
let serverClosed = false, clientClosed = false, acceptedClosed = false;
process.on('exit', code => {
  assert.strictEqual(code, 0);
  assert(serverClosed && clientClosed && acceptedClosed, 'all handles must close');
  console.log('node-tcp-lifetime-ok');
});
const server = net.createServer({ allowHalfOpen: true }, socket => {
  assert(socket.remotePort > 0);
  assert.strictEqual(socket.localPort, server.address().port);
  assert.strictEqual(socket.localAddress, ${JSON.stringify(host)});
  socket.on('close', () => { acceptedClosed = true; });
  let data = '';
  socket.on('data', chunk => { data += chunk.toString(); });
  socket.on('end', () => socket.end('reply:' + data));
  server.getConnections((error, count) => {
    assert.ifError(error); assert.strictEqual(count, 1);
  });
  server.close(() => {
    assert(socket.destroyed, 'server close waits for descriptor teardown');
    assert.strictEqual(acceptedClosed, false, 'server close precedes socket close notification');
    assert.strictEqual(server.address(), null);
    serverClosed = true;
  });
  assert.strictEqual(server.listening, false);
  assert.strictEqual(serverClosed, false);
});
assert.strictEqual(server.address(), null);
server.listen(0, ${JSON.stringify(host)}, () => {
  assert.strictEqual(server.listening, true);
  const address = server.address();
  assert(address.port > 0, 'an actual ephemeral port is allocated');
  assert.strictEqual(address.family, ${JSON.stringify(host === '::1' ? 'IPv6' : 'IPv4')});
  const client = net.connect(address.port, ${JSON.stringify(host)}, () => client.end('hello'));
  let data = '';
  client.on('data', chunk => { data += chunk.toString(); });
  client.on('end', () => assert.strictEqual(data, 'reply:hello'));
  client.on('close', () => { clientClosed = true; });
});
`,
  })),
  {
    name: 'bind-conflict-and-release',
    source: `
const assert = require('assert'); const net = require('net');
let completed = false;
process.on('exit', () => { assert(completed); console.log('node-tcp-release-ok'); });
const first = net.createServer();
first.listen(0, '127.0.0.1', () => {
  const port = first.address().port;
  const conflict = net.createServer();
  conflict.on('listening', () => { throw Error('duplicate bind succeeded'); });
  conflict.on('error', error => {
    assert.strictEqual(error.code, 'EADDRINUSE');
    assert.strictEqual(error.syscall, 'listen');
    assert.strictEqual(error.port, port);
    first.close(() => {
      const replacement = net.createServer();
      replacement.listen(port, '127.0.0.1', () => replacement.close(() => { completed = true; }));
    });
  });
  conflict.listen(port, '127.0.0.1');
});
`,
  },
  {
    name: 'unref-listener',
    source: `
const assert = require('assert'); const net = require('net');
let listened = false;
process.on('exit', () => { assert(listened); console.log('node-tcp-unref-ok'); });
net.createServer().listen(0, '127.0.0.1', function () {
  assert(this.address().port > 0); listened = true; this.unref();
});
`,
  },
];

export const nodeTcpServerPeerSource = `
const assert = require('assert'); const net = require('net');
const { spawn } = require('child_process');
(async () => {
  for (const [host, family] of [['127.0.0.1', 4], ['::1', 6]]) {
    await new Promise((resolve, reject) => {
      let acceptedClosed = false, peerClosed = false, serverClosed = false;
      const finish = () => { if (peerClosed && serverClosed) resolve(); };
      const server = net.createServer({ allowHalfOpen: true }, socket => {
        let data = '';
        socket.on('data', bytes => { data += bytes.toString(); });
        socket.on('end', () => socket.end('reply:' + data));
        socket.on('error', reject);
        socket.on('close', () => { acceptedClosed = true; });
        server.close(() => {
          assert(socket.destroyed); serverClosed = true; finish();
        });
      });
      server.on('error', reject);
      server.listen(0, host, () => {
        const peer = spawn('/node-src/server-peer.wasm', [String(family), String(server.address().port)],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', errors = '';
        peer.stdout.on('data', bytes => { output += bytes.toString(); });
        peer.stderr.on('data', bytes => { errors += bytes.toString(); });
        peer.on('error', reject);
        peer.on('close', (code, signal) => {
          assert.strictEqual(code, 0, errors); assert.strictEqual(signal, null);
          assert.strictEqual(output.trim(), 'node-tcp-c-peer-ok');
          peerClosed = true; finish();
        });
      });
    });
  }
  console.log('node-tcp-independent-peer-ok');
})().catch(error => { throw error; });
`;
