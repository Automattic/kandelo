import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.KANDELO_PLAYWRIGHT_PORT ?? 5401);

export default defineConfig({
  testDir: join(__dirname, "test"),
  testMatch: "*.spec.ts",
  timeout: 120_000,
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  webServer: {
    command: `npx vite --config ${join(__dirname, "vite.config.ts")} --host 127.0.0.1 --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      // Use the `chromium` channel (new headless mode) instead of
      // the default chromium-headless-shell. New-headless supports
      // WebGL2 on transferred OffscreenCanvases inside Web Workers,
      // which the modeset KMS pane relies on; the legacy headless
      // shell silently returns null for getContext("webgl2") on the
      // worker side.
      use: { browserName: "chromium", channel: "chromium" },
    },
    {
      name: "firefox",
      testMatch: ["coi.spec.ts", "wasm-trap-signal.spec.ts"],
      use: { browserName: "firefox" },
    },
    {
      name: "webkit",
      testMatch: [
        "coi.spec.ts",
        "kandelo-webkit-smoke.spec.ts",
        "wasm-trap-signal.spec.ts",
      ],
      use: { browserName: "webkit" },
    },
  ],
});
