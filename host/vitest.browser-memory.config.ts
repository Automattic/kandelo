import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import base from "./vitest.config.ts";

// This same source-only selection runs locally and in the browser smoke CI.
// No global fixture compiler: these cases need no guest binaries or images.
const include = [
  "test/kernel-scratch-contract.test.ts",
  "test/browser-kernel.test.ts",
  "test/browser-pcm-driver.test.ts",
  "test/pcm-audio-worklet.test.ts",
  "test/framebuffer-registry.test.ts",
  "test/runtime-memory-profile.test.ts",
  "test/channel-listener-reclamation.test.ts",
  "test/process-view-teardown.test.ts",
  "test/dri-bo-teardown.test.ts",
  "test/kernel-teardown-pipe-entry.test.ts",
  "test/exec-retirement-marker.test.ts",
  "test/fork-worker-import-exceptions.test.ts",
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
