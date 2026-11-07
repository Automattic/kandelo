import { expect, test, type Locator, type Page } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

/** Sample the actually presented canvas, including OffscreenCanvas scanout. */
async function fluidPixels(page: Page, canvas: Locator): Promise<number[]> {
  const png = await canvas.screenshot();
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(64, 64).getContext("2d")!;
    context.drawImage(bitmap, 0, 0, 64, 64);
    bitmap.close();
    return Array.from(context.getImageData(0, 0, 64, 64).data);
  }, png.toString("base64"));
}

function coloredPixels(pixels: number[]): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const high = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    const low = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (high > 64 && high - low > 40) count++;
  }
  return count;
}

function changedPixels(before: number[], after: number[]): number {
  let count = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (Math.max(Math.abs(before[i] - after[i]), Math.abs(before[i + 1] - after[i + 1]),
      Math.abs(before[i + 2] - after[i + 2])) > 8)
      count++;
  }
  return count;
}

test("Kandelo modeset demo commits PAGE_FLIPs through /dev/dri/card0", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoMachineOrSkip(page, "modeset");

  const modesetControls = page
    .locator(".kdemo-surface-controls")
    .filter({ has: page.locator(".kdemo-surface-title", { hasText: /MODESET/ }) })
    .first();
  await expect(modesetControls).toBeVisible({ timeout: 180_000 });

  // The dock status strip carries the modeset PAGE_FLIP counter.
  await expect
    .poll(() => modesetControls.innerText(), { timeout: 180_000 })
    .toMatch(/[1-9]\d*\s+flips/i);

  const canvas = page.locator(".kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  // Locator screenshots include overlays. A download card is not fluid dye.
  await expect(page.getByRole("complementary", { name: "Download status" }))
    .toBeHidden({ timeout: 60_000 });

  // Refresh the dye through ordinary guest input even if startup's seeded
  // splats faded while assets loaded. Keep the drag below its teleport guard.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.51, box.y + box.height * 0.51, { steps: 8 });
  await page.mouse.up();

  // Flips and PNG size can both pass for a blank/stale surface. Require
  // colored dye and changing presented pixels, rather than metadata alone.
  let first: number[] = [];
  await expect
    .poll(
      async () => {
        first = await fluidPixels(page, canvas);
        return coloredPixels(first);
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(16);
  await expect
    .poll(async () => changedPixels(first, await fluidPixels(page, canvas)),
      { timeout: 60_000, intervals: [1_000, 2_000, 5_000] })
    .toBeGreaterThan(16);
});
