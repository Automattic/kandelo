import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/locale_info_test.wasm",
);

test("locale object names and alternate months work in Chromium", async ({
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
  await page.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 204 }),
  );

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
        ["locale-info-test"],
        60_000,
      );
    },
    { programUrl },
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("locale-info-ok\n");
  expect(result.stderr).toBe("");
  expect(runtimeErrors).toEqual([]);
});
