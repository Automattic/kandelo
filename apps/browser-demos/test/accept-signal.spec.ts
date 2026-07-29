import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/accept_signal_test.wasm",
);

test("caught SIGCHLD interrupts and restarts accept coherently", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();

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
      ["accept_signal_test"],
      15_000,
    );
  }, { programUrl });

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stdout).toContain(
    "PASS accept signal interruption and SA_RESTART",
  );
  expect(result.stderr).toBe("");
});
