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

// A printf marker can split across two .ksys-line entries, so join only the
// .ksys-msg spans — otherwise the next line's `[timestamp]LEVEL` prefix
// interleaves into the marker and the regex misses.
async function syslogStream(page: Page): Promise<string> {
  const msgs = await page.locator(".ksys-line .ksys-msg").allInnerTexts();
  return msgs.join("");
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

const SETUP_FAILURE =
  /hyprland failed|wlcompositor failed|wlclock failed|wlterm failed/;

/**
 * End-to-end browser gate for the `/?demo=hyprland` tiling desktop:
 * wlcompositor (WLC_LAYOUT=dwindle) composites three clients — a wlclock and
 * two wlterm terminals — into gapped, server-side-decorated tiles, with each
 * client resizing to fill its tile. Skips (via gotoOrSkip) when the binaries
 * aren't built — Vite fails the `?url` import and shows an error overlay.
 */
test("Kandelo hyprland tiles three clients, resizes them into tiles, and honors CTRL keybinds", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=hyprland");

  // Boot is heavy (three wasm programs + a forkpty'd shell); wait for the tick
  // that fires once the foreground wlterm launches, then check for failure.
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running wlterm/);
  expect(await syslogText(page), "hyprland setup reported failure")
    .not.toMatch(SETUP_FAILURE);

  // Gate 1: dwindle layout + the staged Hyprland keybind config loaded.
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/WLC_LAYOUT dwindle/);
  expect(await syslogStream(page), "compositor did not load the staged config")
    .toMatch(/BINDS_LOADED n=\d+ source=\/etc\/kandelo\/wlcompositor\.conf/);

  // Gate 2: all three clients connected and the dwindle tiler placed all
  // three tiles. The third map produces `TILE n=3 i=0..2` markers.
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/CLIENT_CONNECTED count=3/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/TILE n=3 i=2 /);

  // Gate 3: the clients honored their dictated tile size. This is the demo's
  // crux — the compositor sends xdg configure(w,h) on retile, and the
  // libkwl/vt100 clients rebuild their buffers to match (floating clients in
  // /?demo=wayland never resize, so these markers are unique to tiling).
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/WLCLOCK_RESIZE w=\d+ h=\d+/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/WLTERM_RESIZE cols=\d+ rows=\d+/);

  // Gate 4: the tiled desktop composited to the canvas. The Modeset pane
  // uses transferControlToOffscreen, so PNG byteLength stands in for pixel
  // readback — a blank frame is ~3 KB; wallpaper + three tiled windows is
  // far larger.
  await openSurface(page, "Demo");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => (await canvas.screenshot()).byteLength,
      { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(12_000);

  // Gate 5: CTRL keybinds reach the compositor. A real browser reserves SUPER
  // (=Cmd/Win), so the demo binds every action on CTRL too — that's the path
  // users actually press. Exercise both a named key and a digit, since they
  // resolve differently (a letter/named keysym is case-folded to match the
  // base-level keysym; a digit isn't). Focus off the canvas placeholder first
  // (BrowserInputSource listens on window).
  await page.locator("body").click({ position: { x: 5, y: 5 } });

  // CTRL+Return execs a fourth client (`bind = CTRL, Return, exec, wlterm`) —
  // the exact combo a user presses to spawn a terminal.
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/CLIENT_CONNECTED count=4/);

  // CTRL+2 switches workspace (`bind = CTRL, 2, workspace, 2`).
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  await page.keyboard.press("2");
  await page.keyboard.up("Control");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 30_000 })
    .toMatch(/WORKSPACE active=2/);

  expect(await syslogText(page), "hyprland reported failure after input")
    .not.toMatch(SETUP_FAILURE);
});
