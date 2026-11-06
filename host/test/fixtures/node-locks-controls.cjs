'use strict';
// Identical public assertions for exact native26 and the portable native-owner
// adapter harness. The harness is not a guest JSAPI/event-loop acceptance run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dc = require('node:diagnostics_channel');
const workerThreads = require('node:worker_threads');
const mode = process.argv[2] || 'native';
const root = path.resolve(__dirname, '../../..');
let api = workerThreads, adapter;
if (mode === 'adapter') {
    const globals = ['internalBinding', 'primordials'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    const { internalBinding } = require('internal/test/binding');
    const markPromiseAsHandled = internalBinding('util').markPromiseAsHandled;
    for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }

    const primordials = Function('primordials', fs.readFileSync(path.join(root,
        'third_party/node-core/upstream/primordials.js'), 'utf8') + '\nreturn primordials;')({});
    const publicSource = fs.readFileSync(path.join(root,
        'third_party/node-core/upstream/locks/lib/internal/locks.js'), 'utf8');
    const adapterSource = fs.readFileSync(path.join(root,
        'third_party/node-core/locks-platform-adapter.js'), 'utf8').replace('/* NODE_LOCKS_MODULE */', publicSource);
    const create = Function('_createNodePrimordials', adapterSource + '\nreturn _createNodeLocksPlatform;')(() => primordials);
    api = {};
    adapter = create({
        process, worker: workerThreads, diagnostics: dc, types: require('node:util/types'),
        values: { errors: require('internal/errors'), util: require('internal/util'), validators: require('internal/validators') },
        eventRequire: name => require(name),
        native: { locks: require(process.argv[3]).locks, markPromiseAsHandled },
    });
    adapter.install(api);
}
const { locks } = api;
const results = [];
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function test(name, action) {
    let timer;
    try {
        await Promise.race([action(), new Promise((_, no) => { timer = setTimeout(() => no(new Error('Timed out: ' + name)), 5000); })]);
        results.push({ name, passed: true });
    } finally { clearTimeout(timer); }
}
(async () => {
    await test('public result, metadata and borrowed request', async () => {
        let called = false;
        const promise = locks.request('metadata', lock => {
            called = true;
            assert.equal(lock.name, 'metadata'); assert.equal(lock.mode, 'exclusive');
            assert.equal(Object.prototype.toString.call(lock), '[object Lock]');
            for (const key of ['name', 'mode']) {
                const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lock), key);
                assert.equal(descriptor.enumerable, true); assert.equal(descriptor.set, undefined);
            }
            return 17;
        });
        assert.equal(called, true); assert.equal(await promise, 17);
        assert.equal(await locks.request.call({}, 'borrowed', () => 23), 23);
        assert.equal(Object.prototype.toString.call(locks), '[object LockManager]');
        const descriptor = Object.getOwnPropertyDescriptor(api, 'locks');
        assert.equal(descriptor.enumerable, true); assert.equal(descriptor.configurable, true); assert.equal(descriptor.writable, true);
        await assert.rejects(locks.query.call({}), TypeError);
        assert.throws(() => new locks.constructor(), TypeError);
    });
    await test('conversion and incompatible option rejections', async () => {
        assert.equal(await locks.request({ toString: () => 'coerced' }, lock => lock.name), 'coerced');
        for (const [name, options, expected] of [
            ['-private', {}, 'NotSupportedError'], ['x', { steal: true, ifAvailable: true }, 'NotSupportedError'],
            ['x', { mode: 'shared', steal: true }, 'NotSupportedError'],
            ['x', { signal: new AbortController().signal, ifAvailable: true }, 'NotSupportedError'],
            ['x', { mode: 'other' }, 'TypeError'], ['x', { signal: {} }, 'TypeError'],
        ]) await assert.rejects(locks.request(name, options, () => {}), error => error.name === expected);
        await assert.rejects(locks.request('x', 7), TypeError);
        const abort = new AbortController(); abort.abort('already-aborted');
        await assert.rejects(locks.request('x', { signal: abort.signal }, () => {}), reason => reason === 'already-aborted');
    });
    await test('shared coexistence and pending exclusive ordering', async () => {
        const hold = gate(), order = [];
        const a = locks.request('ordered', { mode: 'shared' }, () => { order.push('a'); return hold.promise; });
        const another = locks.request('ordered', { mode: 'shared' }, () => { order.push('another'); return hold.promise; });
        const b = locks.request('ordered', () => { order.push('b'); return 'b'; });
        const c = locks.request('ordered', { mode: 'shared' }, () => { order.push('c'); return 'c'; });
        assert.deepEqual(order, ['a', 'another']);
        const snapshot = await locks.query();
        assert.equal(snapshot.held.filter(x => x.name === 'ordered').length, 2);
        assert.deepEqual(snapshot.pending.filter(x => x.name === 'ordered').map(x => x.mode), ['exclusive', 'shared']);
        for (const info of snapshot.held) assert.equal(info.clientId, `node-${process.pid}-${workerThreads.threadId}`);
        hold.resolve(); await Promise.all([a, another, b, c]);
        assert.deepEqual(order, ['a', 'another', 'b', 'c']);
    });
    await test('ifAvailable miss, independent reentry and same-name reentry', async () => {
        const hold = gate();
        const active = locks.request('reentry', async () => {
            assert.equal(await locks.request('reentry', { ifAvailable: true }, lock => lock), null);
            assert.equal(await locks.request('independent', () => 'nested'), 'nested');
            await hold.promise;
        });
        assert.equal(await locks.request('reentry', { ifAvailable: true }, lock => lock), null);
        hold.resolve(); await active;
    });
    await test('pending-only abort remains queued and suppresses callback', async () => {
        const hold = gate(), controller = new AbortController(); let called = false;
        const active = locks.request('abort', () => hold.promise);
        const pending = locks.request('abort', { signal: controller.signal }, () => { called = true; });
        controller.abort('pending-abort');
        await assert.rejects(pending, reason => reason === 'pending-abort');
        assert.equal((await locks.query()).pending.filter(x => x.name === 'abort').length, 1);
        hold.resolve(); await active;
        await locks.request('abort', () => {});
        assert.equal(called, false);
        const granted = new AbortController();
        assert.equal(await locks.request('granted-abort', { signal: granted.signal }, () => { granted.abort(); return 91; }), 91);
    });
    await test('steal rejects holder and does not resurrect it on callback completion', async () => {
        const hold = gate();
        const victim = locks.request('steal', () => hold.promise);
        const rejection = assert.rejects(victim, error => error.name === 'AbortError');
        assert.equal(await locks.request('steal', { steal: true }, () => 29), 29);
        await rejection; hold.resolve(31);
        await locks.request('steal', () => 37);
        assert.equal((await locks.query()).held.some(x => x.name === 'steal'), false);
    });
    await test('Promise rejection releases, thenable result releases before assimilation', async () => {
        const reason = new Error('callback-rejection');
        await assert.rejects(locks.request('reject', () => Promise.reject(reason)), error => error === reason);
        assert.equal((await locks.query()).held.some(x => x.name === 'reject'), false);
        let seen;
        assert.equal(await locks.request('thenable', () => ({ then(resolve) {
            seen = locks.query().then(snapshot => snapshot.held.some(x => x.name === 'thenable'));
            resolve(41);
        } })), 41);
        assert.equal(await seen, false);
    });
    await test('pinned synchronous callback throw retains holder until steal/teardown', async () => {
        await assert.rejects(locks.request('throw-retains', () => { throw 43; }), error => error === 43);
        assert.equal((await locks.query()).held.some(x => x.name === 'throw-retains'), true);
        await locks.request('throw-retains', { steal: true }, () => {});
        assert.equal((await locks.query()).held.some(x => x.name === 'throw-retains'), false);
    });
    await test('lock names preserve NUL and unpaired UTF16 code units', async () => {
        for (const name of ['embedded\0name', '\ud800', '']) assert.equal(await locks.request(name, lock => lock.name), name);
    });
    await test('real diagnostic start/grant/miss/end channels', async () => {
        const events = [], channels = ['start', 'grant', 'miss', 'end'];
        const listeners = channels.map(kind => value => { if (value.name === 'diagnostic') events.push(kind); });
        channels.forEach((kind, index) => dc.subscribe('locks.request.' + kind, listeners[index]));
        try {
            const hold = gate(), active = locks.request('diagnostic', () => hold.promise);
            await locks.request('diagnostic', { ifAvailable: true }, () => {});
            hold.resolve(); await active;
            assert.deepEqual(events, ['start', 'grant', 'start', 'miss', 'end', 'end']);
        } finally { channels.forEach((kind, index) => dc.unsubscribe('locks.request.' + kind, listeners[index])); }
    });
    console.log(JSON.stringify({ mode, node: process.version, platform: process.platform, arch: process.arch, passed: true, results,
        scope: mode === 'native' ? 'Exact native target public controls' : 'Pinned public source and candidate adapter over same portable C++ owner through fixture Node-API; not guest JSAPI/event-loop validation' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
