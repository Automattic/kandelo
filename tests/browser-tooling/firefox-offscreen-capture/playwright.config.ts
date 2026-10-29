import { defineConfig } from "../../../apps/browser-demos/node_modules/@playwright/test/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "repro.spec.ts",
  outputDir: "results",
  workers: 1,
  timeout: 60_000,
  use: {
    browserName: "firefox",
    viewport: { width: 800, height: 600 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      // An isolated profile matches the repository's macOS headless launcher.
      env: { ...process.env, CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), "offscreen-capture-")) },
    },
  },
});
