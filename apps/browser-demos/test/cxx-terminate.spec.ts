import { expect, test } from "../playwright-test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";

// The browser peer of host/test/cxx-terminate.test.ts: C++ allocation
// failure throws std::bad_alloc, and an exception with no handler calls
// std::terminate, so the process is killed by SIGABRT (docs/sdk-guide.md,
// "C++ exceptions").
const badAllocPath = resolveBinary("programs/cxx_bad_alloc_test.wasm");
const uncaughtPath = resolveBinary("programs/cxx_uncaught_test.wasm");
const TERMINATED_BY_SIGABRT = 128 + 6;

test.describe("C++ exceptions in the browser", () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
    await page.goto("/pages/test-runner/?minimal=1");
    await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  });

  const run = (
    page: import("@playwright/test").Page,
    baseURL: string | undefined,
    path: string,
    argv: string[],
  ) =>
    page.evaluate(runFetchedWasmProgram, {
      programUrl: new URL(`/@fs/${path}`, baseURL).href,
      argv,
      timeoutMs: 30_000,
    });

  test("operator new throws std::bad_alloc and nothrow forms return null", async ({
    page,
    baseURL,
  }) => {
    const result = await run(page, baseURL, badAllocPath, ["cxx_bad_alloc_test"]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS cxx_bad_alloc_test");
  });

  for (const [mode, what] of [
    ["main", "thrown from main"],
    ["thread", "std::thread function"],
  ] as const) {
    test(`an uncaught exception (${mode}) ends the process by SIGABRT`, async ({
      page,
      baseURL,
    }) => {
      const result = await run(page, baseURL, uncaughtPath, ["cxx_uncaught_test", mode]);
      expect(result.exitCode, result.stdout + result.stderr).toBe(TERMINATED_BY_SIGABRT);
      expect(result.stderr).toContain(
        `libc++abi: terminating due to uncaught exception of type std::runtime_error: ${what}`,
      );
    });
  }

  test("waitpid reports a forked child's SIGABRT", async ({ page, baseURL }) => {
    const result = await run(page, baseURL, uncaughtPath, ["cxx_uncaught_test", "waitpid"]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("child signaled 6 (SIGABRT)");
  });
});
