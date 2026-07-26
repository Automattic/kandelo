import { expect, test } from "@playwright/test";

const helperModuleUrl = "/pages/vfs-import-seal-boundary.ts";

for (const forgery of ["member", "cohort"] as const) {
  test(`browser worker init rejects a forged ${forgery} seal before ready`, async ({
    page,
  }) => {
    await page.goto(helperModuleUrl);
    const result = await page.evaluate(async ({ moduleUrl, forgery }) => {
      const { rejectForgedImageAtBrowserWorkerInit } = await import(moduleUrl);
      return rejectForgedImageAtBrowserWorkerInit(forgery);
    }, { moduleUrl: helperModuleUrl, forgery });

    expect(result.error).toMatch(
      /Kernel worker init failed: Lazy atomic activation (member|group)/,
    );
    expect(result.error).not.toMatch(/unexpectedly passed/);
    expect(result.workerStartedAfterRejection).toBe(false);
  });
}
