import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/pthread_channel_reuse_test.wasm",
);

test("a recycled pthread channel dispatches in Chromium", async ({
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
  page.on("pageerror", (error) =>
    runtimeErrors.push(`pageerror: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const result = await page.evaluate(
    async ({ programUrl }) => {
      const response = await fetch(programUrl);
      if (!response.ok) {
        throw new Error(
          `program fetch failed: ${response.status} ${response.url}`,
        );
      }
      return (window as any).__runTest(
        await response.arrayBuffer(),
        ["pthread-channel-reuse-test"],
        30_000,
      );
    },
    { programUrl },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("PTHREAD_CHANNEL_REUSE_PASS");
  expect(result.stderr).toBe("");
  expect(runtimeErrors).toEqual([]);
});
