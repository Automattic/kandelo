'use strict';
// Run unchanged in the pinned native reference and the actual guest package.
// This exercises guest-local UDP; it says nothing about raw Internet egress.
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { AsyncLocalStorage, createHook, executionAsyncId } = require('node:async_hooks');
const { BlockList } = require('node:net');

async function close(socket) {
    const done = once(socket, 'close'); socket.close(); await done;
}
async function send(socket, bytes, port, address) {
    return new Promise((resolve, reject) => {
        const callback = (error, sent) => error ? reject(error) : resolve(sent);
        if (port === undefined) socket.send(bytes, callback);
        else socket.send(bytes, port, address, callback);
    });
}
async function family(type, address) {
    const receiver = dgram.createSocket(type);
    const sender = dgram.createSocket(type);
    assert.equal(Object.getPrototypeOf(receiver), dgram.Socket.prototype);
    let listening = false;
    receiver.once('listening', () => { listening = true; });
    const local = receiver.bindSync({ port: 0, address });
    assert.equal(listening, false);
    assert.equal(local.address, address);
    assert.equal(local.family, type === 'udp4' ? 'IPv4' : 'IPv6');
    assert.ok(local.port > 0);
    assert.deepEqual(receiver.address(), local);
    await once(receiver, 'listening');
    assert.equal(listening, true);
    assert.throws(() => receiver.bindSync(), { code: 'ERR_SOCKET_ALREADY_BOUND' });
    const duplicate = dgram.createSocket(type);
    assert.throws(() => duplicate.bindSync({ port: local.port, address }), { code: 'EADDRINUSE', syscall: 'bind' });
    duplicate.bindSync({ address });
    await close(duplicate);

    sender.bindSync({ address });
    const messages = [];
    receiver.on('message', (buffer, rinfo) => {
        assert.ok(Buffer.isBuffer(buffer));
        assert.equal(rinfo.address, address);
        assert.equal(rinfo.family, local.family);
        assert.equal(rinfo.size, buffer.length);
        assert.equal(rinfo.port, sender.address().port);
        messages.push([...buffer]);
    });
    let next = once(receiver, 'message');
    const backing = new Uint8Array([99, 0, 1, 0xff, 0, 98]);
    assert.equal(await send(sender, new DataView(backing.buffer, 1, 4), local.port, address), 4);
    await next;
    next = once(receiver, 'message');
    assert.equal(await send(sender, [Buffer.from('a'), new Uint8Array([0, 0xff]), 'z'], local.port, address), 4);
    await next;
    next = once(receiver, 'message');
    assert.equal(await send(sender, Buffer.alloc(0), local.port, address), 0);
    await next;
    assert.deepEqual(messages, [[0, 1, 0xff, 0], [97, 0, 0xff, 122], []]);
    sender.connectSync(local.port, address);
    assert.deepEqual(sender.remoteAddress(), local);
    assert.throws(() => sender.send(Buffer.from('x'), 0, 1, local.port, address), { code: 'ERR_SOCKET_DGRAM_IS_CONNECTED' });
    next = once(receiver, 'message');
    assert.equal(await send(sender, 'connected'), 9); await next;
    sender.disconnect();
    assert.throws(() => sender.remoteAddress(), { code: 'ERR_SOCKET_DGRAM_NOT_CONNECTED' });
    assert.equal(sender.getSendQueueSize(), 0); assert.equal(sender.getSendQueueCount(), 0);
    sender.unref(); sender.ref();
    assert.equal(sender.setTTL(64), 64);
    assert.throws(() => sender.setTTL(0), { code: 'EINVAL' });
    sender.setBroadcast(true);
    await close(sender); await close(receiver);
    assert.throws(() => receiver.address(), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
}
async function lifecycle() {
    const storage = new AsyncLocalStorage();
    let receiver, receiverId;
    const hooks = [];
    const hook = createHook({ init(id, type, trigger, resource) {
        if (type === 'UDPWRAP') { hooks.push(id); if (storage.getStore() === 'udp-owner') receiverId = id; }
    } }).enable();
    storage.run('udp-owner', () => {
        receiver = dgram.createSocket('udp4'); receiver.bindSync({ address: '127.0.0.1' });
    });
    const sender = dgram.createSocket('udp4');
    const message = new Promise((resolve, reject) => {
        receiver.once('message', () => {
            try {
                assert.equal(storage.getStore(), 'udp-owner');
                assert.equal(executionAsyncId(), receiverId); resolve();
            } catch (error) { reject(error); }
        });
    });
    await send(sender, 'scope', receiver.address().port, '127.0.0.1'); await message;
    assert.equal(hooks.length, 2);
    await close(sender); await close(receiver); hook.disable();
}
async function liveRulesAndAbort() {
    const rules = new BlockList();
    const receiver = dgram.createSocket('udp4'); receiver.bindSync({ address: '127.0.0.1' });
    const sender = dgram.createSocket({ type: 'udp4', sendBlockList: rules });
    let next = once(receiver, 'message');
    await send(sender, 'allowed', receiver.address().port, '127.0.0.1'); await next;
    rules.addAddress('127.0.0.1');
    await assert.rejects(send(sender, 'blocked', receiver.address().port, '127.0.0.1'), { code: 'ERR_IP_BLOCKED' });
    await close(sender); await close(receiver);
    const controller = new AbortController();
    const aborted = dgram.createSocket({ type: 'udp4', signal: controller.signal });
    aborted.bindSync({ address: '127.0.0.1' });
    next = once(aborted, 'close'); controller.abort(); await next;
    assert.throws(() => aborted.address(), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
}
async function pendingLookupClose() {
    let resolveLookup, listening = false;
    const socket = dgram.createSocket({ type: 'udp4', lookup(address, family, callback) {
        assert.equal(address, 'pending.test'); assert.equal(family, 4); resolveLookup = callback;
    } });
    socket.once('listening', () => { listening = true; });
    socket.bind(0, 'pending.test');
    assert.equal(typeof resolveLookup, 'function');
    await close(socket);
    resolveLookup(null, '127.0.0.1', 4);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(listening, false);
}
(async () => {
    await family('udp4', '127.0.0.1'); await family('udp6', '::1');
    await lifecycle(); await liveRulesAndAbort(); await pendingLookupClose();
    console.log(JSON.stringify({ suite: 'datagram-public-controls', version: process.version,
        platform: process.platform, scope: 'guest-local IPv4/IPv6, actual UDP owners', status: 'PASS' }));
})().catch(error => { console.error(error); process.exit(1); });
