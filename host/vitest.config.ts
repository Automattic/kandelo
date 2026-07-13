import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const viteUrlStub = resolve(__dirname, "test/fixtures/vite-url-stub.ts");

/**
 * Resolve the Vite-specific `?url` / `?worker&url` imports (and the
 * `@kernel-wasm` alias) to a plain string stub so vitest can load
 * modules that originate from the browser demos (e.g. BrowserKernel)
 * without spinning up a real Vite environment. Tests that need a real
 * Worker stub `globalThis.Worker` directly.
 */
export default defineConfig({
  plugins: [
    {
      name: "vitest-stub-vite-url-imports",
      enforce: "pre",
      resolveId(source: string) {
        if (source === "@kernel-wasm" || source === "@kernel-wasm?url") {
          return viteUrlStub;
        }
        if (source.endsWith("?url") || source.endsWith("?worker&url")) {
          return viteUrlStub;
        }
        return null;
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
