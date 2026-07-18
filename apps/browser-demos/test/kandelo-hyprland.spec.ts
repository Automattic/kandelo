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
test("Kandelo hyprland tiles three clients, resizes them into tiles, and honors CTRL keybinds (incl. app-launch binds)", async ({ page }) => {
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

  // Gate 6: the "new pane" launch keybinds. Hyprland-style, each app has its
  // own exec bind rather than a launcher UI: CTRL+P execs wlpaint, CTRL+K execs
  // wlclock (`bind = CTRL, P/K, exec, /usr/local/bin/wl{paint,clock}`; K, not
  // C, so the terminal keeps SIGINT). The compositor grabs the combo, runs
  // posix_spawnp, and the new client connects — so each press bumps
  // CLIENT_CONNECTED. wlpaint is staged only for this path (not auto-spawned
  // into the initial layout). preventDefault in BrowserInputSource suppresses
  // the browser's own Ctrl+P print default.
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Control");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/CLIENT_CONNECTED count=5/);
  // ...and it fills its tile: the compositor retiles to fit the new window and
  // wlpaint honors the dictated size (WLPAINT_RESIZE), rather than drawing a
  // fixed 640×420 island in the corner.
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/WLPAINT_RESIZE w=\d+ h=\d+/);

  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Control");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/CLIENT_CONNECTED count=6/);

  // Gate 7: closing a pane with CTRL+W (killactive) actually removes it. This
  // regresses a hang where the compositor sent xdg_toplevel.close but wlterm
  // blocked in waitpid() reaping its shell (closing the pty master didn't hang
  // dash up), so the surface was never destroyed and the tile stayed on screen
  // forever. Spawn a fresh terminal, focus it (newly mapped windows take
  // keyboard focus), then CTRL+W it and assert it exits (WLTERM_EXIT) — pre-fix
  // that marker never arrived. No terminal exits earlier in the demo, so its
  // mere presence proves the close path completed.
  //
  // killactive targets the *focused* window, and keyboard focus only moves to a
  // new window once its first commit maps it (surface_commit) — which lands
  // well after CLIENT_CONNECTED (socket connect) and after the client's own
  // WLTERM_READY (queued, not-yet-processed first commit). So don't race the
  // map: after the spawn connects, wait for the compositor's authoritative
  // KBD_FOCUS marker to land on the fresh wlterm before pressing CTRL+W.
  // Otherwise killactive closes whatever held focus before it mapped (the
  // wlclock from Gate 6), and WLTERM_EXIT never arrives.
  const wltermFocusBefore = (
    (await syslogStream(page)).match(/KBD_FOCUS app_id=wlterm/g) ?? []
  ).length;

  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/CLIENT_CONNECTED count=7/);
  // The fresh terminal has connected; now wait until it actually maps and takes
  // keyboard focus (one more KBD_FOCUS app_id=wlterm than before the spawn)
  // before we killactive it.
  await expect
    .poll(
      async () =>
        ((await syslogStream(page)).match(/KBD_FOCUS app_id=wlterm/g) ?? [])
          .length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(wltermFocusBefore);

  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyW");
  await page.keyboard.up("Control");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 30_000 })
    .toMatch(/WLTERM_EXIT/);

  expect(await syslogText(page), "hyprland reported failure after input")
    .not.toMatch(SETUP_FAILURE);
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
 * `invalid arguments for wl_shm.create_pool`, and killed that client. The result
 * was rate-dependent: launched slowly, all windows mapped (TILE n=8); hammered,
 * clients died mid-storm (TILE n=5). The kernel fix tags each ancillary group
 * with the byte-stream offset of its send and caps each recvmsg at the next
 * boundary, so a single recvmsg never spans two sends' fds. This gate hammers
 * eight launches back-to-back and asserts all eight map with no create_pool
 * error — pre-fix it stalled at TILE n=5.
 */
test("Kandelo hyprland survives a rapid 8-window launch storm without SCM_RIGHTS fd loss", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=hyprland");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running wlterm/);
  expect(await syslogText(page), "hyprland setup reported failure")
    .not.toMatch(SETUP_FAILURE);

  // Wait for the initial three-client dwindle layout to settle.
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/CLIENT_CONNECTED count=3/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/TILE n=3 i=2 /);

  // Switch to an empty workspace so the storm's window count is unambiguous
  // (workspace 1 keeps the three initial clients).
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  await page.keyboard.press("2");
  await page.keyboard.up("Control");
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogStream(page), { timeout: 30_000 })
    .toMatch(/WORKSPACE active=2/);

  // Hammer eight wlclock launches back-to-back (CTRL+K, no delay) — the fd
  // coalescing storm that used to drop clients. Each press execs a new wlclock,
  // which creates a wl_shm pool with a prime-fd; the rapid cadence coalesces the
  // create_pool sends in the socket byte stream.
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("KeyK", { delay: 0 });
  }
  await page.keyboard.up("Control");

  await openSurface(page, "Internals");
  // All eight windows must map and tile on workspace 2. Pre-fix (fd coalescing)
  // this stalled at TILE n=5 while CLIENT_CONNECTED still reached 11 — connected
  // but killed before mapping because their create_pool fd was lost.
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/TILE n=8 /);

  // Then close two panes (killactive) — the exact sequence a user hits after a
  // launch storm — and let the survivors retile/redraw.
  for (let i = 0; i < 2; i++) {
    await openSurface(page, "Demo");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyW", { delay: 0 });
    await page.keyboard.up("Control");
    await page.waitForTimeout(600);
  }
  await openSurface(page, "Internals");
  await page.waitForTimeout(2000);

  const log = await syslogText(page);
  // No client was killed by a demarshal error from a missing prime-fd
  // (the fd-coalescing bug).
  expect(log, "a client hit an SCM_RIGHTS fd-loss create_pool error")
    .not.toMatch(/invalid arguments for wl_shm/);
  expect(log, "a client connection was killed during the launch storm")
    .not.toMatch(/error in client communication/);
  // AND every mapped buffer imported/mapped: a prime-bo whose channel refcount
  // was not held would tombstone before the compositor imports it, and every
  // subsequent composite floods `gbm_bo_map failed: Invalid argument` — the
  // user-visible "freeze". This is the assertion the geometry-only TILE check
  // missed. Must stay green through the close/retile above, not just the launch.
  expect(log, "the compositor failed to map/import a client buffer (prime-bo lifetime bug)")
    .not.toMatch(/gbm_bo_map failed|gbm_bo_import/);
  expect(log, "hyprland reported failure after the launch storm")
    .not.toMatch(SETUP_FAILURE);
});
