import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";

const here = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  here,
  "../../../local-binaries/programs/wasm32/pty-ownership.wasm",
);

test("production browser workers preserve devpts metadata and permissions", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });

  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const result = await page.evaluate(runFetchedWasmProgram, {
    programUrl,
    argv: ["pty-ownership"],
    timeoutMs: 20_000,
  });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("PTY_OWNERSHIP_PASS");
  expect(result.stderr).toBe("");
  expect(result.hostDiagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
