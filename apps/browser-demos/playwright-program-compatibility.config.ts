import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { playwrightPort } from "../../tests/playwright-run";

const port = await playwrightPort(process.env.KANDELO_PROGRAM_COMPATIBILITY_PORT);

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
