import { defineConfig } from "./playwright-test";
import { browserStorageHome } from "./playwright-storage";
import { playwrightRun } from "../../tests/playwright-run";

const run = playwrightRun(import.meta.dirname);

export default defineConfig({
  testDir: "./test",
  testMatch: ["grouped-sdk-execution.spec.ts", "grouped-root-launch.spec.ts"],
  workers: 1,
  reporter: "list",
  outputDir: run.outputDir,
  globalTeardown: run.globalTeardown,
  projects: (["chromium", "firefox", "webkit"] as const).map(name => ({ name, use: {
    browserName: name,
    ...(name === "firefox" && process.platform === "darwin" ? { launchOptions: {
      env: Object.fromEntries(Object.entries({ ...process.env, CFFIXED_USER_HOME: browserStorageHome("firefox") })
        .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    } } : {}),
  } })),
});
