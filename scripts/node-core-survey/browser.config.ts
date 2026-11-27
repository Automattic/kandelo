import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import base from "../../apps/browser-demos/playwright.config";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "../..");
const binaryRoot = resolve(process.env.KANDELO_NODE_SURVEY_BINARY_ROOT ?? resolve(root, "local-binaries"));
const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error("Expected one local Kandelo browser test server");
export default {
  ...base,
  testDir,
  testMatch: "browser.spec.ts",
  globalSetup: resolve(testDir, "browser-storage.ts"),
  retries: 0,
  workers: 1,
  webServer: {
    ...server,
    cwd: resolve(root, "apps/browser-demos"),
    env: {
      ...server.env,
      WASM_POSIX_RESOLUTION_POLICY: "source-only-v1",
      WASM_POSIX_SOURCE_ONLY_BINARY_ROOT: resolve(binaryRoot, "source-only-v1"),
    },
  },
};
