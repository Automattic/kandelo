import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/environment_lifecycle_test.wasm",
);

test("initial, forked, replacement, and empty environments stay coherent", async ({
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
    const bytes = await response.arrayBuffer();
    return (window as any).__runTest(
      bytes,
      ["/bin/environment-lifecycle"],
      30_000,
      {
        env: ["INITIAL=parent", "REMOVE=before-fork"],
        dataFiles: [
          { path: "/bin/environment-lifecycle", useWasmBytes: true },
        ],
      },
    );
  }, { programUrl });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("FORK_ENV_PASS");
  expect(result.stdout).toContain("EXEC_ENV_PASS");
  expect(result.stdout).toContain("EMPTY_ENV_PASS");
  expect(result.stderr).toBe("");
});
