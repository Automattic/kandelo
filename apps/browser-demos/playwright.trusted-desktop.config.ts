import { defineConfig } from "./playwright-test";
import base from "./playwright.grouped-desktop.config";

// Run against the normal opt-in browser command or a served production build.
// A bare URL proves the default image; an explicit Sway profile can select
// Sway from the normal partial image whose default compositor is Cage.
const target = process.env.KANDELO_TEST_SWAY_PREVIEW_URL;
if (!target) throw new Error("Set KANDELO_TEST_SWAY_PREVIEW_URL to the running trusted desktop app");
const url = new URL(target);
const query = url.searchParams;
const invalidProfile = url.search && (query.get("profile") !== "sway"
  || [...query.keys()].some(key => key !== "profile" && key !== "vfs")
  || query.getAll("profile").length !== 1 || query.getAll("vfs").length > 1);
if (!/^https?:$/.test(url.protocol) || invalidProfile || url.hash || url.username || url.password
    || !url.pathname.endsWith("/")) {
  throw new Error("Trusted desktop test requires an HTTP(S) app directory URL, optionally with one explicit sway profile and VFS, without credentials or a fragment");
}
export default defineConfig({
  ...base,
  testMatch: ["kandelo-sway.spec.ts", "trusted-desktop-capacity.check.ts"],
  grep: /Kandelo sway tiles|trusted desktop keeps/,
  outputDir: "../../.scratch/trusted-desktop-app-playwright",
  use: { ...base.use, baseURL: target, viewport: { width: 1499, height: 1000 }, screenshot: "only-on-failure" },
  webServer: undefined,
});
