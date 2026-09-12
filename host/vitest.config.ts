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
    // Keep test files in child processes. The suite itself starts many
    // worker_threads and large shared Wasm memories; nesting that work inside
    // Vitest's thread pool has historically made task reporting unreliable
    // under GitHub runner contention.
    pool: "forks",
    // Fork-heavy files launch their own process workers. Keep local runs
    // parallel, but serialize CI files so guest timeouts measure the runtime
    // behavior under test instead of runner oversubscription.
    // STOPGAP (lane T, T6). Vitest's default testTimeout is 5s
    // (`resolved.testTimeout ??= ... : 5e3`), and every test in
    // test/fork-instrument-coverage.test.ts costs 8.4-9.6s measured on an idle
    // machine, so all 41 exceeded it deterministically -- on any machine, under
    // any load. That file alone carried 41 of the suite's 49 timeouts.
    //
    // This is a stopgap, not a fix. The real question is why a fixture that
    // forks and prints costs 8.5s; the 14% spread between fastest and slowest
    // points at fixed per-test setup (`runCentralizedProgram` stands up a
    // kernel per test) rather than the fixtures doing different work. That is
    // T7, and it is worth more than this line.
    //
    // 30s is ~3x the measured worst case, leaving room for CI's maxWorkers: 1.
    // Do NOT read this as licence for slower tests: raise T7's priority
    // instead. Unrelated to the 10s `runCentralizedProgram` budget in that
    // file, which bounds the GUEST PROGRAM's run, not the test's wall clock.
    testTimeout: 30_000,
    teardownTimeout: 60_000,
    // Vitest 4 removed poolOptions.forks.maxForks; maxWorkers is the current
    // top-level equivalent.
    maxWorkers: process.env.CI ? 1 : 4,
  },
});
