import { Worker } from 'node:worker_threads';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadavg } from 'node:os';
const [root, output] = process.argv.slice(2).map(p => resolve(p));
if (existsSync(output)) throw Error('fresh output required');
const loadBefore = loadavg(), started = performance.now();
const worker = new Worker(new URL('./worker-cross-host-node.mjs', import.meta.url), { workerData: { root } });
let result, exitCode;
const timeout = setTimeout(() => { void worker.terminate(); }, 60000);
try {
  worker.once('message', value => { result = value; });
  exitCode = await new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
} finally { clearTimeout(timeout); await worker.terminate(); }
writeFileSync(output, JSON.stringify({ runtime: process.version, flags: process.execArgv, loadBefore, loadAfter: loadavg(), wallMs: performance.now() - started, exitCode, workerExited: true, probe: result }, null, 2) + '\n');
if (exitCode !== 0 || !result?.passed) throw Error('Node cost screen failed; see ' + output);
console.log(JSON.stringify({ passed: true, output, samples: result.samples.length, guardChecks: result.guardChecks }));
