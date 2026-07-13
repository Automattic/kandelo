import { parentPort, workerData } from "node:worker_threads";

const words = new Int32Array(workerData);
const namespaceLockIndex = 64 / Int32Array.BYTES_PER_ELEMENT;
Atomics.store(words, namespaceLockIndex, 1);
parentPort.postMessage("locked");
setTimeout(() => {
  Atomics.store(words, namespaceLockIndex, 0);
  Atomics.notify(words, namespaceLockIndex);
}, 100);
