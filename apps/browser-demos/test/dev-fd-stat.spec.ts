import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const devFdStatBinary = tryResolveBinary("programs/dev-fd-stat.wasm");

test.skip(!devFdStatBinary, "dev-fd-stat.wasm was not built");

test("devfs descriptor aliases preserve stat identity in BrowserKernel", async ({ page }) => {
  await page.goto("/pages/test-runner/");
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const bytes = Array.from(readFileSync(devFdStatBinary!));
  const result = await page.evaluate(async (wasmBytes) => {
    const wasm = new Uint8Array(wasmBytes).buffer;
    return (window as any).__runTest(wasm, ["dev-fd-stat"]);
  }, bytes);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("PASS\n");
  expect(result.stderr).toBe("");
});
