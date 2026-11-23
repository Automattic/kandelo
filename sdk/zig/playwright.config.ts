import { resolve } from "node:path";
import browser from "../../apps/browser-demos/playwright.config";

export default {
  ...browser,
  globalSetup: undefined,
  webServer: browser.webServer && !Array.isArray(browser.webServer)
    ? { ...browser.webServer, cwd: resolve(import.meta.dirname, "../../apps/browser-demos") }
    : browser.webServer,
  testDir: import.meta.dirname,
  testMatch: "stdlib.spec.ts",
};
