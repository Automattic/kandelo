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
      channel: process.env.KANDELO_WEBMCP_CHANNEL ?? "chromium",
      // Use Playwright's full browser in headed mode to exercise the native
      // experimental API. A separate Chrome installation is optional.
      headless: false,
      launchOptions: {
        ...base.use?.launchOptions,
        args: [
          ...(base.use?.launchOptions?.args ?? []),
          "--mute-audio",
          "--enable-experimental-web-platform-features",
        ],
      },
    },
  }],
});
