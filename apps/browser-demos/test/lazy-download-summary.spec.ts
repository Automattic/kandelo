import { expect, test } from "@playwright/test";

const kernelHostModuleUrl = "/test/lazy-download-summary-browser.ts";

test("lazy-download summaries survive raw-ring rollover and report resets", async ({ page }) => {
  await page.goto("/terminate-atomics-test.html");

  const evidence = await page.evaluate(async (moduleUrl) => {
    const { LiveKernelHost } = await import(/* @vite-ignore */ moduleUrl);
    const host = new LiveKernelHost();
    host.emitLazyDownloadEvent({
      id: "early",
      kind: "tree",
      status: "started",
      url: "https://example.test/early.tar.gz",
      mountPrefix: "/",
      loadedBytes: 0,
      totalBytes: 1,
      t: 1,
    });
    host.emitLazyDownloadEvent({
      id: "early",
      kind: "tree",
      status: "complete",
      url: "https://example.test/early.tar.gz",
      mountPrefix: "/",
      loadedBytes: 1,
      totalBytes: 1,
      t: 2,
    });
    for (let chunk = 1; chunk <= 600; chunk++) {
      host.emitLazyDownloadEvent({
        id: "stream",
        kind: "tree",
        status: "progress",
        url: "https://example.test/stream.tar.gz",
        mountPrefix: "/",
        loadedBytes: chunk,
        totalBytes: 600,
        t: chunk + 2,
      });
    }

    const history = host.lazyDownloadHistory();
    const summariesBeforeReset = host.lazyDownloadSummaries();
    const resetStates: string[][] = [];
    host.subscribeLazyDownloadSummaries(() => {
      resetStates.push(host.lazyDownloadSummaries().map(({ status }: {
        status: string;
      }) => status));
    });
    host.attachKernel({ fs: {} });

    return {
      historyLength: history.length,
      historyIsChronological: history.every((event: { t: number }, index: number) =>
        index === 0 || history[index - 1]!.t < event.t
      ),
      historyRetainsEarlyAsset: history.some(({ id }: { id: string }) => id === "early"),
      summariesBeforeReset: summariesBeforeReset.map((summary: {
        id: string;
        status: string;
        eventCount: number;
      }) => ({
        id: summary.id,
        status: summary.status,
        eventCount: summary.eventCount,
      })),
      resetStates,
      historyAfterReset: host.lazyDownloadHistory(),
      summariesAfterReset: host.lazyDownloadSummaries(),
    };
  }, kernelHostModuleUrl);

  expect(evidence).toEqual({
    historyLength: 512,
    historyIsChronological: true,
    historyRetainsEarlyAsset: false,
    summariesBeforeReset: [
      { id: "early", status: "complete", eventCount: 2 },
      { id: "stream", status: "progress", eventCount: 600 },
    ],
    resetStates: [
      ["complete", "error"],
      [],
    ],
    historyAfterReset: [],
    summariesAfterReset: [],
  });
});

test("package-prefetch errors remain visible and expose a generic retry", async ({ page }) => {
  await page.goto("/terminate-atomics-test.html");
  await page.evaluate(async (moduleUrl) => {
    const { mountPackagePrefetchToastFixture } = await import(/* @vite-ignore */ moduleUrl);
    const container = document.createElement("div");
    container.id = "package-prefetch-fixture";
    document.body.append(container);
    mountPackagePrefetchToastFixture(container, [{
      id: "c-development-toolchain",
      label: "C/C++ toolchain",
      roots: ["kandelo-dev/tap-core/kandelo-sdk"],
      status: "error",
      attempt: 1,
      error: "compiler tree digest mismatch",
    }]);
  }, kernelHostModuleUrl);

  const error = page.getByRole("alert");
  await expect(error).toContainText("C/C++ toolchain: compiler tree digest mismatch");
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("#package-prefetch-fixture"))
    .toHaveAttribute("data-retry-id", "c-development-toolchain");
  await page.waitForTimeout(5_100);
  await expect(error).toBeVisible();
});
