import { expect, test } from "@playwright/test";

const helperModuleUrl = "/pages/vfs-import-seal-boundary.ts";

/**
 * Proves that a REFUSED image leaves no kernel worker alive.
 *
 * It does not prove the refusal happens before a worker exists: nothing on the
 * main thread inspects the image, and the check that rejects it runs inside
 * the worker. What makes `workerStarted` false is `bootWorker`'s catch, which
 * tears down its half-created worker before rethrowing.
 *
 * The image is one the KERNEL refuses — it declares an ABI it was not built
 * for, which `image_policy::check_declared_abi` answers with EPROTO. Forged
 * cohort seals are refused by the same loader and asserted in `runtime-core`,
 * on a genuine exported container with a negative control, because the image
 * writer refuses to emit a forged image and TypeScript cannot build one.
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
