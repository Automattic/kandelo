import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Virtual-module prefix for a stubbed Vite `?url` import. */
const VITE_URL_STUB_PREFIX = "\0vite-url-stub:";

/**
 * Resolve the Vite-specific `?url` / `?worker&url` imports (and the
 * `@kernel-wasm` alias) to a plain string stub so vitest can load
 * modules that originate from the browser demos (e.g. BrowserKernel)
 * without spinning up a real Vite environment. Tests that need a real
 * Worker stub `globalThis.Worker` directly.
 *
 * Every stub is DISTINCT, keyed by the import source. Production code
 * branches on which artifact a URL names — a boot fetches the default
 * kernel, the default rootfs, the fork-module and the WASI module from four
 * separate URLs — so a single shared stub string would erase the exact
 * distinction the tests exist to check, and a test asserting on one of them
 * could not be satisfied by any kernel.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@host": resolve(__dirname, "src"),
    },
  },
  plugins: [
    {
      name: "vitest-stub-vite-url-imports",
      enforce: "pre",
      resolveId(source: string) {
        if (source.startsWith(VITE_URL_STUB_PREFIX)) return source;
        if (source === "@kernel-wasm" || source === "@kernel-wasm?url") {
          return `${VITE_URL_STUB_PREFIX}@kernel-wasm`;
        }
        if (source.endsWith("?url") || source.endsWith("?worker&url")) {
          return VITE_URL_STUB_PREFIX + source;
        }
        return null;
      },
      load(id: string) {
        if (!id.startsWith(VITE_URL_STUB_PREFIX)) return null;
        const source = id.slice(VITE_URL_STUB_PREFIX.length);
        return `export default ${JSON.stringify(`stub://vite-url/${source}`)};\n`;
      },
    },
  ],
  test: {
    include: [
      "test/**/*.test.ts",
      "../web-libs/**/*.test.ts",
      "../packages/registry/*/test/**/*.test.ts",
      "../tests/package-system/**/*.test.ts",
      "../examples/dlopen/**/*.test.ts",
    ],
    globalSetup: ["test/global-setup.ts"],
    // Runs in every test worker, before every test file. The artifact reader is
    // a wasm module now, so a suite that touches `constants.ts` needs it
    // installed the way a production entry point installs it.
    setupFiles: ["test/setup-wasm-artifact-module.ts"],
    // Keep test files in child processes. The suite itself starts many
    // worker_threads and large shared Wasm memories; nesting that work inside
    // Vitest's thread pool has historically made task reporting unreliable
    // under GitHub runner contention.
    pool: "forks",
    // Fork-heavy files launch their own process workers. Keep local runs
    // parallel, but serialize CI files so guest timeouts measure the runtime
    // behavior under test instead of runner oversubscription.
    teardownTimeout: 60_000,
    // Vitest 4 removed poolOptions.forks.maxForks; maxWorkers is the current
    // top-level equivalent.
    maxWorkers: process.env.CI ? 1 : 4,
  },
});
