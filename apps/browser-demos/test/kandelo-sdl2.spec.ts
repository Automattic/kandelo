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

async function terminalText(page: Page): Promise<string> {
  const count = await page.locator(".xterm-rows").count();
  if (count === 0) return "";
  return page.locator(".xterm-rows").first().evaluate((n) => n.textContent ?? "");
}

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

test("Kandelo sdl2 demo (Phase 4: editor left + plasma right, ESC-quits)", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=sdl2");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 90_000 })
    .toMatch(/running sdl2/);

  await openSurface(page, "Demo");
  const canvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  /* Wait for the app's FIRST presented frame before sampling anything.
   * "running sdl2" only means the process launched: between that and
   * the first drmModePageFlip sit EGL/WebGL2 context creation, shader
   * compiles, the text-atlas bake, and the sound-shader tile
   * prerender + readback — under CI's software GL (SwiftShader) that
   * init can outlast the whole sampling window, so sampling
   * immediately just screenshots the Modeset pane's static
   * "waiting for PAGE_FLIP" placeholder and fails as "not animating".
   * The pane unmounts the placeholder exactly when the KMS stats SAB
   * reports the first flip. */
  await expect(
    page.getByText(/Waiting for a process to drmModePageFlip/),
  ).toBeHidden({ timeout: 90_000 });

  /* The Modeset pane uses transferControlToOffscreen (see
   * apps/browser-demos/pages/kandelo/panes/Modeset.tsx), which makes
   * in-page drawImage(canvas, 0, 0) + getImageData unreliable on the
   * placeholder canvas, and canvas.screenshot() returns the CSS
   * bounding box (including letterbox background) at a size that
   * differs from the canvas backing buffer. Use PNG byteLength
   * variance instead:
   *   - Full-frame: an animating plasma on the right pane compresses
   *     to different sizes across frames; a static (or blank) canvas
   *     does not.
   *   - Left-half clip: text glyph rendering produces a much larger
   *     PNG than a flat-gray clear. If the editor never drew, the
   *     left half compresses to ~1-2 KB; with text it lands well
   *     above 3 KB even with cursor blink off. */
  const fullSizes: number[] = [];
  const leftSizes: number[] = [];
  const bb = await canvas.boundingBox();
  if (!bb) throw new Error("canvas bounding box unavailable");
  const leftClip = {
    x: bb.x,
    y: bb.y,
    width: Math.floor(bb.width / 2),
    height: bb.height,
  };
  /* Sample until byte-size variance appears instead of a fixed
   * 6×500 ms schedule: under software GL the app may present only a
   * few frames per second, so animation evidence needs a deadline,
   * not a fixed sample count. */
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(500);
        const full = await canvas.screenshot();
        const left = await page.screenshot({ clip: leftClip });
        fullSizes.push(full.byteLength);
        leftSizes.push(left.byteLength);
        return Math.max(...fullSizes) - Math.min(...fullSizes);
      },
      { timeout: 30_000, message: "right pane not animating (no PNG byte-size variance within 30 s)" },
    )
    .toBeGreaterThan(400);
  for (const sz of fullSizes) {
    expect(
      sz,
      `canvas frame too small (blank?); fullSizes=${fullSizes.join(",")}`,
    ).toBeGreaterThan(3_500);
  }
  /* Left half should be much bigger than a flat-gray PNG because
   * Inconsolata glyphs add high-frequency detail. A flat-color
   * rectangle of this size compresses to a few hundred bytes; with
   * baked text we expect >3 KB consistently. */
  for (const sz of leftSizes) {
    expect(
      sz,
      `left pane has no editor content; leftSizes=${leftSizes.join(",")}`,
    ).toBeGreaterThan(3_000);
  }

  /* ESC is the only exit path. Click body to take focus off the
   * canvas, then dispatch Escape to BrowserInputSource → SDL_evdev. */
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 30_000 })
    .toMatch(/sdl2 exited/);
  expect(await syslogText(page), "sdl2 reported failure")
    .not.toMatch(/sdl2 failed/);

  await openSurface(page, "Terminal");
  await expect
    .poll(() => terminalText(page), { timeout: 30_000 })
    .toMatch(/sdl2: OK frames=\d+ elapsed=\d+ ms exit=esc/);
});
