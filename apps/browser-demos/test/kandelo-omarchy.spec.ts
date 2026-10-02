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

/**
 * Boot the Omarchy machine the way a visitor does: through its gallery row.
 * Machines are declared by the shell image, and the gallery row is the
 * tracked channel that produces `?vfs=<image>&profile=<id>`.
 */
async function launchOmarchy(page: Page) {
  await gotoOrSkip(page, "/");
  await page
    .getByRole("button", { name: /^(New|Launch new computer)$/ })
    .first()
    .click();
  await expect(page.locator("tr.kgal-row").first()).toBeVisible();
  await page
    .locator("tr.kgal-row")
    .filter({ hasText: /Omarchy/i })
    .first()
    .click();
}

/**
 * Show the Internals syslog, the demo canvas, or the machine's terminal.
 * Internals is an overlay toggle in the dock (aria-pressed); showing the demo
 * or the terminal means closing it and selecting that view.
 */
async function openSurface(page: Page, label: "Internals" | "Demo" | "Terminal") {
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  await internals.waitFor({ state: "visible", timeout: 30_000 });
  const open = (await internals.getAttribute("aria-pressed")) === "true";
  if (open !== (label === "Internals")) await internals.click();
  if (label !== "Internals") {
    const view = page
      .getByLabel("Computer views")
      .getByRole("button", { name: label, exact: true });
    if ((await view.getAttribute("aria-current")) !== "true") await view.click();
  }
}

/** The host's boot log (Internals), where the command launch is recorded. */
async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

/**
 * The desktop's own output. The image's command runs in the machine's login
 * shell, so the compositor and every client write their markers to that
 * terminal. Only the rows on screen are in the DOM — no scrollback — so every
 * gate below matches a marker while it is visible, and orders events by
 * matching a sequence within the screen rather than counting a cumulative log.
 */
async function terminalText(page: Page): Promise<string> {
  if ((await page.locator(".xterm-rows").count()) === 0) return "";
  const rows = await page.locator(".xterm-rows").first().locator(":scope > div").allInnerTexts();
  return rows.join("\n");
}

/** Show the terminal and wait until `pattern` appears in it. */
async function expectTerminal(page: Page, pattern: RegExp, timeout: number) {
  await openSurface(page, "Terminal");
  await expect.poll(() => terminalText(page), { timeout }).toMatch(pattern);
}

/** Press a CTRL combo on the desktop. A browser reserves SUPER (Cmd/Win), so
 *  the demo binds every action on CTRL too — the path users actually press.
 *  Focus off the canvas placeholder first (BrowserInputSource listens on
 *  window). */
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
}

/** Press bare keys with the Demo surface focused. */
async function pressKeys(page: Page, keys: string[]) {
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (const key of keys) await page.keyboard.press(key);
}

/**
 * Type text the way a US keyboard does. `keyboard.type` sends a shifted
 * character such as `*` with no Shift held, and the guest's fixed US keymap
 * then types the unshifted key (`8`); a real keyboard holds Shift.
 */
async function typeUs(page: Page, text: string) {
  for (const ch of text) {
    const shifted = /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch);
    if (shifted) await page.keyboard.down("Shift");
    await page.keyboard.type(ch);
    if (shifted) await page.keyboard.up("Shift");
  }
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

// A command the host could not run, or the launcher reporting that a desktop
// service died before binding its socket.
const SETUP_FAILURE = /configured command failed/;
const DESKTOP_FAILURE = /omarchydesktop: /;

// A launcher session that is up and not yet dismissed: the last
// KLAUNCHER_READY on screen with no KLAUNCHER_EXIT after it. A key typed
// before the launcher holds the keyboard goes to the focused window, exactly
// as it would on the real desktop, so each session is awaited this way.
const OPEN_LAUNCHER = /KLAUNCHER_READY n=\d+(?![\s\S]*KLAUNCHER_EXIT)/;

/**
 * The Omarchy machine boots the tiling compositor with the desktop shell
 * Omarchy is made of — a layer-shell status bar reserving the top strip, a
 * launcher on CTRL+Space, notifications, and switchable themes — and every
 * piece is driven from the keyboard. Skips (via gotoOrSkip) when the binaries
 * aren't built.
 */
test("Kandelo omarchy boots a themed tiling desktop with a bar, a launcher, and live theme switching", async ({ page, browserName }) => {
  test.setTimeout(300_000);

  await launchOmarchy(page);
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/local\/bin\/omarchydesktop/);
  expect(await syslogText(page), "omarchy setup reported failure")
    .not.toMatch(SETUP_FAILURE);

  // Gate 1: the image's own config drives the desktop — the tiling layout,
  // the keybinds, and the theme named in that same file. Themes ship
  // gradient wallpapers for now (the theme images are a documented
  // follow-up), so the compositor paints the theme's gradient.
  // WALLPAPER is the last marker the compositor prints during startup;
  // once it appears the earlier markers are already on screen.
  await expectTerminal(page, /WALLPAPER gradient/, 120_000);
  const boot = await terminalText(page);
  expect(boot, "compositor did not load the image's config").toMatch(
    /BINDS_LOADED n=\d+ source=\/usr\/share\/kandelo\/omarchy\/wlcompositor\.conf/,
  );
  expect(boot, "the configured theme was not loaded").toMatch(/THEME tokyo-night/);
  expect(boot, "the compositor did not select the tiler").toMatch(/WLC_LAYOUT dwindle/);

  // Gate 2: the bar is unmodified Waybar on a real layer-shell surface —
  // anchored across the top, and its hyprland modules attached to the
  // compositor's Hyprland IPC event socket (HYPR_LISTENER). The bar's height
  // is read now, while its LAYER line is on screen.
  await expectTerminal(page, /LAYER ns=waybar layer=2 x=0 y=0 w=\d+ h=\d+/, 120_000);
  const barHeight = Number(
    (await terminalText(page)).match(/LAYER ns=waybar layer=2 x=0 y=0 w=\d+ h=(\d+)/)![1],
  );
  expect(barHeight, "waybar reserved no strip").toBeGreaterThan(0);
  await expectTerminal(page, /HYPR_LISTENER slot=\d+/, 120_000);
  expect(await terminalText(page), "a desktop service failed to start")
    .not.toMatch(DESKTOP_FAILURE);

  // The desktop boots bare. Assert that before touching the keyboard: the bar
  // has already mapped, which takes longer than a client would, so a tile
  // here is a window nobody asked for. Without this the gates below would
  // pass just as well against a desktop that opens its own.
  expect(await terminalText(page), "the desktop opened a window on its own")
    .not.toMatch(/TILE n=/);

  // Open the three clients the way a user does, through the binds the
  // compositor loaded from its own config: CTRL+K for the clock, CTRL+Return
  // for each terminal. Each one is awaited before the next, so a missed key
  // shows up here rather than as a wrong count three gates later. The tile
  // count is the window count: every window the compositor maps is tiled.
  await pressCtrl(page, "KeyK");
  await expectTerminal(page, /TILE n=1 i=0 [\s\S]*KBD_FOCUS app_id=wlclock|KBD_FOCUS app_id=wlclock[\s\S]*TILE n=1 i=0 /, 60_000);
  await pressCtrl(page, "Enter");
  await expectTerminal(page, /TILE n=2 i=1 /, 60_000);
  await pressCtrl(page, "Enter");
  await expectTerminal(page, /TILE n=3 i=2 /, 60_000);
  await expectTerminal(page, /TILE n=3 i=2 [^\n]*[\s\S]*KBD_FOCUS app_id=foot|KBD_FOCUS app_id=foot[\s\S]*TILE n=3 i=2 /, 30_000);

  // Gate 3: the windows tile UNDER the bar. The three-window retile is on
  // screen; every tile in it must start at or below the bar's strip.
  const tiles = [...(await terminalText(page)).matchAll(
    /TILE n=3 i=\d+ x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+)/g)];
  expect(tiles.length, "the three-window retile is not on screen")
    .toBeGreaterThanOrEqual(3);
  for (const t of tiles)
    expect(Number(t[2]), `a window tiled over the bar: ${t[0]}`)
      .toBeGreaterThanOrEqual(barHeight);
  // The three windows opened above are the only tiles. A surface with no
  // xdg_toplevel role — a client's cursor surface — taking one shifts every
  // count below by one, and the launcher gates then pass on the previous
  // client's tile instead of the one they name.
  expect(await terminalText(page), "a surface with no window role took a tile")
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
  await openSurface(page, "Terminal");
  expect(await terminalText(page), "GPU compositing was torn down")
    .not.toMatch(/GPU compositing failed/);

  // Gate 5: CTRL+Space opens the launcher. It is an overlay layer surface that
  // takes the keyboard away from the focused terminal, so the keys that follow
  // filter its list instead of being typed into the shell.
  await pressCtrl(page, "Space");
  await expectTerminal(page, /LAYER ns=launcher layer=3 /, 60_000);
  await expectTerminal(page, /KLAUNCHER_READY n=9/, 60_000);

  // "te" narrows the nine entries (Clock, Nano, NetHack, Paint, Quickshell,
  // ScummVM, Terminal, Theme Gallery, Vim) to Terminal alone — "t" alone
  // still matches Paint.
  await pressKeys(page, ["KeyT", "KeyE"]);
  await expectTerminal(page, /KLAUNCHER_FILTER q=te n=1/, 60_000);

  // Enter launches the one match (Terminal) through the compositor's kwlctl
  // socket and dismisses the launcher. The entry runs an unmodified upstream
  // client, stock foot 1.17.2 — wl_display_connect via XDG_RUNTIME_DIR,
  // fontconfig resolving "monospace" through the image's fonts.conf, fcft
  // rasterizing the image's Inconsolata. The desktop went in with three
  // tiled windows, so foot shows up as a fourth tile — the connection count
  // alone would not prove it, since the launcher's own session ends at the
  // same moment and frees its slot.
  await pressKeys(page, ["Enter"]);
  await expectTerminal(page, /KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/foot /, 60_000);
  await expectTerminal(page, /KLAUNCHER_EXIT/, 60_000);
  await expectTerminal(page, /TILE n=4 i=3 /, 120_000);
  expect(await syslogText(page), "foot binary does not match the kernel ABI")
    .not.toMatch(/ABI version mismatch/);
  // GLDRAW is the compositor's proof that it drew this window's texture.
  // Every marker above is protocol — map, focus, tile — and all of them
  // fire for a window whose wl_shm pool the GPU cannot import (a memfd
  // pool instead of a gbm prime fd). foot carries the gbm-pool patch that
  // keeps its pools importable; this is the gate that notices if it stops.
  await expectTerminal(page, /GLDRAW app_id=foot/, 60_000);

  // Gate 5b: a real application through the same path. "vi" narrows to Vim;
  // its entry runs unmodified vim inside foot, fetched lazily from
  // vim.zip on first exec — the fifth tile only appears if the whole chain
  // (launcher → kwlctl exec → foot → lazy fetch → vim) held.
  await pressCtrl(page, "Space");
  await expectTerminal(page, OPEN_LAUNCHER, 60_000);
  await pressKeys(page, ["KeyV", "KeyI", "Enter"]);
  await expectTerminal(page, /KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/foot [^\n]*\/usr\/bin\/vim/, 60_000);
  await expectTerminal(page, /TILE n=5 i=4 /, 120_000);
  expect(await syslogText(page), "vim binary does not match the kernel ABI")
    .not.toMatch(/ABI version mismatch/);

  // Gate 5d: a Qt application through the same path. "ga" narrows to Theme
  // Gallery; its entry runs qtgallery — QtGui's wayland QPA plugin connecting
  // via XDG_RUNTIME_DIR, xdg-shell configure, the raster backing store
  // through wl_shm, fontconfig resolving "sans-serif" through the image's
  // fonts.conf — and the sixth tile only appears once Qt maps its first
  // frame. The gallery reads the same six themes the compositor scanned.
  await pressCtrl(page, "Space");
  await expectTerminal(page, OPEN_LAUNCHER, 60_000);
  await pressKeys(page, ["KeyG", "KeyA", "Enter"]);
  await expectTerminal(page, /KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/qtgallery/, 60_000);
  await expectTerminal(page, /GALLERY_PLATFORM=wayland/, 120_000);
  await expectTerminal(page, /GALLERY_THEMES n=6/, 120_000);
  await expectTerminal(page, /TILE n=6 i=5 /, 120_000);
  expect(await syslogText(page), "qtgallery binary does not match the kernel ABI")
    .not.toMatch(/ABI version mismatch/);
  // The invisible-window gate. Qt's stock backing store allocates memfd
  // pools; the GL renderer cannot import those, skips the surface, and
  // every gate above still passes. Qt carries the same gbm-pool patch as
  // foot and GTK, and GLDRAW only fires once the window's texture was drawn.
  // The card→dispatch→theme-switch loop is proven by the Node smoke
  // (host/test/qtgallery-smoke.test.ts); this gate proves the browser half.
  await expectTerminal(page, /GLDRAW app_id=qtgallery/, 60_000);

  // Gate 5e: a QtQuick application through the same path. "qu" narrows to
  // Quickshell; its entry runs quickshell with the image's island.qml. The
  // QML engine loads, the scenegraph renders through the software
  // adaptation (QT_QUICK_BACKEND=software from the desktop's environment),
  // and the PanelWindow maps as a wlr-layer-shell surface under Quickshell's
  // default namespace — layer surfaces never emit GLDRAW, so the LAYER line
  // is the mapping proof. Firefox is excluded: the running desktop's wasm
  // code plus Quickshell's main and pthread modules exceeds SpiderMonkey's
  // fixed 2 GiB per-process executable-code arena, so Quickshell's first
  // QThread::start fails — see
  // docs/browser-support.md#firefox-executable-code-limit.
  if (browserName !== "firefox") {
    await pressCtrl(page, "Space");
    await expectTerminal(page, OPEN_LAUNCHER, 60_000);
    await pressKeys(page, ["KeyQ", "KeyU", "Enter"]);
    await expectTerminal(page, /KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/quickshell/, 60_000);
    await expectTerminal(page, /LAYER ns=quickshell /, 120_000);
  }

  // Gate 6: CTRL+SHIFT+Space cycles the theme. One palette file repaints the
  // whole desktop — the compositor's borders, gaps and wallpaper, and the
  // bar's: the switch runs the `notify =` hook, which reads the new
  // theme.conf, writes the bar's stylesheet from it, and sends Waybar
  // SIGUSR2. The bar answers that from a detached thread blocked on a signal
  // pipe, so "Reloading..." is also the proof that a signal reaches a
  // multi-threaded process.
  await pressCtrl(page, "Space", true);
  await expectTerminal(page, /THEME (catppuccin|everforest|gruvbox|nord|rose-pine)/, 60_000);
  await expectTerminal(
    page,
    /THEME_HOOK theme=(catppuccin|everforest|gruvbox|nord|rose-pine) bar=#[0-9a-f]{6} bar_pid=\d+/,
    60_000,
  );
  await expectTerminal(page, /Reloading\.\.\./, 60_000);
  // The switch also spawns the configured notifier: notify-send routes a
  // real org.freedesktop.Notifications.Notify over the dbus-daemon session
  // bus, mako answers with the assigned id and maps the toast as a
  // layer-shell surface.
  await expectTerminal(page, /NOTIFY_ID id=\d+/, 60_000);
  await expectTerminal(page, /LAYER ns=notifications /, 60_000);

  // Gate 6b: CTRL+ALT+Space opens the Omarchy menu — the same launcher binary
  // at its root level. Down+Enter descends into the theme list, and Enter on
  // an entry dispatches the switch through kwlctl.
  await pressCtrl(page, "Space", false, true);
  await expectTerminal(page, /KLAUNCHER_LEVEL root/, 60_000);
  await pressKeys(page, ["ArrowDown", "Enter"]);
  await expectTerminal(page, /KLAUNCHER_LEVEL themes/, 60_000);
  await pressKeys(page, ["Enter"]);
  await expectTerminal(page, /KLAUNCHER_THEME name=[a-z-]+/, 60_000);

  // Gate 7: the bar tracks the desktop. CTRL+2 switches workspace, and the
  // bar's hyprland/workspaces module reads the switch off the Hyprland IPC
  // event socket — which is what moves its active pill. Waybar logs every
  // event it receives (it runs at -l debug), so the bar's own line is the
  // proof the feed arrived; the compositor's WORKSPACE marker only proves it
  // was sent.
  // The theme switch above reloads Waybar, which re-dumps its widget tree
  // (about 40 lines at -l debug) and then re-maps the bar. Wait for the
  // re-map first: if the dump lands after CTRL+2, it scrolls the WORKSPACE
  // marker off the visible rows this gate reads.
  await expectTerminal(
    page,
    /Bar configured \(width: \d+, height: \d+\)[\s\S]*LAYER ns=waybar layer=2 /,
    60_000,
  );
  await pressCtrl(page, "2");
  await expectTerminal(page, /WORKSPACE active=2/, 60_000);
  await expectTerminal(page, /hyprland IPC received workspacev2>>2,2/, 60_000);
});

// A client killed by the compositor, or a buffer the compositor could not map.
const CLIENT_FAILURE =
  /invalid arguments for wl_shm|error in client communication|gbm_bo_map failed|gbm_bo_import/;

/**
 * Regression gate for the kernel SCM_RIGHTS fd-delivery coalescing bug.
 *
 * Launching windows rapidly makes the dwindle tiler retile every existing
 * window on each new map — an O(N²) storm of `wl_shm.create_pool` messages,
 * each carrying a gbm prime-fd over the Unix socket as SCM_RIGHTS ancillary
 * data. The kernel used to pop only ONE ancillary fd-group per recvmsg, but a
 * single recvmsg can drain the coalesced bytes of several create_pool
 * messages — so only the first message's fd was delivered and the rest were
 * stranded. libwayland then demarshalled a later create_pool with a MISSING
 * fd, the server posted `invalid arguments for wl_shm.create_pool`, and killed
 * that client: launched slowly all windows mapped, hammered they stalled at
 * five. The kernel fix tags each ancillary group with the byte-stream offset
 * of its send and caps each recvmsg at the next boundary. This gate hammers
 * eight launches back-to-back and asserts all eight map. (It moved here from
 * the Hyprland machine, which the image no longer carries; Omarchy tiles the
 * same way.)
 */
test("Kandelo omarchy survives a rapid 8-window launch storm without SCM_RIGHTS fd loss", async ({ page }) => {
  test.setTimeout(300_000);

  await launchOmarchy(page);
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/local\/bin\/omarchydesktop/);
  await expectTerminal(page, /HYPR_LISTENER slot=\d+/, 180_000);

  // An empty workspace, so the storm's window count is unambiguous.
  await pressCtrl(page, "2");
  await expectTerminal(page, /WORKSPACE active=2/, 30_000);

  // Eight wlclock launches back-to-back (CTRL+K, no delay).
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  for (let i = 0; i < 8; i++) await page.keyboard.press("KeyK", { delay: 0 });
  await page.keyboard.up("Control");

  // All eight must map and tile. Pre-fix this stalled at five while the
  // connection count kept climbing — connected but killed before mapping.
  await expectTerminal(page, /TILE n=8 /, 120_000);
  expect(await terminalText(page), "a client failed during the launch storm")
    .not.toMatch(CLIENT_FAILURE);

  // Close two panes (killactive) and let the survivors retile: every buffer
  // must still import. A prime-bo whose channel refcount was not held would
  // tombstone before the compositor imports it, and every later composite
  // floods `gbm_bo_map failed` — a flood fills the screen, so it cannot
  // scroll out of view.
  for (let i = 0; i < 2; i++) {
    await pressCtrl(page, "KeyW");
    await page.waitForTimeout(600);
  }
  await expectTerminal(page, /TILE n=6 /, 30_000);
  await page.waitForTimeout(2_000);
  expect(await terminalText(page), "a client failed after the close/retile")
    .not.toMatch(CLIENT_FAILURE);
});

/**
 * ScummVM as a Wayland client. It is the desktop's one GL client that is not
 * written for Kandelo: upstream ScummVM on upstream SDL2's Wayland backend,
 * presenting through the libwayland-egl stand-in. Three platform pieces have
 * to agree for it to fill its tile, and each failed silently before:
 *
 *   - the launch wrapper picks SDL's Wayland backend because a compositor
 *     socket exists (it pins KMSDRM only on a bare display);
 *   - the compositor tells the window it is tiled, because SDL keeps a
 *     fixed-size window's own size for any configure it considers floating;
 *   - wl_egl_window_resize reallocates the GL buffer. A client that kept its
 *     creation-size buffer drew its tile-sized viewport cropped into it, and
 *     every protocol marker still fired.
 *
 * GLBUFFER is the compositor's report of the buffer a GL window actually
 * committed, so matching it to the tile is the gate for all three.
 */
test("Kandelo omarchy runs ScummVM as a GL window that takes its tile's size", async ({ page }) => {
  test.setTimeout(300_000);

  await launchOmarchy(page);
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/local\/bin\/omarchydesktop/);
  await expectTerminal(page, /HYPR_LISTENER slot=\d+/, 180_000);

  // Launch it the way a user does: the launcher's entry runs the image's
  // wrapper, which execs the lazy engine.
  await pressCtrl(page, "Space");
  await expectTerminal(page, OPEN_LAUNCHER, 60_000);
  await pressKeys(page, ["KeyS", "KeyC", "KeyU", "Enter"]);
  await expectTerminal(page, /KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/scummvm/, 60_000);

  // It maps as the only window, is tiled, and the GPU path draws its buffer.
  await expectTerminal(page, /TILE n=1 i=0 x=\d+ y=\d+ w=\d+ h=\d+/, 180_000);
  await expectTerminal(page, /GLDRAW app_id=SDL_App/, 60_000);
  expect(await syslogText(page), "scummvm binary does not match the kernel ABI")
    .not.toMatch(/ABI version mismatch/);

  // The buffer it commits after the tiled configure is the tile's size (times
  // a whole output scale). SDL's first buffer is its own default window size,
  // so poll for the one that follows the resize.
  await expect
    .poll(async () => {
      const text = await terminalText(page);
      const tile = [...text.matchAll(/TILE n=1 i=0 x=\d+ y=\d+ w=(\d+) h=(\d+)/g)].at(-1);
      const buffer = [...text.matchAll(/GLBUFFER app=SDL_App bw=(\d+) bh=(\d+)/g)].at(-1);
      if (!tile || !buffer) return "no TILE or GLBUFFER marker on screen";
      const [w, h] = [Number(tile[1]), Number(tile[2])];
      const [bw, bh] = [Number(buffer[1]), Number(buffer[2])];
      const scale = Math.round(bw / w);
      return scale >= 1 && bw === w * scale && bh === h * scale
        ? "buffer matches tile"
        : `buffer ${bw}x${bh} does not match tile ${w}x${h}`;
    }, { timeout: 60_000 })
    .toBe("buffer matches tile");

  expect(await terminalText(page), "a client failed while ScummVM ran")
    .not.toMatch(CLIENT_FAILURE);
});

/**
 * Copy and paste between two foot terminals, through the compositor's Wayland
 * selection and Omarchy's universal-clipboard binds. Nothing here touches the
 * host clipboard: foot A owns the selection, foot B reads it over a pipe the
 * compositor hands from one client to the other.
 *
 * The pasted text is a command, so the paste is observable end to end: foot B
 * runs what it received, and the toast it raises maps as mako's layer surface.
 * SUPER+C (Cmd+C on macOS) copies, exercising the SUPER bind; Ctrl+V pastes,
 * exercising the one CTRL mirror. Both must reach foot as Ctrl+Shift+C/V,
 * because foot carries the `terminal` tag.
 */
test("Kandelo omarchy copies and pastes between foot windows through the Wayland clipboard", async ({ page }) => {
  test.setTimeout(300_000);

  await launchOmarchy(page);
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/local\/bin\/omarchydesktop/);
  await expectTerminal(page, /HYPR_LISTENER slot=\d+/, 180_000);

  // An empty workspace, so the two terminals are the only windows.
  await pressCtrl(page, "3");
  await expectTerminal(page, /WORKSPACE active=3/, 30_000);

  // foot A prints the command. Its own echo line and its output both contain
  // the text, so the search below lands on exactly these bytes either way.
  await pressCtrl(page, "Enter");
  await expectTerminal(page, /TILE n=1 i=0 [\s\S]*KBD_FOCUS app_id=foot|KBD_FOCUS app_id=foot[\s\S]*TILE n=1 i=0 /, 60_000);
  await expectTerminal(page, /GLDRAW app_id=foot/, 60_000);
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type("echo notify-send clip-ok\n", { delay: 20 });

  // Select it from the keyboard (foot's scrollback search, committed with
  // Enter), then copy with SUPER+C.
  await pressCtrl(page, "KeyR", true);
  await page.keyboard.type("notify-send clip-ok", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Meta");
  await expectTerminal(page, /SENDSHORTCUT app_id=foot mods=0x6 key=46/, 30_000);
  await expectTerminal(page, /SELECTION_SET via=data-device mimes=\d+/, 30_000);

  // foot B takes focus and pastes with Ctrl+V; the paste reaches it as
  // Ctrl+Shift+V and foot B asks the compositor for the text.
  await pressCtrl(page, "Enter");
  await expectTerminal(page, /TILE n=2 i=1 [\s\S]*KBD_FOCUS app_id=foot|KBD_FOCUS app_id=foot[\s\S]*TILE n=2 i=1 /, 60_000);
  await page.waitForTimeout(3_000); // let foot B's shell reach its prompt
  await pressCtrl(page, "KeyV");
  await expectTerminal(page, /SENDSHORTCUT app_id=foot mods=0x6 key=47/, 30_000);
  await expectTerminal(page, /SELECTION_RECEIVE mime=text\/plain;charset=utf-8/, 30_000);

  // The pasted bytes are the command foot A held: running it raises the toast.
  await pressKeys(page, ["Enter"]);
  await expectTerminal(page, /LAYER ns=notifications /, 60_000);
  expect(await terminalText(page), "a client failed during copy and paste")
    .not.toMatch(CLIENT_FAILURE);
});

/**
 * Paste from the host clipboard: the page lets the browser's paste happen,
 * offers its text on /dev/kandelo/clipboard, kclipd makes it the desktop's
 * selection through ext_data_control_v1, and only then is the chord
 * delivered, so foot pastes the host's text. The pasted text is a command,
 * so the paste is observable end to end (mako's toast maps). Then kclipd is
 * stopped and a second paste fails visibly: the KMS pane's alert names the
 * cause, and the chord never reaches foot.
 *
 * Writing the host clipboard needs Chromium's clipboard permissions; the
 * other engines are verified by hand (docs/browser-support.md).
 */
test("Kandelo omarchy pastes text from the host clipboard into foot", async ({ page, browserName, context }) => {
  test.skip(browserName !== "chromium", "writes the host clipboard through Chromium's permission grant");
  test.setTimeout(300_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await launchOmarchy(page);
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/local\/bin\/omarchydesktop/);
  await expectTerminal(page, /KCLIPD_READY/, 180_000);
  await expectTerminal(page, /HYPR_LISTENER slot=\d+/, 180_000);

  await pressCtrl(page, "4");
  await expectTerminal(page, /WORKSPACE active=4/, 30_000);
  await pressCtrl(page, "Enter");
  await expectTerminal(page, /TILE n=1 i=0 [\s\S]*KBD_FOCUS app_id=foot|KBD_FOCUS app_id=foot[\s\S]*TILE n=1 i=0 /, 60_000);
  await expectTerminal(page, /GLDRAW app_id=foot/, 60_000);
  await page.waitForTimeout(3_000); // let foot's shell reach its prompt

  // The host clipboard holds a command; paste it with the platform chord.
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => navigator.clipboard.writeText("notify-send host-paste-ok"));
  await page.keyboard.press("ControlOrMeta+KeyV");
  await expectTerminal(page, /SELECTION_SET via=ext-data-control mimes=4/, 30_000);
  await expectTerminal(page, /KCLIPD_OFFER seq=\d+ len=25/, 30_000);
  await expectTerminal(page, /SELECTION_RECEIVE mime=text\/plain;charset=utf-8/, 30_000);
  await pressKeys(page, ["Enter"]);
  await expectTerminal(page, /LAYER ns=notifications /, 60_000);
  await expect(page.getByTestId("kms-paste-error")).toHaveCount(0);

  // Stop the agent from inside the desktop, then paste new text: the
  // offer has no agent, the toast says so, and foot receives nothing.
  await pressKeys(page, []);
  await typeUs(
    page,
    "for p in /proc/[0-9]*; do grep -qa kclipd $p/cmdline && kill ${p#/proc/}; done\n",
  );
  await page.waitForTimeout(2_000);
  await page.evaluate(() => navigator.clipboard.writeText("echo should-not-arrive"));
  const receivesBefore = ((await terminalText(page)).match(/SELECTION_RECEIVE/g) ?? []).length;
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+KeyV");
  await expect(page.getByTestId("kms-paste-error")).toContainText(
    "Paste failed: the clipboard agent is not running in this machine",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("kms-paste-error")).toHaveAttribute("role", "alert");
  // No new paste request reached the compositor.
  expect(((await terminalText(page)).match(/SELECTION_RECEIVE/g) ?? []).length)
    .toBeLessThanOrEqual(receivesBefore);
  expect(await terminalText(page), "a client failed during host paste")
    .not.toMatch(CLIENT_FAILURE);
});

/**
 * Copy-out: a copy chord over the desktop puts the guest's new selection on
 * the host clipboard. foot copies its selection; kclipd sees the desktop's
 * selection change through ext_data_control_v1, reads the text, and reports
 * it on /dev/kandelo/clipboard; the page, which started waiting on the
 * chord's keydown, writes it to the host clipboard. Both Linux/Windows copy
 * chords are exercised: Ctrl+Shift+C reaches foot as itself, Ctrl+Insert
 * through the compositor's bind. Then Ctrl+C — SIGINT in a terminal, which
 * copies nothing — must leave the host clipboard exactly as it was.
 *
 * Reading the host clipboard needs Chromium's clipboard permissions; the
 * other engines are verified by hand (docs/browser-support.md).
 */
test("Kandelo omarchy copies foot's selection to the host clipboard", async ({ page, browserName, context }) => {
  test.skip(browserName !== "chromium", "reads the host clipboard through Chromium's permission grant");
  test.setTimeout(300_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await launchOmarchy(page);
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/local\/bin\/omarchydesktop/);
  await expectTerminal(page, /KCLIPD_READY/, 180_000);
  await expectTerminal(page, /HYPR_LISTENER slot=\d+/, 180_000);

  await pressCtrl(page, "5");
  await expectTerminal(page, /WORKSPACE active=5/, 30_000);
  await pressCtrl(page, "Enter");
  await expectTerminal(page, /TILE n=1 i=0 [\s\S]*KBD_FOCUS app_id=foot|KBD_FOCUS app_id=foot[\s\S]*TILE n=1 i=0 /, 60_000);
  await expectTerminal(page, /GLDRAW app_id=foot/, 60_000);
  await page.waitForTimeout(3_000); // let foot's shell reach its prompt
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type("echo copyout-first; echo copyout-second\n", { delay: 20 });
  await page.evaluate(() => navigator.clipboard.writeText("host-before"));

  const select = async (text: string) => {
    await pressCtrl(page, "KeyR", true);
    await page.keyboard.type(text, { delay: 20 });
    await page.keyboard.press("Enter");
  };

  // Ctrl+Shift+C: the terminal's own copy chord.
  // The chords go straight to the keyboard: a click could clear foot's
  // selection.
  await select("copyout-first");
  await page.keyboard.press("Control+Shift+KeyC");
  await expectTerminal(page, /KCLIPD_COPIED len=13/, 30_000);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
    .toBe("copyout-first");

  // Ctrl+Insert: the CUA chord, which the compositor turns into foot's copy.
  await select("copyout-second");
  await page.keyboard.press("Control+Insert");
  await expectTerminal(page, /SENDSHORTCUT app_id=foot mods=0x6 key=46/, 30_000);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
    .toBe("copyout-second");

  // Ctrl+C copies nothing in a terminal: once the copy-out wait expires
  // (Internals logs the timeout; the terminal only holds the rows on
  // screen, so its markers cannot be counted), the host clipboard still
  // holds what it had.
  await page.evaluate(() => navigator.clipboard.writeText("host-after"));
  await pressCtrl(page, "KeyC");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 10_000 })
    .toMatch(/clipboard: copy chord copied nothing to the host \(timeout\)/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("host-after");
  expect(await terminalText(page), "a client failed during copy-out")
    .not.toMatch(CLIENT_FAILURE);
});
