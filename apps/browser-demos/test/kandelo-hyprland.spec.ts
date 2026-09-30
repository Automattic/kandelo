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
 * Boot the Hyprland machine the way a visitor does: through its gallery row.
 * Machines are declared by the shell image, and the gallery row is the
 * tracked channel that produces `?vfs=<image>&profile=<id>`.
 */
async function launchHyprland(page: Page) {
  await gotoOrSkip(page, "/");
  await page
    .getByRole("button", { name: /^(New|Launch new computer)$/ })
    .first()
    .click();
  await expect(page.locator("tr.kgal-row").first()).toBeVisible();
  await page
    .locator("tr.kgal-row")
    .filter({ hasText: /Hyprland/i })
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
async function pressCtrl(page: Page, key: string, opts: { delay?: number; times?: number } = {}) {
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  for (let i = 0; i < (opts.times ?? 1); i++) {
    await page.keyboard.press(key, { delay: opts.delay });
  }
  await page.keyboard.up("Control");
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

// A command the host could not run, or the launcher reporting that the
// compositor died before the desktop came up.
const SETUP_FAILURE = /configured command failed/;
const DESKTOP_FAILURE = /hyprdesktop: /;
// A client killed by the compositor, or a buffer the compositor could not map.
const CLIENT_FAILURE =
  /invalid arguments for wl_shm|error in client communication|gbm_bo_map failed|gbm_bo_import/;

/** Boot the machine and wait for the three-client dwindle layout. */
async function bootToTiledDesktop(page: Page) {
  await launchHyprland(page);
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/local\/bin\/hyprdesktop/);
  expect(await syslogText(page), "hyprland setup reported failure")
    .not.toMatch(SETUP_FAILURE);
}

/**
 * End-to-end browser gate for the Hyprland machine: hyprdesktop starts
 * wlcompositor in dwindle mode and three clients — a wlclock and two wlterm
 * terminals — which it composites into gapped, server-side-decorated tiles,
 * with each client resizing to fill its tile. Skips (via gotoOrSkip) when the
 * binaries aren't built.
 */
test("Kandelo hyprland tiles three clients, resizes them into tiles, and honors CTRL keybinds (incl. app-launch binds)", async ({ page }) => {
  test.setTimeout(300_000);

  await bootToTiledDesktop(page);

  // Gate 1: dwindle layout + the image's Hyprland keybind config loaded.
  await expectTerminal(page, /WLC_LAYOUT dwindle/, 120_000);
  await expectTerminal(
    page,
    /BINDS_LOADED n=\d+ source=\/usr\/share\/kandelo\/hyprland\/wlcompositor\.conf/,
    30_000,
  );

  // Gate 2: all three clients connected and the dwindle tiler placed all
  // three tiles. The third map produces `TILE n=3 i=0..2` markers.
  await expectTerminal(page, /CLIENT_CONNECTED count=3/, 120_000);
  await expectTerminal(page, /TILE n=3 i=2 /, 120_000);
  expect(await terminalText(page), "hyprdesktop reported failure")
    .not.toMatch(DESKTOP_FAILURE);

  // Gate 3: the clients honored their dictated tile size. This is the demo's
  // crux — the compositor sends xdg configure(w,h) on retile, and the
  // libkwl/vt100 clients rebuild their buffers to match (floating clients on
  // the Wayland machine never resize, so these markers are unique to tiling).
  await expectTerminal(page, /WLCLOCK_RESIZE w=\d+ h=\d+/, 120_000);
  await expectTerminal(page, /WLTERM_RESIZE cols=\d+ rows=\d+/, 120_000);

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

  // Gate 5: CTRL keybinds reach the compositor. Exercise both a named key and
  // a digit, since they resolve differently (a letter/named keysym is
  // case-folded to match the base-level keysym; a digit isn't).
  // CTRL+Return execs a fourth client (`bind = CTRL, Return, exec, wlterm`).
  await pressCtrl(page, "Enter");
  await expectTerminal(page, /CLIENT_CONNECTED count=4/, 60_000);

  // CTRL+2 switches workspace (`bind = CTRL, 2, workspace, 2`).
  await pressCtrl(page, "2");
  await expectTerminal(page, /WORKSPACE active=2/, 30_000);

  // Gate 6: the "new pane" launch keybinds. Hyprland-style, each app has its
  // own exec bind rather than a launcher UI: CTRL+P execs wlpaint, CTRL+K execs
  // wlclock (K, not C, so the terminal keeps SIGINT). The compositor grabs the
  // combo, runs posix_spawnp, and the new client connects — so each press
  // bumps CLIENT_CONNECTED. preventDefault in BrowserInputSource suppresses
  // the browser's own Ctrl+P print default.
  await pressCtrl(page, "KeyP");
  await expectTerminal(page, /CLIENT_CONNECTED count=5/, 60_000);
  // ...and it fills its tile: the compositor retiles to fit the new window and
  // wlpaint honors the dictated size (WLPAINT_RESIZE), rather than drawing a
  // fixed 640×420 island in the corner.
  await expectTerminal(page, /WLPAINT_RESIZE w=\d+ h=\d+/, 60_000);

  await pressCtrl(page, "KeyK");
  await expectTerminal(page, /CLIENT_CONNECTED count=6/, 60_000);

  // Gate 7: closing a pane with CTRL+W (killactive) actually removes it. This
  // regresses a hang where the compositor sent xdg_toplevel.close but wlterm
  // blocked in waitpid() reaping its shell, so the surface was never destroyed
  // and the tile stayed on screen forever. Spawn a fresh terminal, wait for it
  // to take keyboard focus, then CTRL+W it and assert it exits (WLTERM_EXIT).
  // No terminal exits earlier in the demo, so the marker's presence proves the
  // close path completed.
  //
  // killactive targets the *focused* window, and keyboard focus only moves to
  // a new window once its first commit maps it — well after CLIENT_CONNECTED.
  // So don't race the map: wait for the compositor's KBD_FOCUS marker for a
  // wlterm printed after the seventh connection before pressing CTRL+W.
  // Otherwise killactive closes whatever held focus before it mapped (the
  // wlclock from Gate 6), and WLTERM_EXIT never arrives.
  await pressCtrl(page, "Enter");
  await expectTerminal(
    page,
    /CLIENT_CONNECTED count=7[\s\S]*KBD_FOCUS app_id=wlterm/,
    60_000,
  );

  await pressCtrl(page, "KeyW");
  await expectTerminal(page, /WLTERM_EXIT/, 30_000);

  expect(await syslogText(page), "hyprland reported failure after input")
    .not.toMatch(SETUP_FAILURE);
  expect(await terminalText(page), "a client failed after input")
    .not.toMatch(CLIENT_FAILURE);
});

/**
 * Regression gate for the kernel SCM_RIGHTS fd-delivery coalescing bug.
 *
 * Launching windows rapidly makes dwindle retile every existing window on each
 * new map — an O(N²) storm of `wl_shm.create_pool` messages, each carrying a
 * gbm prime-fd over the Unix socket as SCM_RIGHTS ancillary data. The kernel
 * used to pop only ONE ancillary fd-group per recvmsg, but a single recvmsg can
 * drain the coalesced bytes of several create_pool messages — so only the first
 * message's fd was delivered and the rest were stranded. libwayland then
 * demarshalled a later create_pool with a MISSING fd, the server posted
 * `invalid arguments for wl_shm.create_pool`, and killed that client. The
 * result was rate-dependent: launched slowly, all windows mapped (TILE n=8);
 * hammered, clients died mid-storm (TILE n=5). The kernel fix tags each
 * ancillary group with the byte-stream offset of its send and caps each
 * recvmsg at the next boundary, so a single recvmsg never spans two sends'
 * fds. This gate hammers eight launches back-to-back and asserts all eight map
 * — pre-fix it stalled at TILE n=5.
 */
test("Kandelo hyprland survives a rapid 8-window launch storm without SCM_RIGHTS fd loss", async ({ page }) => {
  test.setTimeout(300_000);

  await bootToTiledDesktop(page);

  // Wait for the initial three-client dwindle layout to settle.
  await expectTerminal(page, /CLIENT_CONNECTED count=3/, 120_000);
  await expectTerminal(page, /TILE n=3 i=2 /, 120_000);

  // Switch to an empty workspace so the storm's window count is unambiguous
  // (workspace 1 keeps the three initial clients).
  await pressCtrl(page, "2");
  await expectTerminal(page, /WORKSPACE active=2/, 30_000);

  // Hammer eight wlclock launches back-to-back (CTRL+K, no delay) — the fd
  // coalescing storm that used to drop clients.
  await pressCtrl(page, "KeyK", { delay: 0, times: 8 });

  // All eight windows must map and tile on workspace 2. Pre-fix this stalled
  // at TILE n=5 while CLIENT_CONNECTED still reached 11 — connected but killed
  // before mapping because their create_pool fd was lost. Reaching n=8 is the
  // proof no client died; the screen is also checked for the kill messages
  // while the storm's output is still on it.
  await expectTerminal(page, /TILE n=8 /, 120_000);
  expect(await terminalText(page), "a client failed during the launch storm")
    .not.toMatch(CLIENT_FAILURE);

  // Then close two panes (killactive) — the exact sequence a user hits after a
  // launch storm — and let the survivors retile/redraw. Every buffer must
  // still import/map: a prime-bo whose channel refcount was not held would
  // tombstone before the compositor imports it, and every subsequent
  // composite floods `gbm_bo_map failed: Invalid argument` — the user-visible
  // "freeze". A flood fills the screen, so it cannot scroll out of view.
  for (let i = 0; i < 2; i++) {
    await pressCtrl(page, "KeyW", { delay: 0 });
    await page.waitForTimeout(600);
  }
  await expectTerminal(page, /TILE n=6 /, 30_000);
  await page.waitForTimeout(2_000);
  expect(await terminalText(page), "a client failed after the close/retile")
    .not.toMatch(CLIENT_FAILURE);
  expect(await syslogText(page), "hyprland reported failure after the launch storm")
    .not.toMatch(SETUP_FAILURE);
});
