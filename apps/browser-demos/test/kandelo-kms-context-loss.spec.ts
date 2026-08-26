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

// `chrome.gpuBenchmarking.crashGpuProcess` is the only way to lose a real
// WebGL context on demand. The flag replaces the config's launchOptions
// for this file only; the dropped browserLaunchEnv strip matters to
// WebKitGTK, not Chromium.
test.use({ launchOptions: { args: ["--enable-gpu-benchmarking"] } });

/** The Modeset status chip's fields out of the rendered page text:
 *  "1918×1080 · 349 FLIPS · 115295MS · WEBGL2". */
async function chip(page: Page): Promise<{ flips: number; renderer: string }> {
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(/(\d+)\s*flips\s*·[^·]*·\s*(webgl2-gl|webgl2|2d)/i);
  return m
    ? { flips: Number(m[1]), renderer: m[2].toLowerCase() }
    : { flips: -1, renderer: "" };
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

/** The desktop repaints continuously (wlclock animates ~10 fps), so two
 *  captures spaced apart must differ while the presenter is alive. */
async function canvasAdvances(page: Page): Promise<boolean> {
  const canvas = canvasLocator(page);
  const before = await canvas.screenshot();
  await page.waitForTimeout(1_500);
  const after = await canvas.screenshot();
  return !after.equals(before);
}

/**
 * A lost WebGL context silently no-ops every GL call: without loss
 * handling the vblank pump keeps "presenting", the kernel-side FLIPS
 * counter keeps advancing, and the canvas freezes on the last composited
 * frame with no error anywhere — the exact field failure on the desktop
 * demos. The kernel-worker presenter must stand down on `webglcontextlost`
 * (cancelling it to opt into restoration) and rebuild on
 * `webglcontextrestored`. Crashing the GPU process loses every context in
 * the browser, so a desktop that keeps animating afterwards proves the
 * rebuild path end to end.
 */
test("the webgl2 scanout presenter survives a GPU process crash", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=wayland");

  await expect(canvasLocator(page)).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await chip(page)).renderer, { timeout: 180_000 })
    .toMatch(/webgl2/);
  expect(await canvasAdvances(page), "desktop not animating before the crash")
    .toBe(true);

  await page.evaluate(() =>
    (window as unknown as {
      chrome: { gpuBenchmarking: { crashGpuProcess: () => void } };
    }).chrome.gpuBenchmarking.crashGpuProcess(),
  );

  // Restoration is async (GPU process restart + webglcontextrestored).
  // The rebuilt presenter must repaint and the desktop must animate again;
  // a presenter without loss handling freezes here while FLIPS advance.
  await expect
    .poll(() => canvasAdvances(page), {
      timeout: 60_000,
      intervals: [2_000, 5_000],
    })
    .toBe(true);
  await expect
    .poll(async () => (await chip(page)).renderer, { timeout: 30_000 })
    .toMatch(/webgl2/);

  const settled = await chip(page);
  await page.waitForTimeout(2_000);
  expect(
    (await chip(page)).flips,
    "kernel-side page flips stopped after the GPU crash",
  ).toBeGreaterThan(settled.flips);

  // Second crash: the desktop now runs the OTHER presenter. A GPU-path
  // boot puts wlcompositor's GL session on the canvas (webgl2-gl), and
  // the first crash degrades it to CPU compositing behind the pump's
  // webgl2-scanout presenter — so one crash per phase covers both the
  // program-owned release chain and the pump presenter's own
  // loss/rebuild path, whichever the boot happened to start on.
  await page.evaluate(() =>
    (window as unknown as {
      chrome: { gpuBenchmarking: { crashGpuProcess: () => void } };
    }).chrome.gpuBenchmarking.crashGpuProcess(),
  );
  await expect
    .poll(() => canvasAdvances(page), {
      timeout: 60_000,
      intervals: [2_000, 5_000],
    })
    .toBe(true);
  await expect
    .poll(async () => (await chip(page)).renderer, { timeout: 30_000 })
    .toMatch(/webgl2/);
});
