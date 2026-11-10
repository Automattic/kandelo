import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

// Full chunked upstream dEQP runner on Node (scripts/run-graphics-cts.sh).
// It needs packaged CTS artifacts, so it is never part of the ordinary or
// graphics source suites; one chunk test at a time, never retried.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    globalSetup: [],
    include: ["test/graphics-cts/node-suite.cts-run.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
  },
});
