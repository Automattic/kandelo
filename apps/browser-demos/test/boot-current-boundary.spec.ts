import { expect, test } from "@playwright/test";

const helperModuleUrl = "/pages/kandelo/kernel-host/boot-current-boundary.ts";

test("a superseded boot stops after imported-seal verification resumes", async ({
  page,
}) => {
  await page.goto(helperModuleUrl);
  const result = await page.evaluate(async (moduleUrl) => {
    const { verifyImportedSealsForCurrentBoot } = await import(moduleUrl);
    let resume!: () => void;
    const verification = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let current = true;
    const effects: string[] = [];

    const boot = (async () => {
      await verifyImportedSealsForCurrentBoot({
        verifyImportedLazyAtomicGroupSeals: () => verification,
      });
      if (!current) throw new Error("boot superseded");
      effects.push("fetch", "filesystem mutation", "presentation overwrite");
    })();

    current = false;
    resume();
    let error = "";
    try {
      await boot;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    return { effects, error };
  }, helperModuleUrl);

  expect(result.error).toBe("boot superseded");
  expect(result.effects).toEqual([]);
});

test("a queued supersession cannot overtake the owning boot continuation", async ({
  page,
}) => {
  await page.goto(helperModuleUrl);
  const events = await page.evaluate(async (moduleUrl) => {
    const { verifyImportedSealsForCurrentBoot } = await import(moduleUrl);
    let resume!: () => void;
    const verification = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let current = true;
    const observed: string[] = [];

    const boot = (async () => {
      await verifyImportedSealsForCurrentBoot({
        verifyImportedLazyAtomicGroupSeals: () => verification,
      });
      if (!current) throw new Error("boot superseded");
      observed.push(`effect:${current}`);
    })();

    resume();
    queueMicrotask(() => {
      current = false;
      observed.push("supersede");
    });
    await boot;
    await Promise.resolve();
    return observed;
  }, helperModuleUrl);

  expect(events).toEqual(["effect:true", "supersede"]);
});

test("returns the filesystem verification promise without an async wrapper", async ({
  page,
}) => {
  await page.goto(helperModuleUrl);
  const preservesPromiseIdentity = await page.evaluate(async (moduleUrl) => {
    const { verifyImportedSealsForCurrentBoot } = await import(moduleUrl);
    const verification = Promise.resolve();
    return (
      verifyImportedSealsForCurrentBoot({
        verifyImportedLazyAtomicGroupSeals: () => verification,
      }) === verification
    );
  }, helperModuleUrl);

  expect(preservesPromiseIdentity).toBe(true);
});
