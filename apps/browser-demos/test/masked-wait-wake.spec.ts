import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";

// Browser counterpart of host/test/masked-wait-wake.test.ts: the same
// program through the production browser kernel and process workers.
const programPath = resolve(dirname(fileURLToPath(import.meta.url)),
  "../../../examples/masked_wait_wake_test.wasm");
test("masked ppoll/pselect wake promptly and never lose a late signal in browser workers", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/pages/test-runner/?minimal=1");
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const result = await page.evaluate(runFetchedWasmProgram, {
    programUrl: new URL(`/@fs/${programPath}`, baseURL).href,
    argv: ["masked-wait-wake"],
    timeoutMs: 60_000,
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  // Record the race outcomes and latencies with the run's evidence.
  console.log(result.stdout.match(/MASKED_WAIT_(RACE|LATENCY) .*/g)?.join("\n"));
  expect(result.stdout).toContain("MASKED_WAIT_WAKE_PASS");
  expect(result.stdout.match(/MASKED_WAIT_KILL api=\w+ ok/g)).toHaveLength(2);
  expect(result.stdout.match(/MASKED_WAIT_RACE /g)).toHaveLength(2);
  expect(result.stdout.match(/MASKED_WAIT_LATENCY /g)).toHaveLength(2);
  expect(result.stderr).toBe("");
  expect(result.hostDiagnostics).toEqual([]);
  expect(errors).toEqual([]);
});
