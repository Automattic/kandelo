import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/mount_probe_test.wasm",
);

test("browser resolves pathname components and rejects an invalid initial cwd", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "the aggregate browser gate uses Chromium",
  );
  expect(baseURL).toBeTruthy();

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const result = await page.evaluate(
    async ({ programUrl }) => {
      const response = await fetch(programUrl);
      if (!response.ok) {
        throw new Error(`program fetch failed: ${response.status}`);
      }
      const program = await response.arrayBuffer();
      const probe = await (window as any).__runTest(
        program.slice(0),
        ["mount_probe_test", "path-resolution", "/tmp/kandelo-path-resolution"],
        15_000,
        {
          dataFiles: [{ path: "/etc/services", data: [1, 2, 3, 4] }],
        },
      );
      const cwdError = await (window as any)
        .__runTest(
          program.slice(0),
          ["mount_probe_test", "rootfs", "/etc/services"],
          15_000,
          { cwd: "/no/such/cwd" },
        )
        .then(
          () => null,
          (error: unknown) => String(error),
        );
      return { probe, cwdError };
    },
    { programUrl },
  );

  expect(result.probe.exitCode, result.probe.stderr).toBe(0);
  expect(result.probe.stdout).toContain("PATH_RESOLUTION_PASS");
  expect(result.probe.stderr).toBe("");
  expect(result.cwdError).toMatch(/setCwd failed for pid \d+: errno 2/);
});
