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

async function openSurface(page: Page, label: string) {
  const btn = page.locator("button.kmachine-switch-btn", { hasText: label });
  await btn.waitFor({ state: "visible", timeout: 30_000 });
  await btn.click();
}

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

/**
 * End-to-end browser gate for the Wayland stack (PR7 Phase 4). Drives the
 * whole chain in a real browser: wlcompositor (a wl_shm/xdg_shell server on
 * /dev/dri/card0 via KMS) composites wlterm (a libkwl VT100 terminal) running
 * a forkpty'd dash, with the Modeset pane bridging card0 → an OffscreenCanvas
 * and BrowserInputSource feeding keystrokes into the compositor's libinput.
 *
 * Two gates, mirroring kandelo-modeset/sdl2:
 *   1. The compositor presented a non-blank frame — its PAGE_FLIPs reach the
 *      canvas (byteLength above a blank-frame floor), proving the client
 *      buffer was imported + composited to card0.
 *   2. Typing on the keyboard changes the frame — a keystroke routes
 *      compositor → wl_keyboard → wlterm → the grid (at minimum the tty echo)
 *      → a re-composite. The byteLength spread proves the full input loop.
 *
 * Skips (via gotoOrSkip) when the binaries aren't built — Vite fails the
 * `?url` import and shows an error overlay.
 */
test("Kandelo wayland demo composites wlterm and routes typed input", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=wayland");

  // The compositor + terminal boot is heavy (two wasm programs + a forkpty'd
  // shell); wait for the live-setup tick that fires once wlterm is launched.
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running wlterm/);
  expect(await syslogText(page), "wayland setup reported failure")
    .not.toMatch(/wayland failed|wlcompositor failed/);

  // The KMS/Modeset pane bridges card0 to an OffscreenCanvas.
  await openSurface(page, "Demo");
  const canvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // Gate 1: the compositor composited the terminal window onto card0. As in
  // the sdl2 spec, the Modeset pane uses transferControlToOffscreen, so we
  // use PNG byteLength (not pixel readback) — a composited frame with a
  // terminal window compresses well above a blank/letterbox frame.
  let baseline = 0;
  await expect
    .poll(
      async () => {
        baseline = (await canvas.screenshot()).byteLength;
        return baseline;
      },
      { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(2_000);

  // Gate 2: type on the keyboard. Focus the page off the canvas placeholder
  // first (BrowserInputSource listens on window), then type a line. The tty
  // echoes the characters into the grid and dash runs `echo`, so the grid —
  // and therefore the composited frame — changes. Poll for a frame whose
  // byteLength differs from the baseline by a clear margin.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type("echo wlterm-browser-ok\n", { delay: 40 });

  await expect
    .poll(
      async () => {
        const sz = (await canvas.screenshot()).byteLength;
        return Math.abs(sz - baseline);
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBeGreaterThan(300);

  expect(await syslogText(page), "wayland reported failure after input")
    .not.toMatch(/wayland failed|wlcompositor failed/);
});
