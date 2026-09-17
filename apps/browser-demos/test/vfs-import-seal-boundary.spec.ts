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

  // The KERNEL's refusal, not the harness's. The browser host prefixes it
  // "Kernel worker failed:" where Node says "Kernel worker init failed:", so
  // matching the prefix would have pinned the host's phrasing; this matches
  // the part that says initialization is what failed. The control that makes
  // the refusal specifically about the declared ABI lives in
  // `host/test/node-kernel-init-refused-image.test.ts`, where the same tree
  // boots when nothing is declared wrong.
  expect(result.error).toMatch(/kernel initialization completion failed/);
  expect(result.error).not.toMatch(/unexpectedly passed/);
  expect(result.workerStartedAfterRejection).toBe(false);
});
