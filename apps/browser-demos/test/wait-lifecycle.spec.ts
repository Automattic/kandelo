import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programs = [
  {
    name: "wasm32",
    path: resolve(__dirname, "../../../examples/wait_lifecycle_test.wasm"),
  },
  {
    name: "memory64",
    path: resolve(
      __dirname,
      "../../../examples/wait_lifecycle_test.wasm64.wasm",
    ),
  },
];

for (const program of programs)
  test(`child wait lifecycle works in Chromium (${program.name})`, async ({
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
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        runtimeErrors.push(`console: ${message.text()}`);
      }
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
    await page.waitForFunction(
      () => (window as any).__testRunnerReady === true,
    );

    const programUrl = new URL(`/@fs/${program.path}`, baseURL).href;
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
          ["wait-lifecycle-test"],
          30_000,
        );
      },
      { programUrl },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WAIT_LIFECYCLE_PASS");
    expect(result.stderr).toBe("");
    expect(runtimeErrors).toEqual([]);
  });
