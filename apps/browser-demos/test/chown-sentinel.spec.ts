import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/chown_sentinel_test.wasm",
);

test("chown unchanged-ID sentinels preserve IDs and errors", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  expect(baseURL).toBeTruthy();

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
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
  expect(result.stdout).toContain("CHOWN_SENTINEL_PASS");
  expect(result.stderr).toBe("");
});
