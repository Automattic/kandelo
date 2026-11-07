import { defineConfig } from "@playwright/test";
import graphicsCts from "./playwright.graphics-cts.config";

// Full chunked upstream dEQP runner (scripts/run-graphics-cts.sh). Same
// server, headless engines and isolation as the bounded GLES2 runner; one
// test per chunk, never retried or parallelized, with per-test deadlines
// set from the chunk size.
export default defineConfig({
  ...graphicsCts,
  testMatch: "graphics-cts-suite.run.ts",
  workers: 1, retries: 0, timeout: 0,
});
