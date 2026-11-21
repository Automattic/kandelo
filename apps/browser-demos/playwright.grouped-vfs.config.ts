import { defineConfig } from "./playwright-test";
import base from "./playwright.grouped-sdk.config";

const port = Number(process.env.KANDELO_GROUPED_VFS_PORT ?? 6357);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid grouped VFS test port");

export default defineConfig({
  ...base,
  testMatch: "grouped-vfs-launch.spec.ts",
  outputDir: "../../.scratch/grouped-vfs-launch-playwright",
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `node_modules/.bin/vite --config vite.grouped-vfs-test.config.ts --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
