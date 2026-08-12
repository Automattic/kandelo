import { defineConfig } from "@playwright/test";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  playwrightTestIgnoreForEnvironment,
  shouldReuseExistingPlaywrightServer,
} from "./playwright-server-policy";
import { HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE } from "./lib/homebrew-closed-acceptance";
import { playwrightWebServerEnvironment } from "./playwright-closed-acceptance";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.KANDELO_PLAYWRIGHT_PORT ?? 5401);
const protectedBrowserBaseUrl = protectedLoopbackBaseUrl(
  process.env.KANDELO_ABI_STAGING_BROWSER_BASE_URL,
);
const assembledSiteRoot = exactAssembledSiteRoot(
  process.env.KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT,
);
if (protectedBrowserBaseUrl !== undefined && assembledSiteRoot !== undefined) {
  throw new Error(
    "assembled-site preview cannot use an external browser base URL",
  );
}
const serveSealedDist = process.env.KANDELO_PLAYWRIGHT_SERVE_DIST === "1";
const configuredViteMode = process.env.KANDELO_PLAYWRIGHT_VITE_MODE?.trim();
if (
  configuredViteMode !== undefined &&
  configuredViteMode !== HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE
) {
  throw new Error(
    `unsupported KANDELO_PLAYWRIGHT_VITE_MODE: ${configuredViteMode}`,
  );
}
const effectiveViteMode =
  configuredViteMode ??
  (serveSealedDist || assembledSiteRoot !== undefined
    ? "production"
    : "development");
const webServerEnvironment = playwrightWebServerEnvironment(
  effectiveViteMode,
  process.env,
);
if (assembledSiteRoot !== undefined) {
  webServerEnvironment.VITE_BASE = "/kandelo/";
}
const viteModeArgument =
  configuredViteMode === HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE
    ? ` --mode ${HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE}`
    : "";

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
  // The assembled-site and exact-product proofs read protected handoffs during
  // module initialization. Ordinary browser suites have no such inputs; their
  // dedicated gates supply them and must remain their sole callers.
  testIgnore: playwrightTestIgnoreForEnvironment(process.env, process.argv),
  timeout: 120_000,
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL:
      protectedBrowserBaseUrl === undefined
        ? `http://127.0.0.1:${port}${assembledSiteRoot === undefined ? "" : "/kandelo/"}`
      : protectedBrowserBaseUrl,
    // The immutable product is already zstd-compressed. Vite preview otherwise
    // dynamically gzips it and switches to chunked transfer, unlike the
    // content-length-bearing static Pages object this gate models.
    extraHTTPHeaders:
      assembledSiteRoot === undefined
        ? undefined
        : { "Accept-Encoding": "identity" },
    // Nix dev-shell build/linker paths are for toolchain commands, not
    // downloaded Playwright browser binaries. WebKitGTK reads more host
    // environment than Chromium/Firefox and can crash before navigation.
    launchOptions: {
      env: browserLaunchEnv,
      args:
        protectedBrowserBaseUrl === undefined
        ? undefined
        : ["--proxy-bypass-list=<-loopback>"],
    },
    proxy:
      protectedBrowserBaseUrl === undefined
      ? undefined
      : { server: new URL(protectedBrowserBaseUrl).origin },
    screenshot:
      protectedBrowserBaseUrl === undefined ? "only-on-failure" : "off",
    trace:
      protectedBrowserBaseUrl === undefined && process.env.CI
      ? "retain-on-failure"
      : "off",
  },
  webServer:
    protectedBrowserBaseUrl === undefined
    ? {
          command:
            serveSealedDist || assembledSiteRoot !== undefined
              ? assembledSiteRoot === undefined
        ? `npx vite preview${viteModeArgument} --config ${join(__dirname, "vite.config.ts")} --host 127.0.0.1 --port ${port} --strictPort`
                : exactAssembledPreviewCommand(assembledSiteRoot, port)
        : `npx vite${viteModeArgument} --config ${join(__dirname, "vite.config.ts")} --host 127.0.0.1 --port ${port} --strictPort`,
      port,
      env: webServerEnvironment,
          reuseExistingServer:
            assembledSiteRoot === undefined &&
            shouldReuseExistingPlaywrightServer(process.env),
      timeout: 30_000,
    }
    : undefined,
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

function protectedLoopbackBaseUrl(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "KANDELO_ABI_STAGING_BROWSER_BASE_URL must be one protected loopback origin",
    );
  }
  return parsed.href;
}

function exactAssembledSiteRoot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "" || resolve(value) !== value) {
    throw new Error(
      "KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT must be an absolute path",
    );
  }
  const metadata = lstatSync(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT must be a direct directory",
    );
  }
  return value;
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function exactAssembledPreviewCommand(
  root: string,
  previewPort: number,
): string {
  const viteModule = pathToFileURL(
    join(__dirname, "node_modules/vite/dist/node/index.js"),
  ).href;
  const source = `
import { preview } from ${JSON.stringify(viteModule)};
await preview({
  base: "/kandelo/",
  build: { outDir: ${JSON.stringify(root)} },
  configFile: false,
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Service-Worker-Allowed": "/",
    },
    host: "127.0.0.1",
    port: ${previewPort},
    strictPort: true,
  },
});
`;
  return `node --input-type=module -e ${shellWord(source)}`;
}
