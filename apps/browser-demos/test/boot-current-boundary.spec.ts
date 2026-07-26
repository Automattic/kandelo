import { expect, test } from "@playwright/test";
import { verifyImportedSealsForCurrentBoot } from "../pages/kandelo/kernel-host/boot-current-boundary";

test("a superseded boot stops after imported-seal verification resumes", async () => {
  let resume!: () => void;
  const verification = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let current = true;
  const effects: string[] = [];

  const boot = (async () => {
    await verifyImportedSealsForCurrentBoot(
      { verifyImportedLazyAtomicGroupSeals: () => verification },
      () => {
        if (!current) throw new Error("boot superseded");
      },
    );
    effects.push("fetch", "filesystem mutation", "presentation overwrite");
  })();

  current = false;
  resume();
  await expect(boot).rejects.toThrow("boot superseded");
  expect(effects).toEqual([]);
});
