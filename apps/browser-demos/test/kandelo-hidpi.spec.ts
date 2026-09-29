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

const syslog = (page: Page) => page.evaluate(() => document.body.innerText);

/**
 * The DRM mode is sized in device pixels, so a dpr-2 pane gets a mode twice
 * the CSS box. Nothing in that mode tells the compositor which of the two it
 * is looking at, so the page passes WLC_SCALE and the compositor divides the
 * mode by it to get the logical grid clients lay out in. Get either half
 * wrong and the desktop is silently rendered at the wrong resolution: the
 * aspect-derived mode this replaced pinned every pane to 1080 lines, which
 * upscaled a Retina desktop and is invisible at dpr 1 — so this file runs at
 * dpr 2 on purpose.
 */
test.use({ deviceScaleFactor: 2 });

test("the desktop renders at the pane's device resolution on a dpr-2 display", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=omarchy");
  await page.getByText("Internals", { exact: true }).first().click();
  await expect.poll(() => syslog(page), { timeout: 180_000 })
    .toMatch(/omarchy desktop ready/);

  const sizes = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(
      ".kmachine-primary-slot:not(.is-hidden) canvas",
    );
    const rect = c!.getBoundingClientRect();
    return {
      dpr: window.devicePixelRatio,
      cssW: Math.round(rect.width),
      cssH: Math.round(rect.height),
      bufW: c!.width,
      bufH: c!.height,
    };
  });

  expect(sizes.dpr, "this spec is meaningless at dpr 1").toBe(2);

  // The scanout is the pane's device-pixel box, not a fixed 1080 lines. Even
  // alignment and the [640,3840]x[480,2160] clamp are the only slack.
  expect(sizes.bufW, "scanout width is not the pane's device width")
    .toBe(Math.min(3840, Math.max(640, (sizes.cssW * 2) & ~1)));
  expect(sizes.bufH, "scanout height is not the pane's device height")
    .toBe(Math.min(2160, Math.max(480, (sizes.cssH * 2) & ~1)));

  const text = await syslog(page);

  // The compositor took the scale, and its logical grid is the mode halved —
  // so a client still lays out against roughly the CSS box, not the device one.
  expect(text, "compositor did not take the output scale").toMatch(/WLC_SCALE 2/);
  const up = text.match(/COMPOSITOR_UP w=(\d+) h=(\d+)/);
  expect(up, "compositor never reported its logical grid").not.toBeNull();
  expect(Number(up![1])).toBe(sizes.bufW / 2);
  expect(Number(up![2])).toBe(sizes.bufH / 2);

  // The wallpaper is staged at the source's own resolution, not the fixed
  // 960x540 the compositor used to magnify past 2x on a HiDPI pane. It keeps
  // the asset's aspect rather than the mode's, because the compositor
  // centre-crops: the stager bakes the image into the VFS before the mode
  // exists and so cannot match it.
  const wallpaper = text.match(/WALLPAPER image w=(\d+) h=(\d+)/);
  expect(wallpaper, "the compositor never loaded an image wallpaper").not.toBeNull();
  const wallpaperW = Number(wallpaper![1]);
  const wallpaperH = Number(wallpaper![2]);
  expect({ w: wallpaperW, h: wallpaperH },
    "the wallpaper is not staged at the boot theme's own resolution")
    .toEqual({ w: 2580, h: 1080 });

  // The bar is laid out in logical units, so its exclusive zone must not
  // shrink with the scale — that shrinking is what made it unreadable.
  await expect.poll(() => syslog(page), { timeout: 120_000 })
    .toMatch(/LAYER ns=waybar layer=2 x=0 y=0 w=\d+ h=\d+/);
  const layer = (await syslog(page)).match(/LAYER ns=waybar layer=2 x=0 y=0 w=(\d+) h=(\d+)/);
  expect(Number(layer![1]), "the bar does not span the logical width")
    .toBe(sizes.bufW / 2);
  expect(Number(layer![2]), "the bar is not its configured logical height").toBe(26);

  // A theme switch raises a mako toast, and a toast makes its scale decision
  // once: mako sizes its buffer from the scale of the output wl_surface.enter
  // names, before it draws. So the compositor sends the enter when the surface
  // takes its layer-shell role. Sent at map, the first frame is already drawn
  // at scale 1 — the toast reads soft while the desktop around it is sharp.
  await page.getByText("Demo", { exact: true }).first().click();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("Space");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await page.getByText("Internals", { exact: true }).first().click();
  await expect.poll(() => syslog(page), { timeout: 60_000 })
    .toMatch(/BUFFER_SCALE app=notifications scale=2 /);
  expect(await syslog(page), "the toast drew a frame at scale 1 before that")
    .not.toMatch(/BUFFER_SCALE app=notifications scale=1 /);
});
