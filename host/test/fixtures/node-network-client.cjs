'use strict';
const assert = require('assert');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const { spawn } = require('child_process');
const peer = spawn(process.argv[2] || '/node-src/network-peer.wasm', [], { stdio: ['ignore', 'pipe', 'pipe'] });
let peerOut = '', peerError = '';
peer.stderr.on('data', b => { peerError += b.toString(); });
const exited = new Promise((resolve, reject) => {
  peer.on('error', reject);
  peer.on('close', (code, signal) => code === 0 ? resolve() : reject(Error('Peer failed: ' + code + '/' + signal + ': ' + peerError)));
});
const portReady = new Promise((resolve, reject) => {
  peer.on('error', reject);
  peer.stdout.on('data', b => { peerOut += b.toString(); const m = /PORT:(\d+)/.exec(peerOut); if (m) resolve(Number(m[1])); });
});
function lookup(host, options) { return new Promise((resolve, reject) => dns.lookup(host, options, (e, address, family) => e ? reject(e) : resolve(options.all ? address : {address, family}))); }
function nextFd() { const fd = fs.openSync('/dev/null', 'r'); fs.closeSync(fd); return fd; }
(async () => {
  assert.strictEqual(net.getDefaultAutoSelectFamily(), true);
  assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 500);
  net.setDefaultAutoSelectFamilyAttemptTimeout(1);
  assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 10);
  assert.throws(() => net.setDefaultAutoSelectFamily(1), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => net.setDefaultAutoSelectFamilyAttemptTimeout(0), { code: 'ERR_OUT_OF_RANGE' });
  net.setDefaultAutoSelectFamilyAttemptTimeout(50);
  assert.deepStrictEqual(await lookup('::1', {all:true, family:4}), [{address:'::1',family:6}]);
  assert.deepStrictEqual(await lookup('127.0.0.1', {}), {address:'127.0.0.1',family:4});
  const addresses = await dns.promises.lookup('localhost', {all:true});
  assert.ok(addresses.length > 0);
  for (const value of addresses) assert.strictEqual(net.isIP(value.address), value.family);
  const port = await portReady;
  const initial = nextFd();
  for (let i = 0; i < 4; i++) {
    const socket = new net.Socket();
    const attempts = [], failed = [];
    socket.on('connectionAttempt', (...args) => attempts.push(args));
    socket.on('connectionAttemptFailed', (ip, p, family, error) => failed.push([ip,p,family,error.code]));
    const ended = new Promise((resolve, reject) => {
      let text = '';
      socket.on('data', b => { text += b.toString(); });
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    const connected = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    net.setDefaultAutoSelectFamily(i !== 2);
    const binding = i === 0 ? {localAddress:false,localPort:null} : i === 1 ? {localPort:27001} : i === 3 ? {localAddress:'::1',localPort:27002} : {};
    socket.connect({host:i === 3 ? '::1' : 'records.test',port,...binding,lookup(host, options, callback) {
      assert.notStrictEqual(i, 3, 'literal address invoked custom lookup');
      assert.strictEqual(host, 'records.test');
      if (i === 2) {
        assert.strictEqual(options.all, undefined);
        callback(null, '::1', 6);
      } else {
        assert.strictEqual(options.all, true);
        callback(null, [{address:'::2',family:6}, {address:'::2',family:6}, {address:'::1',family:6}]);
      }
    }});
    socket.write('real-guest-bytes-' + i + '\n');
    await connected;
    assert.deepStrictEqual([socket.remoteAddress,socket.remoteFamily,socket.remotePort], ['::1','IPv6',port]);
    assert.strictEqual(socket.localAddress, '::1');
    assert.strictEqual(socket.address().port, socket.localPort);
    if (binding.localPort) assert.strictEqual(socket.localPort, binding.localPort);
    assert.deepStrictEqual(attempts, i < 2 ? [['::2',port,6],['::1',port,6]] : [['::1',port,6]]);
    assert.strictEqual(failed.length, i < 2 ? 1 : 0);
    assert.deepStrictEqual(socket.autoSelectFamilyAttemptedAddresses, i < 2 ? ['::2:'+port,'::1:'+port] : undefined);
    assert.strictEqual(await ended, 'real-guest-bytes-' + i + '\n');
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.destroy(); await closed;
    if (i < 3) assert.strictEqual(nextFd(), initial, 'failed connect leaked descriptors');
  }
  await exited;
  assert.ok(peerOut.includes('node-network-peer-ok'));
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController(), reason = new Error('cancel lookup');
    if (alreadyAborted) controller.abort(reason);
    const socket = net.createConnection({host:'pending.test',port,signal:controller.signal,lookup() {}});
    const errorReady = new Promise(resolve => socket.once('error', resolve));
    const closed = new Promise(resolve => socket.once('close', resolve));
    if (!alreadyAborted) controller.abort(reason);
    const error = await errorReady;
    assert.strictEqual(error.name, 'AbortError');
    assert.strictEqual(error.code, 'ABORT_ERR');
    assert.strictEqual(error.cause, reason);
    await closed;
  }
  const cancelBaseline = nextFd();
  // A literal starts on the next microtask. Destroy on the following microtask
  // exercises an allocated native connect watch or a late immediate completion.
  for (let i = 0; i < 20; i++) {
    const socket = new net.Socket();
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.on('error', () => {});
    socket.connect({ host:'127.0.0.1', port:1 });
    queueMicrotask(() => socket.destroy());
    await closed;
  }
  assert.strictEqual(nextFd(), cancelBaseline, 'cancelled connects leaked descriptors');
  console.log('node-network-client-ok');
})().catch(error => { console.error(error); peer.kill(); process.exitCode = 1; });
