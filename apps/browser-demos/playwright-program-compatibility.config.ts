import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const port = Number(process.env.KANDELO_PROGRAM_COMPATIBILITY_PORT ?? 57417);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid program compatibility test port");

export default defineConfig({
  ...base,
  testMatch: "program-compatibility.spec.ts",
  testIgnore: [],
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `node --import tsx/esm ../../scripts/serve-program-compatibility-tests.ts ${port}`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/pages/program-compatibility-test/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
