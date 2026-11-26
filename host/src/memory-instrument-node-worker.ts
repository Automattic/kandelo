import { parentPort, workerData } from "node:worker_threads";
import { rewriteProgramInWorker, type ProgramRewriteRequest } from "./memory-instrument-worker.ts";

if (!parentPort) throw new Error("Program rewrite entry requires a worker");
const response = rewriteProgramInWorker(workerData as ProgramRewriteRequest);
parentPort.postMessage(response, response.kind === "rewritten" ? [response.program] : []);
