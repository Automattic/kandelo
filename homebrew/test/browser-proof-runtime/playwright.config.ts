import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.KANDELO_PLAYWRIGHT_PORT ?? 5401);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("KANDELO_PLAYWRIGHT_PORT must be a valid TCP port");
}

const browserEnvironmentKeys = [
  "CI",
  "DEBUG",
  "DISPLAY",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PWDEBUG",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

const browserLaunchEnv: Record<string, string> = {};
for (const key of browserEnvironmentKeys) {
  const value = process.env[key];
  if (value !== undefined) browserLaunchEnv[key] = value;
}

export default defineConfig({
  testDir: join(runtimeRoot, "apps/browser-demos/test"),
  testMatch: "homebrew-guest-lifecycle.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { env: browserLaunchEnv },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    // WHY: the consumer must serve the producer's sealed dist byte-for-byte.
    // A Vite build or source resolver here would silently turn the proof back
    // into a second product build on the memory-constrained proof runner.
    command:
      "node serve-sealed-dist.mjs " +
      `--root apps/browser-demos/dist --port ${port}`,
    cwd: runtimeRoot,
    port,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", channel: "chromium" },
    },
  ],
});
