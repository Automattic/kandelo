import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../local-binaries/programs/wasm32/procfs-foreign-fd-stat.wasm",
);

test("procfs follows foreign fd metadata in Chromium", async ({
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
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
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

  const programUrl = new URL(
    "/__test-fixtures__/procfs-foreign-fd-stat.wasm",
    baseURL,
  ).href;
  await page.route(programUrl, async (route) => {
    await route.fulfill({
      path: programPath,
      contentType: "application/wasm",
    });
  });

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const result = await page.evaluate(
    async ({ programUrl }) => {
      const response = await fetch(programUrl);
      if (!response.ok) {
        throw new Error(`program fetch failed: ${response.status}`);
      }
      return (window as any).__runTest(
        await response.arrayBuffer(),
        ["procfs-foreign-fd-stat"],
        15_000,
      );
    },
    { programUrl },
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("procfs-foreign-fd-stat-ok\n");
  expect(result.stderr).toBe("");
  expect(runtimeErrors).toEqual([]);
});
