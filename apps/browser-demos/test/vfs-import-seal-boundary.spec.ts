import { expect, test } from "@playwright/test";

const helperModuleUrl = "/pages/vfs-import-seal-boundary.ts";

for (const forgery of ["member", "cohort"] as const) {
  test(`BrowserKernel rejects a forged ${forgery} seal before ready`, async ({
    page,
  }) => {
    await page.goto(helperModuleUrl);
    const result = await page.evaluate(async ({ moduleUrl, forgery }) => {
      const { rejectForgedImageBeforeBrowserReady } = await import(moduleUrl);
      return rejectForgedImageBeforeBrowserReady(forgery);
    }, { moduleUrl: helperModuleUrl, forgery });

    expect(result.error).toMatch(
      /Kernel worker init failed: Lazy atomic activation (member|group)/,
    );
    expect(result.error).not.toMatch(/WebAssembly|compile|unexpectedly reached/);
    expect(result.workerStartedAfterRejection).toBe(false);
  });
}
