'use strict';
// Native26 reference questions kept separate from candidate acceptance.
// Output reports observations, including lack of automatic teardown progress;
// it never changes target identity or turns a diagnostic into a passing test.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Worker, locks } = require('node:worker_threads');
const { once } = require('node:events');
async function run() {
    const liveness = spawnSync(process.execPath, ['-e', `
        const { locks } = require('node:worker_threads');
        locks.request('unresolved', () => new Promise(() => {}));
        locks.request('unresolved', () => console.log('unexpected grant'));
        console.log('unresolved held and pending');
    `], { timeout: 5000, encoding: 'utf8' });
    assert.equal(liveness.status, 0); assert.equal(liveness.signal, null);
    assert.equal(liveness.stdout.trim(), 'unresolved held and pending');
    const worker = new Worker(`
        const { parentPort, locks } = require('node:worker_threads');
        locks.request('worker-held', () => {
            parentPort.postMessage('held');
            return new Promise(() => {});
        });
        parentPort.on('message', async () => parentPort.postMessage(await locks.query()));
    `, { eval: true });
    const first = await once(worker, 'message'); assert.equal(first[0], 'held');
    const parentSnapshot = await locks.query();
    assert.equal(parentSnapshot.held.some(x => x.name === 'worker-held'), false);
    const queried = once(worker, 'message'); worker.postMessage('query');
    const childSnapshot = (await queried)[0];
    assert.equal(childSnapshot.held.some(x => x.name === 'worker-held'), true);
    let granted = false;
    const pending = locks.request('worker-held', () => { granted = true; return 'after-teardown'; });
    const pendingSnapshot = await locks.query();
    assert.equal(pendingSnapshot.pending.some(x => x.name === 'worker-held'), true);
    await worker.terminate();
    // A timer merely allows the native loop to process a real scheduled wake;
    // it does not invoke LockManager's queue processor itself.
    await new Promise(resolve => setTimeout(resolve, 100));
    const progressWithoutAnotherLockRequest = granted;
    await locks.request('explicit-queue-trigger', () => {});
    assert.equal(await pending, 'after-teardown');
    console.log(JSON.stringify({ version: process.version, platform: process.platform, arch: process.arch,
        unresolvedHeldAndPendingKeepAlive: false, queryVisibility: 'calling environment only',
        progressWithoutAnotherLockRequest, progressAfterExplicitLockRequest: granted,
        scope: 'Exact native26 liveness/query/worker-teardown reference observations; no guest evidence' }));
}
const deadline = setTimeout(() => { console.error('Reference control timed out'); process.exit(1); }, 5000);
run().then(() => clearTimeout(deadline), error => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
