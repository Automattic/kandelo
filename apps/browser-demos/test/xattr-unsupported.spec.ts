import { expect, test } from "@playwright/test";
import { buildProgramsFixture, requireBuiltFixtures } from "./support/program-fixtures";
import { readFileSync } from "node:fs";

const xattrBinary = buildProgramsFixture("programs/wasm32/xattr-unsupported.wasm");

test.beforeAll(() => requireBuiltFixtures([xattrBinary]));

test("extended attributes report missing support truthfully in BrowserKernel", async ({
  page,
  baseURL,
}) => {
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const bytes = Array.from(readFileSync(xattrBinary));
  const result = await page.evaluate(async (wasmBytes) => {
    const wasm = new Uint8Array(wasmBytes).buffer;
    return (window as any).__runTest(wasm, ["xattr-unsupported"]);
  }, bytes);

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stdout).toBe("PASS\n");
  expect(result.stderr).toBe("");
});
