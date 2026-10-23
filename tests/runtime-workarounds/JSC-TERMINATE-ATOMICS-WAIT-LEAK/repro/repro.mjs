// Standalone reproduction for JavaScript hosts (Bun, Node.js); nothing here
// comes from Kandelo. Run: `bun repro.mjs` or `node repro.mjs`.
// The last line printed is `REPRO-VERDICT {"verdict":...,"details":...}`.
//
// The same question as repro.html, for `node:worker_threads`: after the
// parent calls terminate() on a worker blocked in an infinite atomic wait,
// is that worker still waiting? Atomics.notify() returns how many waiters
// it woke, so a count above 0 some time after terminate() means the
// terminated worker is still parked, and its thread and memory cannot be
// released. Both JavaScript Atomics.wait and WebAssembly
// memory.atomic.wait32 are tested. A blocked worker that is not terminated
// must be counted (sanity check), or the verdict is inconclusive.
//
// The details also say how many terminate() promises settled. Node.js
// documents that terminate() stops all JavaScript in the worker "as soon as
// possible" and returns a promise fulfilled when the 'exit' event fires.
import { Worker } from 'node:worker_threads';

const ROUNDS = 2;
const BLOCK_SETTLE_MS = 300;
const TERMINATE_SETTLE_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// (module (import "env" "memory" (memory 1 16384 shared))
//   (func (export "wait") (param i32 i64) (result i32)
//     (memory.atomic.wait32 (local.get 0) (i32.const 0) (local.get 1))))
const wasmBytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  1, 0x07, 1, 0x60, 2, 0x7f, 0x7e, 1, 0x7f,
  2, 0x12, 1, 3, 0x65, 0x6e, 0x76, 6, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 2, 3, 1, 0x80, 0x80, 1,
  3, 2, 1, 0,
  7, 0x08, 1, 4, 0x77, 0x61, 0x69, 0x74, 0, 0,
  0x0a, 0x0e, 1, 0x0c, 0, 0x20, 0, 0x41, 0, 0x20, 1, 0xfe, 1, 2, 0, 0x0b]);

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { memory, how, bytes } = workerData;
// Commit 16 MiB so the worker holds real memory.
const view = new Int32Array(memory.buffer);
for (let i = 1024; i < view.length; i += 1024) view[i] = i;
const wait = how === 'wasm'
  ? new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports.wait
  : null;
parentPort.postMessage('blocking');
// Word 0 is never changed, so either wait lasts until notified.
if (wait) wait(0, -1n); else Atomics.wait(view, 0, 0);
parentPort.postMessage('woke');
`;

async function blockedWorker(how) {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
  const worker = new Worker(workerSource, { eval: true, workerData: { memory, how, bytes: wasmBytes } });
  await new Promise((resolve, reject) => {
    worker.on('message', (m) => { if (m === 'blocking') resolve(); });
    worker.on('error', reject);
  });
  await sleep(BLOCK_SETTLE_MS);
  return { worker, word: new Int32Array(memory.buffer) };
}

async function main() {
  const results = {};
  const terminations = {};
  for (const how of ['js', 'wasm']) {
    const live = await blockedWorker(how);
    const liveCount = Atomics.notify(live.word, 0);
    await live.worker.terminate();
    if (liveCount !== 1) {
      return { verdict: 'inconclusive', details: `${how}: notify counted ${liveCount} waiters for a live blocked worker (expected 1)` };
    }
    const counts = [];
    let settled = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const { worker, word } = await blockedWorker(how);
      // Do not await: a terminate() that never completes is the defect.
      let done = false;
      worker.terminate().then(() => { done = true; }, () => { done = true; });
      await sleep(TERMINATE_SETTLE_MS);
      if (done) settled++;
      counts.push(Atomics.notify(word, 0));
    }
    results[how] = counts;
    terminations[how] = settled;
    console.log(`${how}: waiters still parked after terminate(): ${counts.join(', ')}`);
  }
  const still = Object.entries(results).filter(([, counts]) => counts.some((c) => c > 0));
  const summary = Object.entries(results)
    .map(([how, counts]) => `${how} [${counts.join(',')}], ${terminations[how]}/${counts.length} terminate() settled before notify`)
    .join('; ');
  return still.length
    ? { verdict: 'reproduced', details: `terminated workers still waiting (${still.map(([how]) => how).join(', ')}): ${summary}` }
    : { verdict: 'not-reproduced', details: `no terminated worker still waiting: ${summary}` };
}

let verdict;
try {
  verdict = await main();
} catch (error) {
  verdict = { verdict: 'inconclusive', details: `repro failed: ${error}` };
}
console.log('REPRO-VERDICT ' + JSON.stringify(verdict));
process.exit(0);
