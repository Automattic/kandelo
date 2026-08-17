import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programs = [
  {
    arch: "wasm32",
    path: resolve(__dirname, "../../../examples/putenv_test.wasm"),
  },
  {
    arch: "wasm64",
    path: resolve(__dirname, "../../../examples/putenv_test.wasm64.wasm"),
  },
] as const;

for (const program of programs) {
  test(`environment metadata exact-capacity, capacity+1, and long-name cases stay coherent for ${program.arch} in Chromium`, async ({
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

    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
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
        const programBytes = await response.arrayBuffer();
        return (window as any).__runTest(
          programBytes,
          ["putenv-test"],
          30_000,
          {
            env: ["HOME=/home/test", "PATH=/usr/bin"],
          },
        );
      },
      { programUrl },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("SETENV_BOUNDARY_PASS");
    expect(result.stdout).toContain("PUTENV_LONG_BOUNDARY_PASS");
    expect(result.stdout).toContain("ENV_COHERENCE_PASS");
    expect(result.stdout).toContain("DONE");
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
    expect(runtimeErrors).toEqual([]);
  });
}
