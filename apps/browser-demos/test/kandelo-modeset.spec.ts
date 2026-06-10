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

  const modesetHead = page
    .locator(".kpane-head")
    .filter({ has: page.locator(".kpane-head-title", { hasText: /MODESET/ }) })
    .first();
  await expect(modesetHead).toBeVisible({ timeout: 180_000 });

  // Pane CSS applies text-transform: uppercase, so match case-insensitively.
  await expect
    .poll(() => modesetHead.innerText(), { timeout: 180_000 })
    .toMatch(/[1-9]\d*\s+flips/i);

  // The flip counter ticking is necessary but not sufficient — it only
  // proves PAGE_FLIP ioctls reach the kernel. The actual rendering
  // gate is: WebGL2 acquired the scanout canvas and Pavel's fluid sim
  // is producing pixels. Grab a screenshot of the canvas and require
  // at least one non-background pixel; if the shaders silently
  // failed-to-compile against a null `b.gl`, the canvas stays the
  // pane-background color forever and this assertion fails loudly
  // rather than passing on flip-counter alone.
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => {
        const buf = await canvas.screenshot();
        // PNG IDAT comes after the 8-byte signature + IHDR chunk;
        // for our purposes a "real" frame produces a screenshot
        // measurably larger than a uniform-color one. Empirically a
        // blank 800×600 canvas serializes to <2 KiB; Pavel's fluid
        // sim frame is ~20 KiB+. The threshold leaves a wide margin.
        return buf.byteLength;
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(5_000);
});
