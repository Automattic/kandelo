/**
 * The browser's kgpu GPU worker: a module Worker running `kgpu/gpu-worker`,
 * whose renderer is a WebGL 2 context on its own OffscreenCanvas.
 *
 * WHY the executor URL comes from the embedder: the executor module is a
 * build artifact (`kandelo_gpu_executor32.wasm`) the deployment serves, like
 * the kernel. Without its URL, or without OffscreenCanvas in this realm,
 * the machine has no renderer and kgpu context creation answers ENODEV. A
 * realm that has OffscreenCanvas but cannot create WebGL 2 learns so when
 * the worker starts; its failure resets the device.
 */
import gpuWorkerUrl from "./kgpu/gpu-worker.ts?worker&url";
import type { KgpuHostConfig } from "./kgpu/kgpu-host";
import { wrapBrowserWorker } from "./worker-adapter-browser";

export function browserKgpuConfig(executorUrl: string | undefined): KgpuHostConfig {
  // Module Workers, like every Kandelo Worker (see BrowserWorkerAdapter).
  const createWorker = () => wrapBrowserWorker(new Worker(gpuWorkerUrl, { type: "module" }));
  if (executorUrl === undefined || typeof OffscreenCanvas !== "function") return { renderer: "null", createWorker };
  return { renderer: "webgl2", createWorker, executor: { executorUrl } };
}
