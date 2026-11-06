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


test("unresolved asset errors survive toast expiry and remount, and a new failure needs new acknowledgement", async ({ page }, testInfo) => {
  await page.goto("/terminate-atomics-test.html");
  await page.clock.install();
  await page.evaluate(async (moduleUrl) => {
    const { LiveKernelHost, mountLazyDownloadToasts } = await import(/* @vite-ignore */ moduleUrl);
    const host = new LiveKernelHost();
    const fixture = (window as any).__lazyFailure = { host, unmount: mountLazyDownloadToasts(host) };
    fixture.event = (status: string) => host.emitLazyDownloadEvent({ id: "font", kind: "file", status,
      url: "https://example.test/font.bin", loadedBytes: 3, t: 1,
      ...(status === "error" ? { error: "Native VFS rejected font.bin: SHA-256 mismatch; EIO" } : {}) });
    fixture.event("started");fixture.event("complete");fixture.event("error");
  }, kernelHostModuleUrl);
  await expect(page.getByRole("alert")).toContainText("SHA-256 mismatch; EIO");
  await page.clock.fastForward(6_000);
  await expect(page.getByRole("alert")).toBeVisible();
  const style = await page.getByRole("alert").evaluate(element => {
    // Finish any CSS animation rather than waiting on wall time. Visibility
    // assertions alone still pass when an element has opacity zero.
    for (const animation of element.getAnimations()) animation.finish();
    const computed = getComputedStyle(element);
    return { opacity: computed.opacity, animationName: computed.animationName };
  });
  await testInfo.attach("error-style.json", { body: JSON.stringify(style), contentType: "application/json" });
  await expect(page.getByRole("alert")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("alert")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".kdownload-toast-error .kdownload-toast-detail")).toHaveCSS("white-space", "normal");
  await page.evaluate(async (moduleUrl) => {
    const { mountLazyDownloadToasts } = await import(/* @vite-ignore */ moduleUrl);
    const fixture = (window as any).__lazyFailure;
    fixture.unmount(); fixture.unmount = mountLazyDownloadToasts(fixture.host);
  }, kernelHostModuleUrl);
  await expect(page.getByRole("alert")).toContainText("SHA-256 mismatch; EIO");
  await page.getByRole("button", { name: "Dismiss font.bin download status" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Same URL and wall-clock timestamp: the authoritative event sequence,
  // not elapsed time, proves this is a later failure requiring acknowledgement.
  await page.evaluate(() => {
    const fixture = (window as any).__lazyFailure;
    fixture.event("started");fixture.event("error");
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await page.evaluate(() => (window as any).__lazyFailure.event("complete"));
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.clock.fastForward(3_000);
  await expect(page.getByLabel("Download status")).toHaveCount(0);
});

test("failed asset snapshots remain visible ahead of newer successful or active transfers", async ({ page }) => {
  await page.goto("/terminate-atomics-test.html");
  await page.evaluate(async (moduleUrl) => {
    const { LiveKernelHost, mountLazyDownloadToasts } = await import(/* @vite-ignore */ moduleUrl);
    const host = new LiveKernelHost();
    host.emitLazyDownloadEvent({ id: "font", kind: "file", status: "error", loadedBytes: 0, t: 1,
      url: "https://example.test/font.bin", error: "Lazy response exceeds native byte bound 3" });
    for (let i = 0; i < 4; i++) host.emitLazyDownloadEvent({ id: `new-${i}`, kind: "file",
      status: "progress", loadedBytes: i, t: 100+i, url: `https://example.test/new-${i}.bin` });
    (window as any).__lazyUnmount = mountLazyDownloadToasts(host);
  }, kernelHostModuleUrl);
  await expect(page.getByRole("alert")).toContainText("native byte bound 3");
  await expect(page.locator(".kdownload-toast").first()).toHaveAttribute("role", "alert");
  await expect(page.locator(".kdownload-toast-error .kdownload-toast-bar > span")).toHaveCSS("animation-name", "none");
});


test("replacing a machine clears its unresolved asset errors and acknowledgement state", async ({ page }) => {
  await page.goto("/terminate-atomics-test.html");
  await page.evaluate(async (moduleUrl) => {
    const { LiveKernelHost, mountLazyDownloadToasts } = await import(/* @vite-ignore */ moduleUrl);
    const host = new LiveKernelHost();
    (window as any).__lazyReplacement = { host, unmount: mountLazyDownloadToasts(host) };
    host.emitLazyDownloadEvent({ id: "font", kind: "file", status: "error", t: 1,
      url: "https://example.test/font.bin", loadedBytes: 0, error: "old machine asset failed" });
  }, kernelHostModuleUrl);
  await expect(page.getByRole("alert")).toContainText("old machine asset failed");
  await page.evaluate(() => (window as any).__lazyReplacement.host.attachKernel({ fs: {} }));
  await expect(page.getByLabel("Download status")).toHaveCount(0);
  await page.evaluate(() => (window as any).__lazyReplacement.host.emitLazyDownloadEvent({
    id: "font", kind: "file", status: "error", t: 1,
    url: "https://example.test/font.bin", loadedBytes: 0, error: "replacement machine asset failed",
  }));
  await expect(page.getByRole("alert")).toContainText("replacement machine asset failed");
  await page.getByRole("button", { name: "Dismiss font.bin download status" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  // React may batch the reset and the new failure into one render: there is
  // no intervening empty UI to clear the old acknowledgement by accident.
  await page.evaluate(() => {
    const host = (window as any).__lazyReplacement.host;
    host.attachKernel({ fs: {} });
    host.emitLazyDownloadEvent({ id: "font", kind: "file", status: "error", t: 1,
      url: "https://example.test/font.bin", loadedBytes: 0, error: "next machine asset failed" });
  });
  await expect(page.getByRole("alert")).toContainText("next machine asset failed");
});
