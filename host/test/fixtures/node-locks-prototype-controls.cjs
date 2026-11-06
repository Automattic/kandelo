'use strict';
// Exact native26/receiver differentials. All inherited setters are scoped to
// this fixture and restored; product code neither patches nor suppresses them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const worker = require('node:worker_threads');
const mode = process.argv[2] || 'native';
const selected = process.argv[4];
const root = path.resolve(__dirname, '../../..');
let locks = worker.locks, addon, armReceiver;
let armed = false, insideNative = false, insideSetter = false;
let current, descriptor, installed = false;
function restore() {
    if (!installed) return;
    if (descriptor) Object.defineProperty(Array.prototype, '0', descriptor);
    else delete Array.prototype[0];
    installed = false;
}
function install() {
    assert.equal(installed, false);
    descriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0');
    installed = true;
    Object.defineProperty(Array.prototype, '0', { configurable: true,
        set(value) {
            const victim = value && typeof value === 'object' && typeof value.id === 'number' &&
                value.entry && value.error?.message === 'LOCK_STOLEN';
            if (!victim && !insideNative) {
                current.unrelatedSetters++;
                Object.defineProperty(this, '0', { value, writable: true, enumerable: true, configurable: true });
                return;
            }
            if (victim) current.receiverSetters++; else current.packetSetters++;
            restore();
            insideSetter = true;
            try {
                if (current.attack === 'throw') throw new Error('Inherited indexed setter ran');
                if (current.attack === 'reenter') {
                    current.reentry = locks.request('prototype-reentry-' + current.name, () => 'reentered');
                    current.reentry.catch(() => {});
                    Object.defineProperty(this, '0', { value, writable: true, enumerable: true, configurable: true });
                }
                // drop returns without creating the indexed data property.
            } finally { insideSetter = false; }
        },
    });
}
if (mode === 'adapter') {
    const { internalBinding } = require('internal/test/binding');
    const markPromiseAsHandled = internalBinding('util').markPromiseAsHandled;
    const P = Function('primordials', fs.readFileSync(path.join(root, 'third_party/node-core/upstream/primordials.js'), 'utf8') + '\nreturn primordials;')({});
    // An optional fixture-only preimage exercises the same assertions against
    // a recorded old receiver. Production has no alternate source path.
    const source = fs.readFileSync(process.env.KANDELO_LOCKS_ADAPTER_SOURCE || path.join(root, 'third_party/node-core/locks-platform-adapter.js'), 'utf8')
        .replace('/* NODE_LOCKS_MODULE */', fs.readFileSync(path.join(root, 'third_party/node-core/upstream/locks/lib/internal/locks.js'), 'utf8'));
    const create = Function('_createNodePrimordials', source + '\nreturn _createNodeLocksPlatform;')(() => P);
    addon = require(process.argv[3]);
    const native = (...args) => {
        insideNative = true;
        let result;
        try { result = addon.locks(...args); } finally { insideNative = false; }
        // Packet construction has completed before arming this mode. It tests
        // receiver mutation even if a future fixture regresses to assignment.
        if (armed && armReceiver && args[0] === 'next' && result?.localStolen.length && !installed) install();
        return result;
    };
    const platform = create({ process, worker, diagnostics: require('node:diagnostics_channel'),
        types: require('node:util/types'), values: { errors: require('internal/errors'), util: require('internal/util'), validators: require('internal/validators') },
        eventRequire: name => require(name), native: { locks: native, markPromiseAsHandled } });
    const target = {}; platform.install(target); locks = target.locks;
}
function watch(promise, state, key) {
    state[key] = 'pending';
    return promise.then(value => { state[key] = 'resolved:' + value; return value; }, error => {
        state[key] = 'rejected:' + error.name + ':' + error.message;
        return undefined;
    });
}
async function steal(stage, attack) {
    const name = 'indexed-prototype-' + stage + '-' + attack;
    current = { name, attack, receiverSetters: 0, packetSetters: 0, unrelatedSetters: 0 };
    const state = Object.create(null);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = watch(locks.request(name, { mode: 'shared' }, () => gate), state, 'first');
    const second = watch(locks.request(name, { mode: 'shared' }, () => gate), state, 'second');
    assert.equal((await locks.query()).held.filter(info => info.name === name).length, 2);
    let callbackRan = false, callbackInsideSetter = false, thief;
    armed = true; armReceiver = stage === 'receiver';
    try {
        if (!armReceiver) install();
        thief = watch(locks.request(name, { steal: true }, () => {
            callbackRan = true; callbackInsideSetter = insideSetter; return 'stolen-value';
        }), state, 'thief');
    } finally { armed = false; restore(); }
    await new Promise(setImmediate); // actual completion checkpoint
    const beforeGate = { ...state };
    const snapshot = await locks.query();
    release('holder-value'); await Promise.all([first, second, thief]);
    if (current.reentry) await current.reentry;
    const result = { stage, attack, receiverSetters: current.receiverSetters, packetSetters: current.packetSetters,
        unrelatedSetters: current.unrelatedSetters, callbackRan, callbackInsideSetter, beforeGate,
        held: snapshot.held.filter(info => info.name === name).length,
        pending: snapshot.pending.filter(info => info.name === name).length };
    assert.equal(result.receiverSetters, 0, 'receiver must define own victim roots before commit');
    assert.equal(result.packetSetters, 0, 'native packet fixture must mirror production own definitions');
    assert.equal(callbackRan, true); assert.equal(callbackInsideSetter, false);
    assert.deepEqual(beforeGate, { first: 'rejected:AbortError:The operation was aborted',
        second: 'rejected:AbortError:The operation was aborted', thief: 'resolved:stolen-value' });
    assert.equal(result.held, 0); assert.equal(result.pending, 0);
    return result;
}
async function queryPacket() {
    const name = 'prototype-query-packet';
    let release; const gate = new Promise(resolve => { release = resolve; });
    const held = locks.request(name, () => gate);
    current = { name, attack: 'throw', receiverSetters: 0, packetSetters: 0, unrelatedSetters: 0 };
    let query;
    try { install(); query = locks.query(); } finally { restore(); }
    let snapshot;
    try {
        snapshot = await query;
        if (mode === 'adapter') {
            // Keep the holder live while directly bracketing the addon, so
            // this query must actually construct a nonempty native array.
            try { install(); insideNative = true; addon.locks('query'); }
            finally { insideNative = false; restore(); }
        }
    } finally { release('query-value'); await held; }
    assert.equal(current.packetSetters, 0, 'query packet arrays must define own elements');
    const index = snapshot.held.findIndex(info => info.name === name);
    assert(index >= 0); assert.equal(Object.hasOwn(snapshot.held, index), true);
    const result = { name: 'query packet own elements', packetSetters: current.packetSetters };
    return result;
}
(async () => {
    const results = [];
    for (const stage of mode === 'adapter' ? ['global', 'receiver'] : ['global']) {
        for (const attack of ['drop', 'throw', 'reenter']) {
            if (selected && selected !== stage + ':' + attack) continue;
            results.push(await steal(stage, attack));
        }
    }
    if (!selected) results.push(await queryPacket());
    console.log(JSON.stringify({ mode, node: process.version, passed: true, results,
        scope: 'indexed own-operation and real portable receiver/Promise controls only; no guest JSAPI, global lazy-data or four-host acceptance' }));
})().catch(error => { restore(); console.error(error); process.exitCode = 1; });
