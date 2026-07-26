import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programs = [
  {
    name: "wasm32",
    path: resolve(
      __dirname,
      "../../../examples/process_native_layout_test.wasm",
    ),
  },
  {
    name: "memory64",
    path: resolve(
      __dirname,
      "../../../examples/process_native_layout_test.wasm64.wasm",
    ),
  },
] as const;

for (const program of programs) {
  test(
    `caller-native signal, timer, message-queue, statfs, and sysinfo layouts match in Chromium (${program.name})`,
    async ({ page, baseURL, browserName }) => {
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
          `requestfailed: ${request.url()} ${
            request.failure()?.errorText ?? "failed"
          }`,
        );
      });

      await page.goto(
        new URL("/pages/test-runner/?minimal=1", baseURL).href,
      );
      await page.waitForFunction(
        () => (window as any).__testRunnerReady === true,
      );

      const programUrl = new URL(`/@fs/${program.path}`, baseURL).href;
      const result = await page.evaluate(async ({ programUrl }) => {
        const response = await fetch(programUrl);
        if (!response.ok) {
          throw new Error(
            `program fetch failed: ${response.status} ${response.url}`,
          );
        }
        return (window as any).__runTest(
          await response.arrayBuffer(),
          ["process-native-layout-test"],
          30_000,
        );
      }, { programUrl });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("PROCESS NATIVE LAYOUTS PASSED");
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      expect(runtimeErrors).toEqual([]);
    },
  );
}
