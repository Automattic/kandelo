import { defineConfig } from "./playwright-test";
import base from "./playwright.grouped-sdk.config";
import { playwrightPort } from "../../tests/playwright-run";

const port = await playwrightPort(process.env.KANDELO_GROUPED_VFS_PORT);

export default defineConfig({
  ...base,
  testMatch: "grouped-vfs-launch.spec.ts",
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `node_modules/.bin/vite --config vite.grouped-vfs-test.config.ts --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
