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

// A printf marker can split across two .ksys-line entries, so join only the
// .ksys-msg spans — otherwise the next line's `[timestamp]LEVEL` prefix
// interleaves into the marker and the regex misses.
async function syslogStream(page: Page): Promise<string> {
  const msgs = await page.locator(".ksys-line .ksys-msg").allInnerTexts();
  return msgs.join("");
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

// Press a CTRL combo at the page level. A browser reserves SUPER (Cmd/Win), so
// the demo mirrors every Omarchy bind on CTRL; that is the path a user takes.
async function pressCtrl(page: Page, key: string, shift = false, alt = false) {
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  if (shift) await page.keyboard.down("Shift");
  if (alt) await page.keyboard.down("Alt");
  await page.keyboard.press(key);
  if (alt) await page.keyboard.up("Alt");
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await openSurface(page, "Internals");
}

// How many times the launcher has come up so far. The syslog is cumulative,
// so a later session is only visible as one more marker than before — and a
// key typed before the launcher holds the keyboard goes to the focused
// window, exactly as it would on the real desktop.
async function launcherSessions(page: Page): Promise<number> {
  return (await syslogStream(page)).split(/KLAUNCHER_READY n=\d+/).length - 1;
}

// How many windows of one app the compositor has focused so far. The syslog is
// cumulative, so a second terminal shows up as one more marker. Counting the
// app's own name is what distinguishes a window the demo opened from Waybar's
// second, empty-app_id toplevel, which takes a tile slot of its own.
async function focusedWindows(page: Page, appId: string): Promise<number> {
  return (await syslogStream(page)).split(`KBD_FOCUS app_id=${appId}`).length - 1;
}

// Press bare keys with the Demo surface focused, then return to Internals.
async function pressKeys(page: Page, keys: string[]) {
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (const key of keys) await page.keyboard.press(key);
  await openSurface(page, "Internals");
}

const SETUP_FAILURE =
  /omarchy failed|wlcompositor failed|waybar failed|wlclock failed|wlterm failed|dbus-daemon failed|mako failed/;

/**
 * The O1 gate of docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md:
 * `/?demo=omarchy` boots the tiling compositor with the desktop shell Omarchy
 * is made of — a layer-shell status bar reserving the top strip, a launcher on
 * CTRL+Space, and switchable themes — and every piece is driven from the
 * keyboard. Skips (via gotoOrSkip) when the binaries aren't built.
 */
test("Kandelo omarchy boots a themed tiling desktop with a bar, a launcher, and live theme switching", async ({ page, browserName }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=omarchy");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/omarchy desktop ready/);
  expect(await syslogText(page), "omarchy setup reported failure")
    .not.toMatch(SETUP_FAILURE);

  // Gate 1: the desktop's own config is what drives it — the tiling layout,
  // the staged keybinds, and the theme named in that same file.
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/WLC_LAYOUT dwindle/);
  expect(await syslogStream(page), "compositor did not load the staged config")
    .toMatch(/BINDS_LOADED n=\d+ source=\/etc\/kandelo\/wlcompositor\.conf/);
  expect(await syslogStream(page), "the configured theme was not loaded")
    .toMatch(/THEME tokyo-night/);
  expect(await syslogStream(page), "the theme's image wallpaper was not rendered")
    .toMatch(/WALLPAPER image w=2580 h=1080/);

  // Gate 2: the bar is unmodified Waybar on a real layer-shell surface —
  // anchored across the top, and its hyprland modules attached to the
  // compositor's Hyprland IPC event socket (HYPR_LISTENER).
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/LAYER ns=waybar layer=2 x=0 y=0 w=\d+ h=\d+/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/HYPR_LISTENER slot=\d+/);

  // The desktop boots bare. Assert that before touching the keyboard: the bar
  // has already mapped, which takes longer than a client would, so a client
  // window here is one nobody asked for. Without this the assertions below
  // would pass just as well against a desktop that opens its own.
  expect(await focusedWindows(page, "wlclock"), "the desktop opened a clock on its own").toBe(0);
  expect(await focusedWindows(page, "wlterm"), "the desktop opened a terminal on its own").toBe(0);

  // Open the three clients the way a user does, through the binds the
  // compositor loaded from its own config: CTRL+K for the clock, CTRL+Return
  // for each terminal. Each one is awaited before the next, so a missed key
  // shows up here rather than as a wrong count three gates later.
  await pressCtrl(page, "KeyK");
  await expect
    .poll(() => focusedWindows(page, "wlclock"), { timeout: 60_000 })
    .toBe(1);
  await pressCtrl(page, "Enter");
  await expect
    .poll(() => focusedWindows(page, "wlterm"), { timeout: 60_000 })
    .toBe(1);
  await pressCtrl(page, "Enter");
  await expect
    .poll(() => focusedWindows(page, "wlterm"), { timeout: 60_000 })
    .toBe(2);

  // Gate 3: the windows tile UNDER the bar. Read the log from the bar's LAYER
  // line onward — only the tiles emitted once the bar reserved its strip are
  // the desktop's answer.
  const stream = await syslogStream(page);
  const barLayer = stream.match(/LAYER ns=waybar layer=2 x=0 y=0 w=\d+ h=(\d+)/);
  const barHeight = Number(barLayer![1]);
  expect(barHeight, "waybar reserved no strip").toBeGreaterThan(0);
  const afterBar = stream.split(/LAYER ns=waybar /).pop() ?? "";
  const tiles = [...afterBar.matchAll(
    /TILE n=\d+ i=\d+ x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+)/g)];
  expect(tiles.length, "no tiles emitted after the bar mapped")
    .toBeGreaterThan(0);
  for (const t of tiles)
    expect(Number(t[2]), `a window tiled over the bar: ${t[0]}`)
      .toBeGreaterThanOrEqual(barHeight);
  // The three windows opened above are the only tiles. A surface with no
  // xdg_toplevel role — a client's cursor surface — taking one shifts every
  // count below by one, and the launcher gates then pass on the previous
  // client's tile instead of the one they name.
  expect(afterBar, "a surface with no window role took a tile")
    .not.toMatch(/TILE n=4 /);

  // Gate 4: the desktop composited to the canvas. The Modeset pane uses
  // transferControlToOffscreen, so PNG byteLength stands in for pixel readback
  // — a blank frame is ~3 KB; wallpaper + bar + tiled windows is far larger.
  await openSurface(page, "Demo");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => (await canvas.screenshot()).byteLength,
      { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(12_000);

  // Gate 4b: the desktop keeps compositing on the GPU. Waybar's cursor theme
  // arrives as a buffer packed at a non-zero offset in its pool, which has no
  // GL texture; treating that as a GL failure used to tear the compositor's
  // EGL session down seconds after boot and leave the canvas on its last GL
  // frame — a desktop that looks alive but never repaints again. The pane's
  // badge reads the presenter out of the KMS stats: "webgl2-gl" is the
  // compositor's own context, "webgl2" the pump's CPU-composite fallback.
  await expect(page.locator("text=/flips ·/").first())
    .toContainText(/webgl2-gl/i, { timeout: 30_000 });
  expect(await syslogStream(page), "GPU compositing was torn down")
    .not.toMatch(/GPU compositing failed/);

  // Gate 5: CTRL+Space opens the launcher. It is an overlay layer surface that
  // takes the keyboard away from the focused terminal, so the "t" that follows
  // filters its list instead of being typed into the shell.
  await pressCtrl(page, "Space");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/LAYER ns=launcher layer=3 /);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_READY n=10/);

  // "te" narrows the ten entries (Bash, Clock, Foot, Nano, NetHack, Paint,
  // Quickshell, Terminal, Theme Gallery, Vim) to Terminal alone — "t" alone
  // still matches Paint.
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("KeyT");
  await page.keyboard.press("KeyE");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_FILTER q=te n=1/);

  // Enter launches the one match (Terminal) through the compositor's kwlctl
  // socket and dismisses the launcher. The desktop went in with three tiled
  // windows, so the launched terminal shows up as a fourth tile — the
  // connection count alone would not prove it, since the launcher's own
  // session ends at the same moment and frees its slot.
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Enter");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/wlterm/);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_EXIT/);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/TILE n=4 i=3 /);

  // Gate 5b: a real application through the same path. "vi" narrows to Vim;
  // its entry runs unmodified vim inside a wlterm, fetched lazily from
  // vim.zip on first exec — the fifth tile only appears if the whole chain
  // (launcher → kwlctl exec → wlterm → lazy fetch → vim) held.
  const beforeVim = await launcherSessions(page);
  await pressCtrl(page, "Space");
  await expect
    .poll(() => launcherSessions(page), { timeout: 60_000 })
    .toBeGreaterThan(beforeVim);
  await pressKeys(page, ["KeyV", "KeyI", "Enter"]);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/wlterm \/usr\/bin\/vim/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/TILE n=5 i=4 /);
  expect(await syslogText(page), "vim binary does not match the kernel ABI")
    .not.toMatch(/ABI version mismatch/);

  // Gate 5c: an unmodified upstream client through the same path. "fo"
  // narrows to Foot; its entry runs stock foot 1.17.2 — wl_display_connect
  // via XDG_RUNTIME_DIR, fontconfig resolving "monospace" through the staged
  // fonts.conf, fcft rasterizing the staged Inconsolata — and the sixth tile
  // only appears once foot maps its first frame through all of it.
  const beforeFoot = await launcherSessions(page);
  await pressCtrl(page, "Space");
  await expect
    .poll(() => launcherSessions(page), { timeout: 60_000 })
    .toBeGreaterThan(beforeFoot);
  await pressKeys(page, ["KeyF", "KeyO", "Enter"]);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/foot /);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/TILE n=6 i=5 /);
  expect(await syslogText(page), "foot binary does not match the kernel ABI")
    .not.toMatch(/ABI version mismatch/);
  // GLDRAW is the compositor's proof that it drew this window's texture.
  // Every marker above is protocol — map, focus, tile — and all of them
  // fire for a window whose wl_shm pool the GPU cannot import (a memfd
  // pool instead of a gbm prime fd). foot carries the gbm-pool patch that
  // keeps its pools importable; this is the gate that notices if it stops.
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/GLDRAW app_id=foot/);

  // Gate 5d: a Qt application through the same path. "ga" narrows to Theme
  // Gallery; its entry runs qtgallery — QtGui's wayland QPA plugin connecting
  // via XDG_RUNTIME_DIR, xdg-shell configure, the raster backing store
  // through wl_shm, fontconfig resolving "sans-serif" through the staged
  // fonts.conf — and the seventh tile only appears once Qt maps its first
  // frame. The gallery reads the same six themes the compositor scanned.
  const beforeQt = await launcherSessions(page);
  await pressCtrl(page, "Space");
  await expect
    .poll(() => launcherSessions(page), { timeout: 60_000 })
    .toBeGreaterThan(beforeQt);
  await pressKeys(page, ["KeyG", "KeyA", "Enter"]);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/qtgallery/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/GALLERY_PLATFORM=wayland/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/GALLERY_THEMES n=6/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/TILE n=7 i=6 /);
  expect(await syslogText(page), "qtgallery binary does not match the kernel ABI")
    .not.toMatch(/ABI version mismatch/);
  // The invisible-window gate. Qt's stock backing store allocates memfd
  // pools; the GL renderer cannot import those, skips the surface, and
  // every gate above still passes — that is exactly how the invisible
  // first Qt window shipped. Qt now carries the same gbm-pool patch as
  // foot and GTK, and GLDRAW only fires once the window's texture was drawn.
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/GLDRAW app_id=qtgallery/);
  // The card→dispatch→theme-switch loop is proven authoritatively by the Node
  // smoke (host/test/qtgallery-smoke.test.ts injects a real pointer click on a
  // card and reads the compositor's THEME line back). This browser gate proves
  // the browser-specific half: Qt maps and its texture reaches the GL renderer.

  // Gate 5e: a QtQuick application through the same path. "qu" narrows to
  // Quickshell; its entry runs quickshell with the staged shell.qml. The QML
  // engine loads, the scenegraph renders through the software adaptation
  // (QT_QUICK_BACKEND=software from the compositor's environ), and the
  // PanelWindow maps as a wlr-layer-shell surface under Quickshell's default
  // namespace — layer surfaces never emit GLDRAW, so the LAYER line is the
  // mapping proof. Firefox is excluded: the running desktop's wasm code plus
  // Quickshell's main and pthread modules exceeds SpiderMonkey's fixed 2 GiB
  // per-process executable-code arena, so Quickshell's first QThread::start
  // fails — see docs/browser-support.md#firefox-executable-code-limit.
  if (browserName !== "firefox") {
    const beforeQs = await launcherSessions(page);
    await pressCtrl(page, "Space");
    await expect
      .poll(() => launcherSessions(page), { timeout: 60_000 })
      .toBeGreaterThan(beforeQs);
    await pressKeys(page, ["KeyQ", "KeyU", "Enter"]);
    await expect
      .poll(() => syslogStream(page), { timeout: 60_000 })
      .toMatch(/KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/quickshell/);
    await expect
      .poll(() => syslogStream(page), { timeout: 120_000 })
      .toMatch(/LAYER ns=quickshell /);
  }

  // Gate 6: CTRL+SHIFT+Space cycles the theme. One palette file repaints the
  // whole desktop — the compositor's borders, gaps and wallpaper, and the
  // bar's: the switch runs the `notify =` hook, which reads the new
  // theme.conf, writes the bar's stylesheet from it, and sends Waybar
  // SIGUSR2. The bar answers that from a detached thread blocked on a signal
  // pipe, so "Reloading..." is also the proof that a signal reaches a
  // multi-threaded process.
  await pressCtrl(page, "Space", true);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/THEME (catppuccin|everforest|gruvbox|nord|rose-pine)/);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/THEME_HOOK theme=(catppuccin|everforest|gruvbox|nord|rose-pine) bar=#[0-9a-f]{6} bar_pid=\d+/);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/Reloading\.\.\./);
  // The switch also spawns the configured notifier: notify-send routes a
  // real org.freedesktop.Notifications.Notify over the dbus-daemon session
  // bus, mako answers with the assigned id and maps the toast as a
  // layer-shell surface.
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/NOTIFY_ID id=\d+/);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/LAYER ns=notifications /);

  // Gate 6b: CTRL+ALT+Space opens the Omarchy menu — the same launcher binary
  // at its root level. Down+Enter descends into the theme list, and Enter on
  // an entry dispatches the switch through kwlctl.
  await pressCtrl(page, "Space", false, true);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_LEVEL root/);
  await pressKeys(page, ["ArrowDown", "Enter"]);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_LEVEL themes/);
  await pressKeys(page, ["Enter"]);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_THEME name=[a-z-]+/);

  // Gate 7: the bar tracks the desktop. CTRL+2 switches workspace, and the
  // bar's hyprland/workspaces module reads the switch off the Hyprland IPC
  // event socket — which is what moves its active pill. Waybar logs every
  // event it receives (it runs at -l debug), so the bar's own line is the
  // proof the feed arrived; the compositor's WORKSPACE marker only proves it
  // was sent.
  await pressCtrl(page, "2");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/WORKSPACE active=2/);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/hyprland IPC received workspacev2>>2,2/);
});
