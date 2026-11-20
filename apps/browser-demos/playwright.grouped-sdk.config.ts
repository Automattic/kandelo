import { defineConfig } from "./playwright-test";
import { browserStorageHome } from "./playwright-storage";

export default defineConfig({
  testDir: "./test",
  testMatch: ["grouped-sdk-execution.spec.ts", "grouped-root-launch.spec.ts"],
  workers: 1,
  reporter: "list",
  outputDir: "../../.scratch/grouped-sdk-execution-playwright",
  projects: (["chromium", "firefox", "webkit"] as const).map(name => ({ name, use: {
    browserName: name,
    ...(name === "firefox" && process.platform === "darwin" ? { launchOptions: {
      env: Object.fromEntries(Object.entries({ ...process.env, CFFIXED_USER_HOME: browserStorageHome("firefox") })
        .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    } } : {}),
  } })),
});
