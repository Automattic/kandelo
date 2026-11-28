'use strict';

const assert = require('node:assert/strict');
const { createSocket } = require('node:dgram');
const { Resolver } = require('node:dns/promises');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { parseDNSPacket, writeDNSPacket } = require('../common/dns');

const host = '127.0.0.1';
const present = 'answer.kandelo.test';
const missing = 'missing.kandelo.test';
const answer = '192.0.2.12';
const responses = [];
const udp = createSocket('udp4');
const tcp = createServer();

function question(protocol, packet, source) {
  const query = parseDNSPacket(packet);
  assert.equal(source, host);
  assert.equal(query.questions.length, 1);
  const [only] = query.questions;
  assert.equal(only.type, 'A');
  responses.push({ protocol, name: only.domain });
  return query;
}

udp.on('message', (packet, source) => {
  const query = question('UDP', packet, source.address);
  const name = query.questions[0].domain;
  assert.ok(name === present || name === missing);
  const flags = name === present ? 0x8380 : 0x8183;
  const response = writeDNSPacket({ id: query.id, flags, questions: query.questions });
  udp.send(response, source.port, source.address);
});

tcp.on('connection', socket => {
  let bytes = Buffer.alloc(0);
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 2 || bytes.length < 2 + bytes.readUInt16BE(0)) return;
    assert.equal(bytes.length, 2 + bytes.readUInt16BE(0));
    const query = question('TCP', bytes.subarray(2), socket.remoteAddress);
    assert.equal(query.questions[0].domain, present);
    const record = { type: 'A', domain: present, address: answer, ttl: 42 };
    const reply = writeDNSPacket({ id: query.id, questions: query.questions, answers: [record] });
    const length = Buffer.alloc(2);
    length.writeUInt16BE(reply.length);
    socket.end(Buffer.concat([length, reply]));
  });
});

async function main() {
  udp.bind(0, host);
  await once(udp, 'listening');
  const port = udp.address().port;
  tcp.listen(port, host);
  await once(tcp, 'listening');

  try {
    const resolver = new Resolver({ timeout: 5000, tries: 1 });
    resolver.setServers([`${host}:${port}`]);
    assert.deepEqual(await resolver.resolve4(present, { ttl: true }), [{ address: answer, ttl: 42 }]);
    await assert.rejects(resolver.resolve4(missing), { code: 'ENOTFOUND', hostname: missing });
    assert.deepEqual(responses, [
      { protocol: 'UDP', name: present },
      { protocol: 'TCP', name: present },
      { protocol: 'UDP', name: missing },
    ]);
  } finally {
    const closed = [once(tcp, 'close'), once(udp, 'close')];
    tcp.close();
    udp.close();
    await Promise.all(closed);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
