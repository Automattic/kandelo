import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { runBreadthProbe } from './cross-host-probe.mjs';
try {
  const read = name => readFileSync(workerData.root + '/' + name);
  parentPort.postMessage(runBreadthProbe({ single: read('single.wasm'), dual: read('dual.wasm'), translated: read('single-vm.wasm') }));
} catch (error) {
  parentPort.postMessage({ passed: false, error: String(error.stack || error) });
  process.exitCode = 1;
}
parentPort.close();
