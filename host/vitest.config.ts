import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "../examples/libs/php/test/**/*.test.ts", "../examples/wordpress/test/**/*.test.ts", "../examples/dlopen/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // `pool: 'forks'` avoids the worker_threads RPC that vitest 3.2.4
    // uses for inter-thread task-update messaging. Under the GHA
    // runner's CPU contention (two long-running test files —
    // release-roundtrip @ ~63s and exec-brk-base @ ~14s — running in
    // parallel with ~50 other files), the default `pool: 'threads'`
    // hits "Timeout calling onTaskUpdate" *after* all 392 tests pass,
    // failing the run on a vitest internal RPC error rather than any
    // real test failure.
    //
    // Forks have higher per-file process-spawn overhead (~20-30s
    // added wall-clock for our suite) but no shared-thread RPC, so
    // the timeout doesn't apply. A future vitest version (3.2.5+) is
    // expected to ship the fix; revisit then.
    pool: "forks",
    // Even with forks, the post-run aggregation RPC (`onTaskUpdate`)
    // can time out on a heavily contended GHA runner. Cap fork
    // parallelism and extend the teardown window so the final
    // result-flush has room to complete. Without this, runs of
    // 392+ tests succeed individually but the run-summary call
    // fails the whole job on a 3s default RPC timeout.
    teardownTimeout: 60_000,
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
  },
});
