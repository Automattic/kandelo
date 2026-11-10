import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const server = base.webServer;
if (!server || Array.isArray(server)) {
  throw new Error("Graphics CTS requires the normal local source server configuration");
}
const port = Number(process.env.KANDELO_PLAYWRIGHT_PORT ?? 5401);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("KANDELO_PLAYWRIGHT_PORT must be an integer from 1024 to 65535");
}

export default defineConfig({
  ...base,
  testMatch: "graphics-cts-gles2.spec.ts",
  workers: 1, retries: 0,
  use: { ...base.use, headless: true, serviceWorkers: "block" },
  webServer: {
    ...server,
    command: `node node_modules/vite/bin/vite.js --config vite.graphics-cts.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    reuseExistingServer: false,
  },
});
