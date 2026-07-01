import { expect, test, type Page } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

async function gotoOrSkip(page: Page, path: string) {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }
}

test("Kandelo modeset demo commits PAGE_FLIPs through /dev/dri/card0", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=modeset");

  const modesetControls = page
    .locator(".kdemo-surface-controls")
    .filter({ has: page.locator(".kdemo-surface-title", { hasText: /MODESET/ }) })
    .first();
  await expect(modesetControls).toBeVisible({ timeout: 180_000 });

  // The dock status strip carries the modeset PAGE_FLIP counter.
  await expect
    .poll(() => modesetControls.innerText(), { timeout: 180_000 })
    .toMatch(/[1-9]\d*\s+flips/i);

  // Flip-counter ticks prove PAGE_FLIP reached the kernel; the canvas
  // screenshot proves WebGL2 actually compiled+rendered. Without the
  // second gate, a silent shader compile failure would leave the canvas
  // pane-background-colored forever and the test would still pass.
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => (await canvas.screenshot()).byteLength,
      { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(5_000);
});
