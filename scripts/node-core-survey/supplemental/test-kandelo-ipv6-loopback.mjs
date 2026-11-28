import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';

const tcpMessage = 'IPv6 TCP';
const server = createServer(peer => {
  assert.equal(peer.remoteAddress, '::1');
  assert.equal(peer.remoteFamily, 'IPv6');
  peer.end(tcpMessage);
});
server.listen({ host: '::1', port: 0 });
await once(server, 'listening');
const client = createConnection({ host: '::1', port: server.address().port });
const clientClosed = new Promise(resolve => client.once('close', resolve));
try {
  await once(client, 'connect');
  assert.equal(client.remoteAddress, '::1');
  assert.equal(client.remoteFamily, 'IPv6');
  const chunks = [];
  for await (const chunk of client) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), tcpMessage);
  await clientClosed;
} finally {
  client.destroy();
  const closed = once(server, 'close');
  server.close();
  await closed;
}

const receiver = createSocket('udp6');
const sender = createSocket('udp6');
const udpMessage = Buffer.from([0, 255, 1, 2]);
try {
  receiver.bind({ address: '::1', port: 0 });
  await once(receiver, 'listening');
  sender.bind({ address: '::1', port: 0 });
  await once(sender, 'listening');
  const sent = new Promise((resolve, reject) => {
    sender.send(udpMessage, receiver.address().port, '::1', (error, bytes) => {
      if (error) reject(error);
      else resolve(bytes);
    });
  });
  const [[bytes, peer], sentBytes] = await Promise.all([once(receiver, 'message'), sent]);
  assert.equal(sentBytes, udpMessage.length);
  assert.deepEqual(bytes, udpMessage);
  assert.equal(peer.address, '::1');
  assert.equal(peer.family, 'IPv6');
  assert.equal(peer.port, sender.address().port);
} finally {
  await Promise.all([sender, receiver].map(endpoint => new Promise((resolve, reject) => {
    try {
      endpoint.close(resolve);
    } catch (error) {
      if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve();
      else reject(error);
    }
  })));
}
