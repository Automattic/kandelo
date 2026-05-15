// Re-exports for the in-page kernel-host layer. The interface + LiveKernelHost
// live in host/src/kandelo-ui/; only the page-local pieces are exported here.

export * from "../../../../../host/src/kandelo-ui/kernel-host";
export { MockKernelHost } from "./mock";
export type { MockKernelHostOptions } from "./mock";
export {
  KernelHostProvider, useKernelHost, useStatus, useDmesg, useSnapshot,
} from "./react";
