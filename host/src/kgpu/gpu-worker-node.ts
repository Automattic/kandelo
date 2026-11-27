/**
 * Node entry of the GPU worker (`gpu-worker.ts`), run with `worker_threads`
 * by the Node kernel worker's `createWorker` (as `program-policy-node.ts`
 * runs its worker). The first message on the worker's channel is the init
 * message; the single ready/failed report goes back the same way.
 */
import { parentPort } from "node:worker_threads";
import { startGpuWorker } from "./gpu-worker.ts";

if (!parentPort) throw new Error("GPU worker entry requires a worker");
const port = parentPort;
port.once("message", (message: unknown) => {
  void startGpuWorker(message, (report) => port.postMessage(report));
});
