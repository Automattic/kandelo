import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { PolicyWorkerFactory } from "./program-policy";
import { NodeWorkerHandle } from "./worker-adapter";

export const createNodePolicyWorker: PolicyWorkerFactory = Object.assign((request: Parameters<PolicyWorkerFactory>[0]) => {
  const source = new URL("./program-policy-node-worker.ts", import.meta.url);
  const entry = existsSync(fileURLToPath(source)) ? source : new URL("./program-policy-node-worker.js", import.meta.url);
  return new NodeWorkerHandle(new Worker(entry, { workerData: request, resourceLimits: { stackSizeMb: 4, maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } }));
}, { workspaceOverheadBytes: 44 * 1024 * 1024 });
