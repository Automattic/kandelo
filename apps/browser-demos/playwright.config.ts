import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: join(__dirname, "test"),
  testMatch: "*.spec.ts",
  timeout: 120_000,
  use: {
    baseURL: "http://localhost:5198",
  },
  webServer: {
    command: `npx vite --config ${join(__dirname, "vite.config.ts")} --port 5198`,
    port: 5198,
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
