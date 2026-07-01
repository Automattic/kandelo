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
    // `pool: 'forks'` avoids the worker_threads RPC that vitest uses
    // for inter-thread task-update messaging. Under the GHA runner's
    // CPU contention (two long-running test files — release-roundtrip @
    // ~63s and exec-brk-base @ ~14s — running in parallel with ~50
    // other files), `pool: 'threads'` hits "Timeout calling
    // onTaskUpdate" *after* all tests pass, failing the run on a vitest
    // internal RPC error rather than any real test failure. First
    // observed on vitest 3.2.4; retained after the Vitest 4 upgrade
    // (4.1.9).
    //
    // Forks have higher per-file process-spawn overhead (~20-30s added
    // wall-clock for our suite) but no shared-thread RPC, so the
    // timeout doesn't apply.
    pool: "forks",
    // Even with forks, the post-run aggregation RPC (`onTaskUpdate`)
    // can time out on a heavily contended GHA runner. Fork-heavy host
    // test files also launch their own process workers; keep local runs
    // parallel, but serialize CI files so dash/fork/spawn coverage has
    // enough worker time to make forward progress.
    teardownTimeout: 60_000,
    // Vitest 4 removed `test.poolOptions`; the former
    // `poolOptions.forks.maxForks` is now the top-level `maxWorkers`
    // (https://vitest.dev/guide/migration#pool-rework). With
    // `pool: 'forks'` this caps worker forks: 1 on CI (serialized),
    // 4 locally (parallel).
    maxWorkers: process.env.CI ? 1 : 4,
  },
});
