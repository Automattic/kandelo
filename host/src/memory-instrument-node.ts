import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { ProgramRewriteWorkerFactory } from "./program-rewriter";
import { NodeWorkerHandle } from "./worker-adapter";

export const createNodeProgramRewriteWorker: ProgramRewriteWorkerFactory = (request) => {
  const source = new URL("./memory-instrument-node-worker.ts", import.meta.url);
  const entry = existsSync(fileURLToPath(source)) ? source : new URL("./memory-instrument-node-worker.js", import.meta.url);
  return new NodeWorkerHandle(new Worker(entry, { workerData: request }));
};
