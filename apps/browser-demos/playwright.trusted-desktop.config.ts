import { defineConfig } from "./playwright-test";
import base from "./playwright.grouped-desktop.config";

// Run against the normal opt-in browser command or a served production build.
// A bare URL proves the build's default image, without a ?vfs override.
const target = process.env.KANDELO_TEST_SWAY_PREVIEW_URL;
if (!target) throw new Error("Set KANDELO_TEST_SWAY_PREVIEW_URL to the running trusted desktop app");
const url = new URL(target);
if (!/^https?:$/.test(url.protocol) || url.search || url.hash || url.username || url.password
    || !url.pathname.endsWith("/")) {
  throw new Error("Trusted desktop test requires an HTTP(S) app directory URL without a query or credentials");
}
export default defineConfig({
  ...base,
  testMatch: ["kandelo-sway.spec.ts", "trusted-desktop-capacity.check.ts"],
  grep: /Kandelo sway tiles|trusted desktop keeps/,
  outputDir: "../../.scratch/trusted-desktop-app-playwright",
  use: { ...base.use, baseURL: target, viewport: { width: 1499, height: 1000 }, screenshot: "only-on-failure" },
  webServer: undefined,
});
