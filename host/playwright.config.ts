import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const phpTestDir = join(__dirname, "../packages/registry/php/test");

export default defineConfig({
  testDir: join(__dirname, "test"),
  testMatch: "*.spec.ts",
  timeout: 120_000,
  use: {
    baseURL: "http://localhost:5199",
  },
  webServer: {
    command: `npx vite --config ${join(phpTestDir, "browser/vite.config.ts")} --port 5199`,
    port: 5199,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
