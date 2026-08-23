import { defineConfig } from "@playwright/test";

export default defineConfig({
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
