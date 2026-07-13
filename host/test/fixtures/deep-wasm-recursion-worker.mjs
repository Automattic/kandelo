import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const bytes = readFileSync(workerData.wasmPath);
const { instance } = await WebAssembly.instantiate(bytes);
const recurse = instance.exports.recurse;
parentPort.postMessage({ result: recurse(workerData.depth) });
