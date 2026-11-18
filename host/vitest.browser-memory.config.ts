import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import base from "./vitest.config.ts";

// This same source-only selection runs locally and in the browser smoke CI.
// No global fixture compiler: these cases need no guest binaries or images.
const include = [
  "test/advisory-lock-retry.test.ts",
  "test/channel-listener-admission.test.ts",
  "test/channel-listener-scheduling.test.ts",
  "test/clone-tid-authority.test.ts",
  "test/datagram-wakeup.test.ts",
  "test/deferred-worker-start.test.ts",
  "test/dri-ioctl-interrupt.test.ts",
  "test/file-shared-memory.test.ts",
  "test/kernel-clone-exit-entry.test.ts",
  "test/kernel-ipc-shmat-entry.test.ts",
  "test/kernel-worker-copyback.test.ts",
  "test/process-wait-lifecycle.test.ts",
  "test/shared-memory-coherence.test.ts",
  "test/signal-accept-livelock.test.ts",
  "test/startup-metadata-capacity.test.ts",
  "test/memory-group-admission.test.ts",
  "test/process-address-space.test.ts",
  "test/process-memory-views.test.ts",
  "test/process-memory-descriptor.test.ts",
  "test/memory-group-image-store.test.ts",
  "test/memory-group-import-guard.test.ts",
  "test/grouped-worker-initialization.test.ts",
  "test/channel-completion-wait.test.ts",
  "test/dylink-fork-archive.test.ts",
  "test/fork-module-state.test.ts",
  "test/kernel-public-scratch.test.ts",
  "test/kernel-large-transfer-protocol.test.ts",
  "test/kernel-scratch-transfer-boundaries.test.ts",
  "test/dlopen-host-imports.test.ts",
  "test/fork-continuation.test.ts",
  "test/fork-reference-transaction.test.ts",
  "test/fork-activation-registry.test.ts",
  "test/fork-early-reference-provider.test.ts",
  "test/fork-process-continuation.test.ts",
  "test/memory-group-pool.test.ts",
  "test/kernel-scratch-contract.test.ts",
  "test/browser-kernel.test.ts",
  "test/browser-pcm-driver.test.ts",
  "test/pcm-audio-worklet.test.ts",
  "test/framebuffer-registry.test.ts",
  "test/runtime-memory-profile.test.ts",
  "test/channel-listener-reclamation.test.ts",
  "test/process-view-teardown.test.ts",
  "test/dri-bo-teardown.test.ts",
  "test/gbm-coherence-cache.test.ts",
  "test/gbm-native-snapshot.test.ts",
  "test/gbm-fallback.test.ts",
  "test/kernel-teardown-pipe-entry.test.ts",
  "test/exec-retirement-marker.test.ts",
  "test/fork-worker-import-exceptions.test.ts",
  "test/fork-replay-gate.test.ts",
  "test/grouped-fork-launch.test.ts",
  "test/grouped-thread-launch.test.ts",
  "test/thread-allocator.test.ts",
  "test/fork-replay-host-parity.test.ts",
  "test/process-generation-detach.test.ts",
  "test/node-process-teardown-ordering.test.ts",
];
const evidenceClasses = new Map(readFileSync(
  new URL("../scripts/ci-vitest-evidence-classes.tsv", import.meta.url), "utf8",
).split("\n").filter(line => line && !line.startsWith("#"))
  .map(line => line.split("\t") as [string, string]));
for (const file of include) {
  if (evidenceClasses.get(`host/${file}`) !== "source-only") {
    throw new Error(`Browser memory source gate requires a source-only test: ${file}`);
  }
}

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    globalSetup: [],
    // The repository-wide TypeScript audit dominates this small selection;
    // avoid competing compiler heaps and match the CI execution order.
    maxWorkers: 1,
    include,
  },
});
