/**
 * Node's kgpu GPU worker: `worker_threads` running `kgpu/gpu-worker-node`,
 * as `program-policy-node.ts` runs its worker.
 *
 * WHY a renderer only on request: Node has no WebGL 2, so a Node kernel has
 * no renderer -- guest context creation answers ENODEV -- unless the
 * embedder supplies a WebGL 2 factory module (`kgpuWebGL2Factory`), whose
 * `createWebGL2Context()` the GPU worker calls. Only then is the executor
 * module resolved and the renderer set.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { resolveBinary } from "./binary-resolver";
import type { KgpuHostConfig } from "./kgpu/kgpu-host";
import { NodeWorkerHandle, type WorkerHandle } from "./worker-adapter";

export function createNodeGpuWorker(): WorkerHandle {
  // Source checkouts run the TypeScript entry (Node strips its types); the
  // published package runs tsup's output beside this module's bundle.
  const source = new URL("./kgpu/gpu-worker-node.ts", import.meta.url);
  const entry = existsSync(fileURLToPath(source)) ? source : new URL("./kgpu/gpu-worker-node.js", import.meta.url);
  return new NodeWorkerHandle(new Worker(entry, {
    resourceLimits: { stackSizeMb: 4, maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
  }));
}

export function nodeKgpuConfig(webgl2Factory: string | undefined): KgpuHostConfig {
  if (webgl2Factory === undefined) return { renderer: "null", createWorker: createNodeGpuWorker };
  const executorBytes = Uint8Array.from(readFileSync(resolveBinary("kandelo_gpu_executor32.wasm"))).buffer;
  return { renderer: "webgl2", createWorker: createNodeGpuWorker, executor: { executorBytes }, webgl2Factory };
}
