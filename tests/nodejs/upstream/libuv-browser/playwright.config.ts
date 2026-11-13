import base from "../../../../apps/browser-demos/playwright.config";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const reportDir = process.env.KANDELO_LIBUV_REPORT_DIR ??
  fileURLToPath(new URL("../../../../.context/libuv-backend-browser", import.meta.url));
if (!isAbsolute(reportDir)) throw new Error("KANDELO_LIBUV_REPORT_DIR must be absolute");
mkdirSync(reportDir, { recursive: true });
process.env.KANDELO_LIBUV_REPORT_DIR = reportDir;
const server = base.webServer as { command: string; [key: string]: unknown };
const command = server.command.replace(/--config \S+/,
  "--config " + fileURLToPath(new URL("./vite.config.ts", import.meta.url)));

export default {
  ...base,
  globalSetup: fileURLToPath(new URL("./storage-setup.ts", import.meta.url)),
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "libuv-backend.spec.ts",
  testIgnore: [],
  outputDir: join(reportDir, "results"),
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  webServer: {
    ...server, command,
    cwd: fileURLToPath(new URL("../../../../apps/browser-demos", import.meta.url)),
  },
};
