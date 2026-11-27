import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createConnection } from 'node:net';

// The identified guest supports IPv6 loopback and has no routed IPv6 link.
const address = '2001:db8::1';
const port = 9;
const datagram = createSocket('udp6');
let udpError;
try {
  udpError = await new Promise((resolve) => {
    datagram.send(Buffer.from('route check'), port, address, resolve);
  });
} finally {
  const closed = once(datagram, 'close');
  datagram.close();
  await closed;
}
assert.equal(udpError?.code, 'ENETUNREACH');

const stream = createConnection({ host: address, port, family: 6 });
const closed = new Promise((resolve) => stream.once('close', resolve));
const tcpError = await new Promise((resolve, reject) => {
  stream.once('error', resolve);
  stream.once('connect', () => {
    stream.destroy();
    reject(new Error('The guest unexpectedly connected through a missing route'));
  });
});
await closed;
assert.equal(tcpError.code, 'EADDRNOTAVAIL');
console.log(JSON.stringify({ address, udp: udpError.code, tcp: tcpError.code }));
