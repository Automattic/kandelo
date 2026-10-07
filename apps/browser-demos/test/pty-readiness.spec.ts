import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";

const programPath = resolve(dirname(fileURLToPath(import.meta.url)),
  "../../../examples/pty_readiness_test.wasm");
test("guest PTY waits and repaint bytes work in production browser workers", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/pages/test-runner/?minimal=1");
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const result = await page.evaluate(runFetchedWasmProgram, {
    programUrl: new URL(`/@fs/${programPath}`, baseURL).href,
    argv: ["pty-readiness"],
    timeoutMs: 30_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("PTY_READINESS_PASS");
  expect(result.stdout.match(/PTY_ROUNDTRIP/g)).toHaveLength(5);
  expect(result.stderr).toBe("");
  expect(result.hostDiagnostics).toEqual([]);
  expect(errors).toEqual([]);
});
