import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const guests = [
  {
    name: "named FIFO rendezvous and blocked-open cancellation",
    programPath: resolve(
      __dirname,
      "../../../examples/fifo_lifecycle_test.wasm",
    ),
    argv: ["fifo-lifecycle-test"],
    markers: [
      "FIFO_RENDEZVOUS_PASS",
      "FIFO_ENQUEUED_CANCEL_PASS",
      "FIFO_PRE_ENQUEUE_CANCEL_PASS",
      "FIFO_DISABLED_CANCEL_PASS",
      "FIFO_SIGNAL_EINTR_PASS",
      "FIFO_CANCEL_PASS",
      "FIFO_PATH_ONLY_PASS",
      "FIFO_FUTIMENS_PERMISSIONS_PASS",
      "FIFO_CACHED_CTIME_PASS",
      "FIFO_LIFECYCLE_PASS",
    ],
  },
  {
    name: "SCM_RIGHTS pipe and FIFO reference lifetime",
    programPath: resolve(
      __dirname,
      "../../../local-binaries/programs/wasm32/scm-rights-pipe-lifetime.wasm",
    ),
    argv: ["scm-rights-pipe-lifetime"],
    markers: [
      "PASS: SCM_RIGHTS owns pipe and FIFO references in flight and after receipt",
    ],
  },
] as const;

for (const guest of guests) {
  test(`${guest.name} works in Chromium`, async ({
    page,
    baseURL,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
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

    await page.goto(new URL("/pages/test-runner/", baseURL).href);
    await page.waitForFunction(() => (window as any).__testRunnerReady === true);

    const programUrl = new URL(`/@fs/${guest.programPath}`, baseURL).href;
    const result = await page.evaluate(
      async ({ programUrl, argv }) => {
        const response = await fetch(programUrl);
        if (!response.ok) {
          throw new Error(
            `program fetch failed: ${response.status} ${response.url}`,
          );
        }
        return (window as any).__runTest(
          await response.arrayBuffer(),
          argv,
          30_000,
        );
      },
      { programUrl, argv: [...guest.argv] },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    for (const marker of guest.markers) {
      expect(result.stdout).toContain(marker);
    }
    expect(result.stderr).toBe("");
    expect(runtimeErrors).toEqual([]);
  });
}
