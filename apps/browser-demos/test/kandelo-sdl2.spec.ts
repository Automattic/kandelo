import { expect, test, type Page } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

async function openInternals(page: Page) {
  const internals = page.getByRole("button", { name: "Internals" });
  if ((await internals.getAttribute("aria-pressed")) !== "true") {
    await internals.click();
  }
}

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

async function terminalText(page: Page): Promise<string> {
  const count = await page.locator(".xterm-rows").count();
  if (count === 0) return "";
  return page.locator(".xterm-rows").first().evaluate((n) => n.textContent ?? "");
}

test("Kandelo sdl2 demo (editor left + shader right, ESC quits)", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoMachineOrSkip(page, "sdl2");

  await openInternals(page);
  await expect
    .poll(() => syslogText(page), { timeout: 90_000 })
    // The image's `init.shellCommand` is what launches this machine's
    // program now, so the host logs the command it ran rather than an
    // app-side demo name.
    .toMatch(/running \/usr\/local\/bin\/sdl2/);

  const canvas = page.locator(".kmodeset-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  /* Wait for the app's FIRST presented frame before sampling anything.
   * "running /usr/local/bin/sdl2" only means the process launched: between that and
   * the first drmModePageFlip sit EGL/WebGL2 context creation, shader
   * compiles, the text-atlas bake, and the sound-shader tile
   * prerender + readback — under CI's software GL (SwiftShader) that
   * init can outlast the whole sampling window, so sampling
   * immediately just screenshots the Modeset pane's static
   * "waiting for PAGE_FLIP" placeholder and fails as "not animating".
   * The pane unmounts the placeholder exactly when the KMS stats SAB
   * reports the first flip. */
  await expect(
    page.getByText(/Waiting for PAGE_FLIP on CRTC/),
  ).toBeHidden({ timeout: 90_000 });

  /* The Modeset pane uses transferControlToOffscreen (see
   * apps/browser-demos/pages/kandelo/panes/Modeset.tsx), which makes
   * in-page drawImage(canvas, 0, 0) + getImageData unreliable on the
   * placeholder canvas, and canvas.screenshot() returns the CSS
   * bounding box (including letterbox background) at a size that
   * differs from the canvas backing buffer. Use PNG byteLength
   * variance instead:
   *   - Full-frame: an animating shader on the right pane compresses
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

  /* ESC exits through the ordinary keyboard source. */
  await canvas.focus();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("button", { name: "Terminal", exact: true }))
    .toHaveAttribute("aria-current", "true", { timeout: 30_000 });
  await expect(canvas).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
    .toBe(true);

  await openInternals(page);
  await expect
    .poll(() => syslogText(page), { timeout: 30_000 })
    .toMatch(/sdl2 exited/);
  expect(await syslogText(page), "sdl2 reported failure")
    .not.toMatch(/sdl2 failed/);

  /* Return from the explicit Internals inspection above. The automatic
   * handoff was already checked before that manual navigation. */
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => terminalText(page), { timeout: 30_000 })
    .toMatch(/sdl2: OK frames=\d+ elapsed=\d+ ms exit=esc/);
});

test("SDL's default cursor uses the shared KMS cursor plane", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "cursor plane acceptance targets Chromium");
  test.setTimeout(180_000);
  await gotoMachineOrSkip(page, "sdl2");
  const canvas = page.locator(".kmodeset-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 90_000 });
  const worker = page.workers().find(worker => /browser-kernel-worker-entry/.test(worker.url()));
  expect(worker).toBeTruthy();
  await worker!.evaluate(() => {
    const proto = OffscreenCanvasRenderingContext2D.prototype;
    const put = proto.putImageData;
    proto.putImageData = function (...args: Parameters<typeof put>) {
      const image = args[0];
      if (image.width <= 64 && image.height <= 64) {
        let opaque = 0;
        for (let i = 3; i < image.data.length; i += 4) if (image.data[i]) opaque++;
        (globalThis as any).__kmsCursorProbe = { x: args[1], y: args[2], opaque };
      }
      return put.apply(this, args);
    };
  });
  const box = (await canvas.boundingBox())!;
  await expect.poll(() => page.getByText(/\d+×\d+ · \d+ flips/).innerText())
    .toMatch(/webgl2-gl/i);
  const status = await page.getByText(/\d+×\d+ · \d+ flips/).innerText();
  const [, width, height] = status.match(/(\d+)×(\d+)/)!;
  for (const point of [{ x: 180, y: 90 }, { x: 320, y: 160 }]) {
    await page.mouse.move(box.x + point.x, box.y + point.y);
    const expected = { x: point.x * Number(width) / box.width,
      y: point.y * Number(height) / box.height };
    await expect.poll(async () => {
      const cursor = await worker!.evaluate(() => (globalThis as any).__kmsCursorProbe);
      return cursor && Math.abs(cursor.x - expected.x) <= 1 && Math.abs(cursor.y - expected.y) <= 1;
    }).toBe(true);
    expect((await worker!.evaluate(() => (globalThis as any).__kmsCursorProbe)).opaque).toBeGreaterThan(20);
  }
  await page.screenshot({ path: "../../.context/sdl-shared-kms-cursor.png", scale: "css", clip: box });
});
