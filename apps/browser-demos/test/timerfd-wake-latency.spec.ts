import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";

// Browser counterpart of host/test/timerfd-wake-latency.test.ts: the same
// program through the production browser kernel and process workers. A
// timerfd expiry must end a blocked epoll_wait/poll/select/read at the
// timer's deadline, not at a host retry tick.
const programPath = resolve(dirname(fileURLToPath(import.meta.url)),
  "../../../examples/timerfd_wake_latency_test.wasm");
test("timerfd expiry wakes blocked epoll, poll, select and read in browser workers", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/pages/test-runner/?minimal=1");
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const result = await page.evaluate(runFetchedWasmProgram, {
    programUrl: new URL(`/@fs/${programPath}`, baseURL).href,
    argv: ["timerfd-wake-latency"],
    timeoutMs: 60_000,
  });
  // Record each case's wake latency with the run's evidence.
  console.log(result.stdout.match(/TIMERFD_WAKE(_STRESS)? .*/g)?.join("\n"));
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("TIMERFD_WAKE_PASS");
  expect(result.stdout.match(/TIMERFD_WAKE case=\S+ .* ok$/gm)).toHaveLength(11);
  expect(result.stdout).toMatch(/TIMERFD_WAKE_STRESS threads=\d+ rounds=\d+ stalls=0$/m);
  expect(result.stderr).toBe("");
  expect(result.hostDiagnostics).toEqual([]);
  expect(errors).toEqual([]);
});
