import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programs = [
  {
    name: "wasm32",
    path: resolve(
      __dirname,
      "../../../examples/terminal_attributes_api_test.wasm",
    ),
  },
  {
    name: "memory64",
    path: resolve(
      __dirname,
      "../../../examples/terminal_attributes_api_test.wasm64.wasm",
    ),
  },
];

for (const program of programs) {
  test(
    `musl terminal attribute and queue APIs match in Chromium (${program.name})`,
    async ({ page, baseURL, browserName }) => {
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

      await page.goto(new URL("/pages/test-runner/", baseURL).href);
      await page.waitForFunction(
        () => (window as any).__testRunnerReady === true,
      );

      const programUrl = new URL(`/@fs/${program.path}`, baseURL).href;
      const result = await page.evaluate(async ({ programUrl }) => {
        const response = await fetch(programUrl);
        if (!response.ok) {
          throw new Error(`program fetch failed: ${response.status}`);
        }
        return (window as any).__runTest(
          await response.arrayBuffer(),
          ["terminal-attributes-api-test"],
          20_000,
        );
      }, { programUrl });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("TERMINAL_ATTRIBUTES_API_PASS");
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      expect(runtimeErrors).toEqual([]);
    },
  );
}
