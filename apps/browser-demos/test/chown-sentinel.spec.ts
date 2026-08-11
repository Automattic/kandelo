import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/chown_sentinel_test.wasm",
);

test("file mutation and chown set-ID invalidation work", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();

  // This probe needs the real browser worker and VFS, but no shell packages.
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const result = await page.evaluate(async ({ programUrl }) => {
    const response = await fetch(programUrl);
    if (!response.ok) {
      throw new Error(`program fetch failed: ${response.status}`);
    }
    return (window as any).__runTest(
      await response.arrayBuffer(),
      ["chown-sentinel-test"],
      15_000,
    );
  }, { programUrl });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("SETID_MUTATION_MATRIX_PASS");
  expect(result.stdout).toContain("CHOWN_SENTINEL_PASS");
  expect(result.stderr).toBe("");
});
