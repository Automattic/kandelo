import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/getdents_boundary_test.wasm",
);

for (const filesystem of ["tmpfs", "rootfs"] as const) {
  test(`getdents64 preserves ${filesystem} directory entries and positions`, async ({
    page,
    baseURL,
    browserName,
  }) => {
    test.skip(
      filesystem === "tmpfs" && browserName !== "chromium",
      "the aggregate tmpfs browser gate uses Chromium",
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

    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(
      () => (window as any).__testRunnerReady === true,
    );

    const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
    const result = await page.evaluate(
      async ({ programUrl, filesystem }) => {
        const response = await fetch(programUrl);
        if (!response.ok) {
          throw new Error(`program fetch failed: ${response.status}`);
        }
        return (window as any).__runTest(
          await response.arrayBuffer(),
          filesystem === "rootfs"
            ? ["getdents-boundary-test", "rootfs"]
            : ["getdents-boundary-test"],
          30_000,
        );
      },
      { programUrl, filesystem },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("GETDENTS_BOUNDARY_PASS");
    expect(result.stderr).toBe("");
    expect(runtimeErrors).toEqual([]);
  });
}
