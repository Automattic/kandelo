import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const phpTestDir = join(__dirname, "../../../packages/registry/php/test");
const phpBrowserTestPort = Number(process.env.PHP_BROWSER_TEST_PORT ?? 5199);

export default defineConfig({
  testDir: __dirname,
  testMatch: "php-browser.spec.ts",
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${phpBrowserTestPort}`,
  },
  webServer: {
    command: `npx vite --config ${join(phpTestDir, "browser/vite.config.ts")} --host 127.0.0.1 --port ${phpBrowserTestPort} --strictPort`,
    port: phpBrowserTestPort,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
