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

/** The syslog message spans re-joined for marker matching — a single
 *  printf marker can split across two .ksys-line entries, so join only
 *  the .ksys-msg spans (see kandelo-wayland.spec.ts for the rationale). */
async function syslogStream(page: Page): Promise<string> {
  const msgs = await page.locator(".ksys-line .ksys-msg").allInnerTexts();
  return msgs.join("");
}

const SETUP_FAILURE = /sdl2gl failed|wlcompositor failed/;

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

/**
 * Browser gate for the SDL2-on-Wayland (GL) demo: wlcompositor composites
 * a single client, sdl2gl-test, which renders a spinning GLES2 triangle
 * over a teal clear through SDL2's UPSTREAM Wayland+GLES backend. This is
 * the runtime proof of the step-10/11/12 chain driven by a third-party
 * toolkit: SDL's wl_egl_window is our GPU-bo/dmabuf shim, libEGL targets
 * the bo's FBO, and eglSwapBuffers attach+commits it zero-copy to the
 * compositor. The whole path is WebGL2-only, so this runs only in the
 * browser (Node vitest cannot gate it).
 *
 * Gates:
 *   1. The SDL client came up on the Wayland backend (SDL2GL_UP
 *      driver=wayland) and connected to the compositor (CLIENT_CONNECTED
 *      count=1). A silent fall-through to the dummy video driver, or a
 *      link/EGL failure, fails here.
 *   2. The compositor composites on the GPU (WLC_RENDERER gpu) and its
 *      one-shot readback proof (COMPOSITE_SAMPLE via glReadPixels, sampled
 *      near the SDL window's top-left) is non-black — i.e. the SDL client's
 *      GL pixels crossed the process boundary as a dmabuf-imported texture.
 *   3. The composited desktop is on the canvas: the frame compresses to a
 *      PNG far larger than a blank one (a solid-black frame is ~3 KB; a
 *      teal window + triangle over the wallpaper is much larger).
 *   4. Liveness: the SDL client keeps swapping frames (SDL2GL_FRAME count
 *      advances), so the single-buffer present loop isn't wedged.
 *
 * Skips (via gotoOrSkip) when the binaries aren't built — Vite fails the
 * `?url` import and shows an error overlay.
 */
test("Kandelo SDL2-on-Wayland GL client composites through wlcompositor", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=sdl2gl");

  // Boot is heavy (compositor + SDL2 client). Watch the syslog for the
  // client's own up-marker on the Wayland backend.
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 180_000 })
    .toMatch(/SDL2GL_UP driver=wayland/);
  expect(await syslogText(page), "sdl2gl setup reported failure")
    .not.toMatch(SETUP_FAILURE);

  // Gate 1: the client connected to the compositor.
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/CLIENT_CONNECTED count=1/);

  // Gate 2a: GPU compositing path selected.
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/WLC_RENDERER gpu/);

  // Gate 2b: the GL readback proof — the SDL client's pixels reached the
  // composited framebuffer (non-black near the window's top-left = the
  // teal clear). This is the sole gate on the zero-copy dmabuf import for
  // the SDL path; the node smokes never exercise the GL readback.
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x[0-9a-f]{8}/);
  const sample = (await syslogStream(page)).match(
    /COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/,
  )!;
  expect(parseInt(sample[1], 16) & 0xffffff, "GL readback sampled black")
    .not.toBe(0);

  // Gate 3: the composited frame is on the pane canvas.
  await openSurface(page, "Demo");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => (await canvas.screenshot()).byteLength,
      { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(12_000);

  // Gate 4: liveness — the SDL client keeps presenting frames. The client
  // prints SDL2GL_FRAME every 30 frames (~1 s at 30 fps); the count must
  // keep climbing, proving the single reusable buffer isn't wedged.
  await openSurface(page, "Internals");
  const frameCount = async () => {
    const nums = [...(await syslogStream(page)).matchAll(/SDL2GL_FRAME (\d+)/g)]
      .map((m) => Number(m[1]));
    return nums.length ? nums[nums.length - 1] : -1;
  };
  const f0 = await frameCount();
  await expect
    .poll(frameCount, { timeout: 30_000, intervals: [1_000, 2_000] })
    .toBeGreaterThan(f0);

  expect(await syslogText(page), "sdl2gl reported failure while running")
    .not.toMatch(SETUP_FAILURE);
});
