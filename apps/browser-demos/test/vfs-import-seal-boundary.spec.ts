import { expect, test } from "@playwright/test";

const helperModuleUrl = "/pages/vfs-import-seal-boundary.ts";

/**
 * RENAMED IN SPIRIT, 2026-09-16: this proves that a REFUSED image leaves no
 * kernel worker alive, which is what it always proved.
 *
 * It was called "rejects a forged seal before ready", and the "before" was
 * never true: nothing on the main thread inspects the image, and the check
 * that rejected it ran inside the worker the assertion claims was not started.
 * What makes `workerStarted` false is `bootWorker`'s catch, which tears down
 * its half-created worker before rethrowing.
 *
 * The image is now one the KERNEL refuses — it declares an ABI it was not
 * built for, which `image_policy::check_declared_abi` answers with EPROTO.
 * The cohort-seal refusal this used to drive is asserted in `runtime-core`, on
 * a genuine exported container with a negative control, because the producer
 * refuses to emit a forged image and TypeScript cannot build one.
 */
test("browser worker init refuses an image the kernel rejects, and keeps no worker", async ({
  page,
}) => {
  await page.goto(helperModuleUrl);
  const result = await page.evaluate(async ({ moduleUrl }) => {
    const { rejectRefusedImageAtBrowserWorkerInit } = await import(moduleUrl);
    // An ABI no build of this kernel carries.
    return rejectRefusedImageAtBrowserWorkerInit(7);
  }, { moduleUrl: helperModuleUrl });

  expect(result.error).toMatch(/Kernel worker init failed/);
  expect(result.error).not.toMatch(/unexpectedly passed/);
  expect(result.workerStartedAfterRejection).toBe(false);
});
