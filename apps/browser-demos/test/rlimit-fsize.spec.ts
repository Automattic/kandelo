import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/rlimit_fsize_test.wasm",
);

test("RLIMIT_FSIZE keeps one operation boundary in Chromium", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "the aggregate browser gate uses Chromium",
  );
  expect(baseURL).toBeTruthy();

  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") runtimeErrors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    runtimeErrors.push(
      `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      runtimeErrors.push(`response: ${response.status()} ${response.url()}`);
    }
  });

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const result = await page.evaluate(
    async ({ programUrl }) => {
      const response = await fetch(programUrl);
      if (!response.ok) {
        throw new Error(`program fetch failed: ${response.status}`);
      }
      return (window as any).__runTest(
        await response.arrayBuffer(),
        ["rlimit-fsize-test"],
        30_000,
      );
    },
    { programUrl },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("RLIMIT_FSIZE_PASS");
  expect(result.stderr).toBe("");
  expect(runtimeErrors).toEqual([]);
});
