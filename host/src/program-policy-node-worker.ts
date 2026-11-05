import { parentPort, workerData } from "node:worker_threads";
import { inspectPolicyInWorker, type PolicyWorkerRequest } from "./program-policy-worker.ts";

if (!parentPort) throw new Error("Program policy entry requires a worker");
parentPort.postMessage(inspectPolicyInWorker(workerData as PolicyWorkerRequest));
