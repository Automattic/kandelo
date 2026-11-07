import { defineConfig } from "@playwright/test";

import { playwrightRun } from "../../tests/playwright-run";

export default defineConfig({
  ...playwrightRun(import.meta.dirname),
  testDir: "./test",
  testMatch: "service-worker-scope-state.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: {
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", channel: "chromium" },
    },
  ],
});
