import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// WebMCP requires a current Chrome with the native experimental API enabled.
// No shim or intercepted registration is used by these tests.
export default defineConfig({
  ...base,
  testMatch: "webmcp.e2e.ts",
  workers: 1,
  timeout: 180_000,
  projects: [{
    name: "webmcp",
    use: {
      browserName: "chromium",
      channel: process.env.KANDELO_WEBMCP_CHANNEL ?? "chrome-canary",
      launchOptions: {
        ...base.use?.launchOptions,
        args: [
          ...(base.use?.launchOptions?.args ?? []),
          "--enable-experimental-web-platform-features",
        ],
      },
    },
  }],
});
