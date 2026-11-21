import { defineConfig } from "./playwright-test";
import { playwrightRun } from "../../tests/playwright-run";

const target = process.env.KANDELO_TEST_CAGE_PREVIEW_URL;
if (!target) throw new Error("Set KANDELO_TEST_CAGE_PREVIEW_URL to the running Cage/Foot/Freeciv app");
const url = new URL(target);
if (!/^https?:$/.test(url.protocol) || url.search || url.hash || url.username || url.password
    || !url.pathname.endsWith("/")) {
  throw new Error("Cage checks require an HTTP(S) app directory URL without a query or credentials");
}
const run = playwrightRun(import.meta.dirname);
// Establish the run-owned temporary root before the shared project policy
// creates its Firefox storage home. Workers must inherit matching roots.
const { default: base } = await import("./playwright.grouped-desktop.config");

export default defineConfig({
  ...base,
  testMatch: ["trusted-cage.check.ts"],
  timeout: 360_000,
  outputDir: run.outputDir,
  globalTeardown: run.globalTeardown,
  use: {
    ...base.use,
    baseURL: target,
    headless: true,
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 840 },
    screenshot: "only-on-failure",
  },
  projects: base.projects?.map(project => project.name === "chromium" ? {
    ...project,
    use: { ...project.use, launchOptions: {
      ...project.use?.launchOptions,
      args: [...(project.use?.launchOptions?.args ?? []), "--force-device-scale-factor=1"],
    } },
  } : project),
  webServer: undefined,
});
