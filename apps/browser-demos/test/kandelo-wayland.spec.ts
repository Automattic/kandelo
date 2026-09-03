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
  const btn = page.locator("button.kdock-item", { hasText: label });
  await btn.waitFor({ state: "visible", timeout: 30_000 });
  await btn.click();
}

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

/**
 * The syslog message stream re-joined for marker matching. Process stdout
 * reaches the syslog in arbitrary chunks, so a single printf marker can
 * split across two .ksys-line entries (observed: `MOVE_GRAB "wlclock` +
 * `"`). Each line renders as `[timestamp]LEVEL message`, so joining whole
 * lines would interleave the next line's prefix into the marker — join
 * only the .ksys-msg spans.
 */
async function syslogStream(page: Page): Promise<string> {
  const msgs = await page.locator(".ksys-line .ksys-msg").allInnerTexts();
  return msgs.join("");
}

const SETUP_FAILURE =
  /wayland failed|wlcompositor failed|wlclock failed|wlpaint failed/;

// The compositor's desktop geometry (wlcompositor.c placement_rules;
// libkwl adds a 28 px CSD titlebar):
//   wlterm:  slot (90,120)     (left-anchored)
//   wlclock: slot (W-680,110)  (right-anchored)
//   wlpaint: slot (W-840,560)  (right-anchored)
// The mode IS the pane's device-pixel box (kms-registry buildVirtualConnectorMode,
// even-aligned, clamped [640,3840]×[480,2160]); the logical grid clients lay
// out in is that mode divided by WLC_SCALE. This demo runs at dpr 1, so the
// grid is roughly the pane's CSS box — around 1280×612, not the 1920×1080 the
// slots above were written for. Two consequences every coordinate here has to
// respect: libkwl's kwl_fit_to_output caps each window at half the grid's
// width and three fifths of its height, and place_surface then clamps a slot
// that would fall off the bottom back into the work area. So the windows are
// smaller AND closer together than the slots suggest, and they overlap.
// Nothing below may use an absolute coordinate that assumed 1080 lines.
// The live dims are parsed from the Modeset chip once the first frame lands
// (`readDesktopDims`); these are only pre-parse fallbacks.
let DESKTOP_W = 1920;
let DESKTOP_H = 1080;
// Grip the clock's titlebar 240 px in: wlterm is fitted to half the
// grid's width and maps last, so on a ~1280-wide grid it covers the clock's
// left third and takes the press. 240 clears wlterm and still stops short of
// the close box at the window's right edge. The grab holds this offset for
// the whole drag, so it is also how the drop point predicts the window's
// final origin.
const CLOCK_GRIP_DX = 240;
const CLOCK_GRIP_DY = 14;
const clockTitlebar = () => ({
  x: DESKTOP_W - 680 + CLOCK_GRIP_DX,
  y: 110 + CLOCK_GRIP_DY,
});
// Drop point for the drag, as a fraction of the live grid so it stays on the
// desktop at any mode. A fixed y here falls below a 612-line desktop.
const dragTo = () => ({
  x: Math.round(DESKTOP_W * 0.55),
  y: Math.round(DESKTOP_H * 0.8),
});
// A rect fully inside wlterm's window and clear of wlclock, wlpaint, and the
// animated clock — the only thing that changes pixels here is the terminal
// grid re-rendering. Both far edges are held inside the fitted window: half
// the grid's width less a margin, and well above three fifths of its height.
const wltermRegion = () => ({
  x0: 100,
  y0: 130,
  x1: Math.min(1040, Math.round(DESKTOP_W / 2) - 60),
  y1: Math.min(680, Math.round(DESKTOP_H * 0.7)),
});

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

/** Full text of the Modeset dock status chip ("" while mounting). */
async function chipText(page: Page): Promise<string> {
  const texts = await page
    .locator(".kdemo-surface-controls")
    .filter({ hasText: "flips" })
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.join(" ");
}

/** Current PAGE_FLIP count from the Modeset pane's status chip. */
async function flipCount(page: Page): Promise<number> {
  const m = (await chipText(page)).match(/(\d+)\s*flips/i);
  return m ? Number(m[1]) : -1;
}

/**
 * Map a desktop (card0 framebuffer) coordinate to page coordinates inside
 * the Modeset canvas. The canvas renders with `object-fit: contain` and
 * the pane's `toCanvasCoords` (Modeset.tsx) maps pointers through the
 * fitted (letterboxed) content box — this is its inverse.
 */
async function desktopPoint(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const box = await canvasLocator(page).boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  const scale = Math.min(box.width / DESKTOP_W, box.height / DESKTOP_H);
  const offX = box.x + (box.width - DESKTOP_W * scale) / 2;
  const offY = box.y + (box.height - DESKTOP_H * scale) / 2;
  return { x: offX + x * scale, y: offY + y * scale };
}

/** Screenshot just wlterm's window region (page-space clip of the canvas). */
async function wltermRegionShot(page: Page): Promise<Buffer> {
  const region = wltermRegion();
  const tl = await desktopPoint(page, region.x0, region.y0);
  const br = await desktopPoint(page, region.x1, region.y1);
  return page.screenshot({
    clip: { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y },
  });
}

/** Parse the live desktop mode from the Modeset chip ("W×H · N flips …")
 *  and latch it into DESKTOP_W/H for all geometry helpers. The mode is
 *  fixed for the desktop's lifetime once the compositor boots. */
async function readDesktopDims(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const m = (await chipText(page)).match(/(\d+)×(\d+)/);
      if (m) {
        DESKTOP_W = Number(m[1]);
        DESKTOP_H = Number(m[2]);
      }
      return m ? `${DESKTOP_W}x${DESKTOP_H}` : null;
    }, { timeout: 60_000 })
    .not.toBeNull();
}

/**
 * End-to-end browser gate for the Wayland desktop demo. Drives the whole
 * chain in a real browser: wlcompositor (a wl_shm/xdg_shell floating-window
 * server on /dev/dri/card0 via KMS) composites THREE concurrent clients —
 * wlclock (animated analog clock), wlpaint (pointer painting), and wlterm
 * (libkwl VT100 terminal running a forkpty'd dash) — with the Modeset pane
 * bridging card0 → an OffscreenCanvas presented through the vblank pump's
 * WebGL2 scanout presenter (texture upload + shader swizzle + GPU scaling),
 * BrowserInputSource feeding keystrokes into the compositor's libinput, and
 * the pane's pointer bridge feeding mouse events into event1.
 *
 * Gates:
 *   1. All three clients connected (syslog CLIENT_CONNECTED count=3 — the
 *      compositor's stdout lands in the Internals syslog) and the composited
 *      desktop is on the canvas: wallpaper + three windows compress to a PNG
 *      far larger than a blank frame (v1's gate passed on an all-black
 *      ~3.2 KB canvas; a real desktop run measures ~21.5 KB). The Modeset
 *      chip must also report the `webgl2` renderer (stats slot 7) so a
 *      silent fallback to the legacy 2D blit fails the gate. In between,
 *      gate 1d asserts the compositor composites on the GPU (WLC_RENDERER
 *      gpu from the boot-time GLES probe) and gate 1e asserts the GPU
 *      path's one-shot readback proof (COMPOSITE_SAMPLE via glReadPixels,
 *      non-black) — the node smokes only ever exercise the CPU path, so
 *      this is the sole gate on that readback.
 *   2. Typing changes wlterm's window region — a keystroke routes
 *      compositor → wl_keyboard → focused wlterm → tty echo → grid redraw →
 *      re-composite. The clip excludes the animated clock, so only a
 *      terminal redraw can change it.
 *   3. A titlebar drag on wlclock moves the window: mouse press on the CSD
 *      bar triggers libkwl's xdg_toplevel.move, the compositor grabs
 *      (MOVE_GRAB "wlclock") and drops the grab on release with the window
 *      relocated (MOVE_END with coordinates near the drop point). Button
 *      edges are spaced >25 ms apart so libinput's debounce treats them as
 *      intentional clicks, not switch bounce. During the drag, the desktop's
 *      top-left corner is sampled per step and must stay pixel-stable —
 *      the pointer bridge sends true EV_ABS coordinates, so no frame may
 *      ever show the grabbed window pegged at (0,0) (regression guard for
 *      the retired EV_REL peg-and-jump emulation).
 *   4. Drag-painting a stroke in wlpaint does not freeze the desktop:
 *      the stroke registers (WLPAINT_STROKE) and the Modeset pane's
 *      PAGE_FLIP counter keeps advancing afterwards (wlclock animates at
 *      ~10 fps). This is the liveness gate for two real regressions —
 *      blocking-poll timeout starvation in the kernel worker and the
 *      kernel's munmap length-rounding address-space leak — both of
 *      which froze the composited desktop right after a paint drag
 *      while every marker-based gate still passed. Node-side twin:
 *      host/test/wldesktop-liveness-smoke.test.ts.
 *   5. No flicker: 120 rapid canvas screenshots and no sample compresses
 *      below 90% of the median PNG size. The 60 Hz presenter pump reads
 *      `currentFb`, which only PAGE_FLIP latching keeps pointed at the
 *      compositor's FRONT buffer; before the kernel latched flips the host
 *      scanned out the SETCRTC-era bo forever — the back buffer every
 *      other frame — so the pump caught frames mid-composite (windows
 *      missing) and the desktop visibly flashed. A windowless frame
 *      compresses ~30% smaller (measured on the 2d blit: 15.2 KB vs
 *      22.2 KB median, ~3/120 samples on the pre-fix kernel; the same
 *      separation holds under the WebGL2 presenter since the missing
 *      windows dominate the size delta), while legit clock-animation
 *      variance stays within ~3% — so the 90% cut cleanly separates them.
 *
 * Skips (via gotoOrSkip) when the binaries aren't built — Vite fails the
 * `?url` import and shows an error overlay.
 */
test("Kandelo wayland desktop composites three clients, routes typing and window drags", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=wayland");

  // The desktop boot is heavy (four wasm programs + a forkpty'd shell);
  // wait for the live-setup tick that fires once wlterm is launched.
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running wlterm/);
  expect(await syslogText(page), "wayland setup reported failure")
    .not.toMatch(SETUP_FAILURE);

  // Gate 1a: all three clients connected to the compositor.
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/CLIENT_CONNECTED count=3/);

  // Gate 1d: the compositor composites on the GPU. wlcompositor probes
  // the renderD128 GLES bridge at boot (shader compile via sync queries)
  // and prints WLC_RENDERER before COMPOSITOR_UP; under new-headless
  // Chromium WebGL2 is available in the worker, so anything but "gpu"
  // means the probe or the WPK dmabuf-texture path regressed. Checked
  // while the Internals surface (syslog pane) is still mounted.
  expect(await syslogStream(page)).toMatch(/WLC_RENDERER gpu/);

  // Gate 1e: the GPU path's one-shot proof that client pixels crossed the
  // process boundary — repaint_gl() samples the composited GL framebuffer
  // back through glReadPixels (the sync-query path) at (top->x+10,
  // top->y+10), inside the topmost window's titlebar, so a black pixel
  // means the readback or the dmabuf-texture import silently failed. The
  // node smokes only ever see the CPU path; this is the sole gate on the
  // GL readback.
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x[0-9a-f]{8}/);
  const gpuSample = (await syslogStream(page)).match(
    /COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/,
  )!;
  expect(parseInt(gpuSample[1], 16) & 0xffffff, "GL readback sampled black")
    .not.toBe(0);

  // The KMS/Modeset pane bridges card0 to an OffscreenCanvas.
  await openSurface(page, "Demo");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // Latch the live desktop mode — the pane's device-pixel box — before any
  // geometry-dependent gate; window anchors and the letterbox math all
  // derive from it.
  await readDesktopDims(page);

  // Gate 1b: the full desktop composited. The Modeset pane uses
  // transferControlToOffscreen, so PNG byteLength stands in for pixel
  // readback. Reference sizes from real runs on a ~1280×612 mode: all-black
  // frame ≈ 3.2 KB, wallpaper + three windows ≈ 21 KB under the WebGL2
  // scanout presenter. The threshold sits between the two, low enough that a
  // wider pane (a bigger mode compresses to more bytes, not fewer) cannot
  // reach it from the blank side.
  await expect
    .poll(
      async () => (await canvas.screenshot()).byteLength,
      { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(12_000);

  // Gate 1c: the canvas is painted by a WebGL2 renderer — the scanout
  // presenter (chip "webgl2") or, once the compositor claims the canvas
  // for GPU compositing, its own GL context (chip "webgl2-gl"). Guards
  // against a silent fallback to the legacy 2D putImageData blit or the
  // pump failing to acquire WebGL2 and going stats-only. The chip
  // renders text-transform:uppercase, so match loosely.
  await expect
    .poll(() => chipText(page), { timeout: 30_000 })
    .toMatch(/webgl2/i);

  // Gate 2: type on the keyboard. Focus the page off the canvas placeholder
  // first (BrowserInputSource listens on window), then type a line. wlterm
  // maps last so it holds keyboard focus; the tty echoes into the grid and
  // dash runs `echo`, so wlterm's window region — clipped clear of the
  // animated clock — must change.
  const preTyping = await wltermRegionShot(page);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type("echo wlterm-browser-ok\n", { delay: 40 });

  await expect
    .poll(
      async () => (await wltermRegionShot(page)).equals(preTyping),
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(false);

  // Gate 3: drag wlclock by its titlebar. Press on the CSD bar (clear of
  // the close box on the right edge), drag left+down, release. libkwl
  // requests xdg_toplevel.move on the press; the compositor grabs and the
  // window tracks the cursor until release. The syslog pane only renders
  // on the Internals surface, so run the whole gesture on Demo first and
  // assert the compositor's grab markers afterwards.
  const titlebar = clockTitlebar();
  const drop = dragTo();
  const from = await desktopPoint(page, titlebar.x, titlebar.y);
  const to = await desktopPoint(page, drop.x, drop.y);
  await page.mouse.move(from.x, from.y);
  await page.waitForTimeout(60);
  await page.mouse.down();
  await page.waitForTimeout(250);
  // Teleport guard: the browser bridge sends true EV_ABS moves, so the
  // pointer must never pass through (0,0). A regression to the retired
  // EV_REL peg-and-jump emulation would flash the grabbed window in the
  // top-left corner between repaints. Sample that corner between drag
  // steps — it must stay pixel-stable
  // (reference AFTER mouse.down: pressing wlclock legitimately removes
  // wlterm's focus border, which lives inside the region).
  const cTl = await desktopPoint(page, 0, 0);
  const cBr = await desktopPoint(page, 340, 390);
  const cornerShot = () =>
    page.screenshot({
      clip: {
        x: cTl.x,
        y: cTl.y,
        width: cBr.x - cTl.x,
        height: cBr.y - cTl.y,
      },
    });
  const cornerRef = await cornerShot();
  const DRAG_STEPS = 12;
  for (let i = 1; i <= DRAG_STEPS; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / DRAG_STEPS,
      from.y + ((to.y - from.y) * i) / DRAG_STEPS,
    );
    expect(
      (await cornerShot()).equals(cornerRef),
      `drag step ${i}: top-left corner changed — move-grabbed window teleported`,
    ).toBe(true);
  }
  await page.waitForTimeout(120);
  await page.mouse.up();

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 30_000 })
    .toMatch(/MOVE_GRAB "wlclock"/);
  await expect
    .poll(() => syslogStream(page), { timeout: 30_000 })
    .toMatch(/MOVE_END "wlclock" x=-?\d+ y=-?\d+/);
  const moved = (await syslogStream(page)).match(
    /MOVE_END "wlclock" x=(-?\d+) y=(-?\d+)/,
  )!;
  // The grab holds the window at a fixed offset from the cursor, so the
  // window's origin lands at the drop point less the grip — at any mode.
  // Assert that, not a fixed coordinate, which only holds at one mode.
  // The slack absorbs the desktop→page→pointer rounding on either side.
  const DROP_SLACK = 8;
  expect(Math.abs(Number(moved[1]) - (drop.x - CLOCK_GRIP_DX)),
         "the window did not follow the cursor in x")
    .toBeLessThanOrEqual(DROP_SLACK);
  expect(Math.abs(Number(moved[2]) - (drop.y - CLOCK_GRIP_DY)),
         "the window did not follow the cursor in y")
    .toBeLessThanOrEqual(DROP_SLACK);

  // Gate 4: drag-paint a stroke in wlpaint, then prove the desktop is
  // still alive. wlpaint is right-anchored at (W-840, 560), but on a grid
  // shorter than 1080 lines place_surface pulls that slot up to sit the
  // fitted window in the work area — so the canvas is found relative to the
  // window's bottom edge (16 px from the desktop's), not to slot 560.
  // Stroke the RIGHT of that canvas: the windows overlap on a
  // narrow grid, and wlterm (fitted to half the width, from x=90) and the
  // just-dragged wlclock both sit above wlpaint in the z-order. Only past
  // their right edges does a press reach wlpaint at all.
  await openSurface(page, "Demo");
  const paintX = DESKTOP_W - 840;
  const paintBottom = DESKTOP_H - 16;
  const pFrom = await desktopPoint(page, paintX + 400, paintBottom - 240);
  const pTo = await desktopPoint(page, paintX + 480, paintBottom - 40);
  await page.mouse.move(pFrom.x, pFrom.y);
  await page.waitForTimeout(60);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.move(pTo.x, pTo.y, { steps: 25 });
  await page.waitForTimeout(120);
  await page.mouse.up();

  // Liveness: wlclock redraws ~10×/s, so flips must keep advancing for
  // several consecutive windows after the stroke. A frozen compositor
  // pins the counter (the pre-fix failure modes froze it right here).
  for (let window = 1; window <= 2; window++) {
    const f0 = await flipCount(page);
    await page.waitForTimeout(2_000);
    const f1 = await flipCount(page);
    expect(f1, `desktop frozen after paint drag (window ${window})`)
      .toBeGreaterThan(f0);
  }

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 15_000 })
    .toMatch(/WLPAINT_STROKE x=\d+ y=\d+/);

  // Gate 5: flicker stability. Screenshot the whole canvas 120 times
  // back-to-back and assert no frame compresses below 90% of the median
  // PNG size. A frame the pump blitted mid-composite (the PAGE_FLIP
  // scanout-latch regression) is missing windows and compresses ~30%
  // smaller; legit clock-animation variance stays within ~3%.
  await openSurface(page, "Demo");
  const flickerSizes: number[] = [];
  for (let i = 0; i < 120; i++) {
    flickerSizes.push((await canvas.screenshot()).byteLength);
  }
  const flickerSorted = [...flickerSizes].sort((a, b) => a - b);
  const flickerMedian = flickerSorted[flickerSorted.length >> 1];
  const dropouts = flickerSizes.filter((s) => s < flickerMedian * 0.9);
  expect(
    dropouts,
    `desktop flicker: ${dropouts.length}/120 frames compressed <90% of ` +
      `median ${flickerMedian} B — pump blitting a mid-composite back buffer`,
  ).toHaveLength(0);

  await openSurface(page, "Internals");
  expect(await syslogText(page), "wayland reported failure after input")
    .not.toMatch(SETUP_FAILURE);
});
