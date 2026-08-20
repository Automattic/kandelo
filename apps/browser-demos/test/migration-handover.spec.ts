import { expect, test, type Page } from "@playwright/test";

import { doomSharewareWad } from "../../../host/test/support/doom-shareware";

declare global {
  interface Window {
    __migrationDemo: {
      state: () => string;
      framePixelSum: () => number;
    };
  }
}

function pixelSum(page: Page): Promise<number> {
  return page.evaluate(() => window.__migrationDemo.framePixelSum());
}

test("hands a running fbDOOM machine from one tab to another", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(300_000);
  expect(baseURL).toBeTruthy();
  // The demo page fetches the same pinned shareware IWAD; this Node-side
  // probe skips the test on an offline machine instead of failing it.
  try {
    await doomSharewareWad();
  } catch {
    test.skip(true, "doom1.wad unavailable (offline) — the demo can't run");
    return;
  }

  await page.goto(new URL("/pages/migration/", baseURL!).href);
  await page.click("#start");
  await page.waitForFunction(
    () => window.__migrationDemo?.state().startsWith("Running."),
    undefined,
    { timeout: 120_000 },
  );
  // The attract demo animates: the frame must exist and keep changing.
  await expect
    .poll(() => pixelSum(page), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const keeperFrame = await pixelSum(page);
  await expect
    .poll(() => pixelSum(page), { timeout: 30_000 })
    .not.toBe(keeperFrame);

  const taker = await context.newPage();
  await taker.goto(new URL("/pages/migration/", baseURL!).href);
  await taker.click("#take");
  await taker.waitForFunction(
    () => window.__migrationDemo?.state().includes("taken over"),
    undefined,
    { timeout: 120_000 },
  );
  await page.waitForFunction(
    () => window.__migrationDemo?.state().startsWith("Handed over"),
    undefined,
    { timeout: 30_000 },
  );

  // The receiver's frame arrived seeded from the checkpoint and the game
  // keeps rendering new frames in the taking tab.
  await expect
    .poll(() => pixelSum(taker), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const restoredFrame = await pixelSum(taker);
  await expect
    .poll(() => pixelSum(taker), { timeout: 30_000 })
    .not.toBe(restoredFrame);
});
