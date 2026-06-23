import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.KANDELO_PLAYWRIGHT_PORT ?? 5401);

const browserEnvironmentKeys = [
  "CI",
  "DEBUG",
  "DISPLAY",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "KANDELO_PLAYWRIGHT_PORT",
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
  if (value !== undefined) {
    browserLaunchEnv[key] = value;
  }
}

export default defineConfig({
  testDir: join(__dirname, "test"),
  testMatch: "*.spec.ts",
  timeout: 120_000,
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Nix dev-shell build/linker paths are for toolchain commands, not
    // downloaded Playwright browser binaries. WebKitGTK reads more host
    // environment than Chromium/Firefox and can crash before navigation.
    launchOptions: { env: browserLaunchEnv },
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
      use: { browserName: "firefox" },
    },
    {
      name: "webkit",
      use: { browserName: "webkit" },
    },
  ],
});
