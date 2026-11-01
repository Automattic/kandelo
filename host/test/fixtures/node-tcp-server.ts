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
  ...(['127.0.0.1', '::1'] as const).map(host => ({
    name: host === '::1' ? 'zero-ipv6' : 'zero-ipv4',
    source: `
const assert = require('assert');
const net = require('net');
let dropped = false, closed = false, clientClosed = false;
process.on('exit', () => {
  assert(dropped && closed && clientClosed);
  console.log('node-tcp-zero-limit-ok');
});
const server = net.createServer(() => { throw Error('zero capacity accepted a connection'); });
server.maxConnections = 0;
server.on('drop', data => {
  assert.strictEqual(Object.getPrototypeOf(data), null);
  assert.deepStrictEqual(Object.keys(data).sort(), [
    'localAddress', 'localFamily', 'localPort', 'remoteAddress', 'remoteFamily', 'remotePort',
  ]);
  assert.strictEqual(data.localAddress, ${JSON.stringify(host)});
  assert.strictEqual(data.remoteAddress, ${JSON.stringify(host)});
  assert.strictEqual(data.localFamily, ${JSON.stringify(host === '::1' ? 'IPv6' : 'IPv4')});
  assert.strictEqual(data.remoteFamily, ${JSON.stringify(host === '::1' ? 'IPv6' : 'IPv4')});
  assert(data.localPort > 0 && data.remotePort > 0);
  assert.strictEqual(data.localPort, server.address().port);
  server.getConnections((error, count) => { assert.ifError(error); assert.strictEqual(count, 0); });
  dropped = true;
  server.close(() => { closed = true; });
});
server.listen(0, ${JSON.stringify(host)}, () => {
  const client = net.connect(server.address().port, ${JSON.stringify(host)});
  client.on('error', error => { assert.strictEqual(error.code, 'ECONNRESET'); });
  client.on('close', () => { clientClosed = true; });
  client.resume();
});
`,
  })),
  {
    name: 'release-capacity',
    source: `
const assert = require('assert');
const net = require('net');
let accepted = 0, dropped = 0, done = false;
const acceptedSockets = [];
process.on('exit', () => {
  assert(done);
  assert.strictEqual(accepted, 2);
  assert.strictEqual(dropped, 1);
  console.log('node-tcp-capacity-release-ok');
});
const server = net.createServer(socket => {
  accepted++;
  acceptedSockets.push(socket);
  socket.on('data', data => socket.write(data));
});
server.maxConnections = 1;
server.on('drop', () => { dropped++; });
function connect() {
  return new Promise(resolve => {
    const client = net.connect(server.address().port, '127.0.0.1', () => resolve(client));
  });
}
function closed(client) {
  return new Promise(resolve => { client.once('close', resolve); client.resume(); client.end(); });
}
function echo(client, message) {
  return new Promise((resolve, reject) => {
    client.once('data', bytes => { assert.strictEqual(String(bytes), message); resolve(); });
    client.once('error', reject);
    client.write(message);
  });
}
server.listen(0, '127.0.0.1', async () => {
  const first = await connect();
  await echo(first, 'first');
  const second = await connect();
  await new Promise(resolve => {
    second.once('close', resolve);
    second.on('error', error => assert.strictEqual(error.code, 'ECONNRESET'));
    second.resume();
  });
  assert.strictEqual(accepted, 1);
  assert.strictEqual(dropped, 1);
  // The client can close before the accepted descriptor is torn down.
  const acceptedClosed = new Promise(resolve => acceptedSockets[0].once('close', resolve));
  await closed(first);
  await acceptedClosed;
  const third = await connect();
  await echo(third, 'third');
  await closed(third);
  server.close(() => { done = true; });
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
