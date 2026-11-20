import { expect, test, type Locator, type Page } from "../playwright-test";
import { expectNoViteErrorOverlay, gotoMachine, waitForMachineBootInput } from "./support/kandelo-machine";
import { setInternalsOpen } from "./support/dock";


/**
 * Boot the Omarchy machine the way a visitor does: through its gallery row.
 * Machines are declared by the shell image, and the gallery row is the
 * tracked channel that produces `?vfs=<image>&profile=<id>`.
 */
async function launchOmarchy(page: Page) {
  await gotoMachine(page, "omarchy");
  await expectNoViteErrorOverlay(page);
}

/**
 * Show the Internals syslog, the Graphics canvas, or the machine's terminal.
 * Internals is an overlay toggle in the dock (aria-pressed); showing the demo
 * or the terminal means closing it and selecting that view.
 */
async function openSurface(page: Page, label: "Internals" | "Graphics" | "Terminal") {
  // A display click captures the browser pointer. Release it through the
  // document, not Escape, so the focused game receives no key.
  if (await page.evaluate(() => document.pointerLockElement !== null)) {
    await page.evaluate(() => document.exitPointerLock());
    await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  }
  if (label === "Internals") await waitForMachineBootInput(page);
  await setInternalsOpen(page, label === "Internals");
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
 * shell, so omarchydesktop's SWAY event lines and every client's output reach
 * that terminal. Only the rows on screen are in the DOM — no scrollback — so
 * every gate below matches a line while it is visible.
 */
async function terminalText(page: Page): Promise<string> {
  if ((await page.locator(".xterm-rows").count()) === 0) return "";
  const rows = await page.locator(".xterm-rows").first().locator(":scope > div").allInnerTexts();
  return rows.join("\n");
}

/** Show the terminal and wait until `pattern` appears in it. The machine
 *  switches to the Graphics view once sway's display comes up, so every poll
 *  shows the terminal again. */
async function expectTerminal(page: Page, pattern: RegExp, timeout: number) {
  await expect.poll(async () => {
    await openSurface(page, "Terminal");
    return terminalText(page);
  }, { timeout }).toMatch(pattern);
}

/** Press a CTRL combo on the desktop. A browser reserves SUPER (Cmd/Win), so
 *  the session mirrors the essential binds on CTRL — the path users actually
 *  press. Focus off the canvas placeholder first (BrowserInputSource listens
 *  on window). */
async function pressCtrl(page: Page, key: string, shift = false, alt = false) {
  await openSurface(page, "Graphics");
  await canvasLocator(page).focus();
  await expect(canvasLocator(page)).toBeFocused();
  await page.keyboard.down("Control");
  if (shift) await page.keyboard.down("Shift");
  if (alt) await page.keyboard.down("Alt");
  await page.keyboard.press(key);
  if (alt) await page.keyboard.up("Alt");
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}

/** Press bare keys with the Graphics surface focused. */
async function pressKeys(page: Page, keys: string[]) {
  await openSurface(page, "Graphics");
  await canvasLocator(page).focus();
  await expect(canvasLocator(page)).toBeFocused();
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
// service died or a setup step failed.
const SETUP_FAILURE = /configured command failed/;
const DESKTOP_FAILURE = /omarchydesktop: /;
// A client libwayland disconnected, or a buffer the GPU path could not map.
const CLIENT_FAILURE = /error in client communication|gbm_bo_map failed|gbm_bo_import/;

/** sway's IPC window event, as omarchydesktop prints it. */
type SwayWindow = {
  change: string;
  app: string;
  pid: string;
  rect: { x: number; y: number; w: number; h: number };
  content: { x: number; y: number; w: number; h: number };
  windows: number;
};

function swayWindows(text: string): SwayWindow[] {
  const line =
    /SWAY window (\w+) app_id=(\S*) pid=(\d+) rect=(-?\d+),(-?\d+),(\d+)x(\d+) content=(-?\d+),(-?\d+),(\d+)x(\d+) windows=(\d+)/g;
  return [...text.matchAll(line)].map((m) => ({
    change: m[1],
    app: m[2],
    pid: m[3],
    rect: { x: Number(m[4]), y: Number(m[5]), w: Number(m[6]), h: Number(m[7]) },
    content: { x: Number(m[8]), y: Number(m[9]), w: Number(m[10]), h: Number(m[11]) },
    windows: Number(m[12]),
  }));
}

/** Wait for sway to report a window event that `match` accepts. */
async function expectWindow(page: Page, match: (w: SwayWindow) => boolean, timeout: number) {
  await openSurface(page, "Terminal");
  let found: SwayWindow | undefined;
  await expect
    .poll(async () => (found = swayWindows(await terminalText(page)).findLast(match)) !== undefined, { timeout })
    .toBe(true);
  return found!;
}

/** Boot the machine and wait until omarchydesktop's event log runs. */
async function bootDesktop(page: Page) {
  await launchOmarchy(page);
  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/bin\/omarchydesktop/);
  expect(await syslogText(page), "omarchy setup reported failure").not.toMatch(SETUP_FAILURE);
  await expectTerminal(page, /SWAY subscribed/, 180_000);
  expect(await terminalText(page), "a desktop service failed to start").not.toMatch(DESKTOP_FAILURE);
}

/** Switch to workspace `n` with the session's CTRL mirror. */
async function workspace(page: Page, n: number | string) {
  await pressCtrl(page, String(n));
  await expectTerminal(page, new RegExp(`SWAY workspace focus name=${n}\\b`), 30_000);
}

/**
 * Open a client from fuzzel. `chord` runs one of Omarchy's menus, and the
 * menu is opened, the query typed and Enter pressed until sway maps a new
 * window that `appear` accepts. fuzzel is a layer surface sway's IPC does
 * not report, so the query is retyped until it lands; run from an empty
 * workspace, where keys typed before fuzzel holds the keyboard reach no
 * window. fuzzel exits on Enter even when only the query's tail landed (it
 * runs the query as a command), so every attempt closes any menu left open
 * and opens a fresh one, waiting longer each time for it to take the
 * keyboard. An attempt waits for the window before the next one, so a slow
 * client is not launched twice: a second LÖVE game finds /dev/dsp held by
 * the first.
 */
async function openFromMenu(
  page: Page,
  chord: () => Promise<void>,
  query: string,
  appear: (w: SwayWindow) => boolean,
) {
  await openSurface(page, "Terminal");
  const before = new Set(swayWindows(await terminalText(page)).map((w) => w.pid));
  const mapped = async () => {
    await openSurface(page, "Terminal");
    return swayWindows(await terminalText(page))
      .find((w) => w.change === "new" && !before.has(w.pid) && appear(w));
  };
  let found: SwayWindow | undefined;
  let attempt = 0;
  await expect.poll(async () => {
    if ((found = await mapped())) return true;
    attempt += 1;
    await pressKeys(page, ["Escape"]);
    await chord();
    await page.waitForTimeout(2_000 * attempt);
    await page.keyboard.type(query, { delay: 20 });
    await page.keyboard.press("Enter");
    await expect.poll(async () => (found = await mapped()) !== undefined, { timeout: 30_000 }).toBe(true).catch(() => {});
    return found !== undefined;
  }, { timeout: 180_000, intervals: [0] }).toBe(true);
  return found!;
}

/** Omarchy's app launcher: fuzzel over /usr/share/kandelo/applications. */
const openApp = (page: Page, query: string, appear: (w: SwayWindow) => boolean) =>
  openFromMenu(page, () => pressCtrl(page, "Space", false, true), query, appear);

type Rgb = [number, number, number];
/** The canvas and the size of the output sway drives on it. */
type Output = { canvas: Locator; width: number; height: number };

/** The connector mode follows the pane's device pixels, and the Modeset chip
 *  reports it ("1088×612 · 40 flips · …"). sway's layout is in that mode. */
async function output(page: Page): Promise<Output> {
  await openSurface(page, "Graphics");
  const chip = await page.getByText(/\d+×\d+ · \d+ flips/).first().innerText({ timeout: 30_000 }).catch(() => "");
  const mode = chip.match(/(\d+)×(\d+)/);
  expect(mode, "the Modeset chip reports the connector mode").not.toBeNull();
  return { canvas: canvasLocator(page), width: Number(mode![1]), height: Number(mode![2]) };
}

/** A region of the output, as it is on screen. */
async function outputShot({ canvas, ...size }: Output, x: number, y: number, width: number, height: number) {
  const box = (await canvas.boundingBox())!;
  const sx = box.width / size.width;
  const sy = box.height / size.height;
  return canvas.page().screenshot({
    animations: "disabled",
    clip: { x: box.x + x * sx, y: box.y + y * sy, width: width * sx, height: height * sy },
  });
}

/** The mean color of each pixel row of a PNG, decoded in the page. */
async function rowColors(page: Page, png: Buffer): Promise<Rgb[]> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const colors: [number, number, number][] = [];
    for (let y = 0; y < height; y++) {
      const sum = [0, 0, 0];
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 3; c++) sum[c] += data[(y * width + x) * 4 + c];
      colors.push([sum[0] / width, sum[1] / width, sum[2] / width]);
    }
    return colors;
  }, png.toString("base64"));
}

const near = (a: Rgb, b: Rgb, by: number) => a.every((v, i) => Math.abs(v - b[i]) <= by);

/** A window's content area on the output: sway's rect plus its window_rect. */
const contentArea = (w: SwayWindow) => ({
  x: w.rect.x + w.content.x,
  y: w.rect.y + w.content.y,
  w: w.content.w,
  h: w.content.h,
});

/**
 * The Omarchy machine boots Omarchy v4's own scripts, menus, themes and key
 * bindings on upstream sway — fuzzel for the menu and the app launcher, mako
 * for notifications, swaylock for the lock screen — and every piece is driven
 * from the keyboard. Fails (via expectNoViteErrorOverlay) when the binaries aren't published.
 */
test("Kandelo omarchy boots the Omarchy look-alike with its bar, menus, notifications and lock screen", async ({ page }) => {
  test.setTimeout(420_000);

  await bootDesktop(page);

  // The desktop boots bare: the event log is up, which takes longer than a
  // client would, so a window here is a window nobody asked for.
  expect(await terminalText(page), "the desktop opened a window on its own")
    .not.toMatch(/SWAY window new/);

  // Gate 1: the desktop composited to the canvas through sway's GLES2
  // renderer. The Modeset pane uses transferControlToOffscreen, so PNG
  // byteLength stands in for pixel readback — a blank frame is ~3 KB; a
  // background and a bar are far larger. The pane's badge reads the presenter
  // out of the KMS stats: "webgl2-gl" is sway's own context.
  await openSurface(page, "Graphics");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await canvas.screenshot()).byteLength, { timeout: 120_000, intervals: [1_000, 2_000, 5_000] })
    .toBeGreaterThan(12_000);
  await expect(page.locator("text=/flips ·/").first()).toContainText(/webgl2-gl/i, { timeout: 30_000 });

  // Gate 2: the session's own binds open clients — CTRL+K for the clock,
  // CTRL+Return for each terminal — and sway tiles each one under the bar.
  // Each is awaited before the next, so a missed key shows up here rather
  // than as a wrong count later.
  await pressCtrl(page, "KeyK");
  await expectWindow(page, (w) => w.change === "new" && w.app === "wlclock" && w.windows === 1, 60_000);
  await pressCtrl(page, "Enter");
  await expectWindow(page, (w) => w.change === "new" && w.app === "foot" && w.windows === 2, 60_000);
  await pressCtrl(page, "Enter");
  await expectWindow(page, (w) => w.change === "new" && w.app === "foot" && w.windows === 3, 60_000);
  // sway sends `new` before it arranges the window, so the tile's geometry
  // is the one on the focus event that follows.
  await expectWindow(page, (w) => w.change === "focus" && w.app === "foot" && w.windows === 3, 60_000);
  const tiles = swayWindows(await terminalText(page)).filter((w) => w.change === "focus");
  expect(tiles.length, "the three new windows are not on screen").toBeGreaterThanOrEqual(3);
  for (const tile of tiles)
    expect(tile.rect.y, `a window tiled over the bar: ${JSON.stringify(tile)}`).toBeGreaterThan(0);
  expect(await syslogText(page), "foot binary does not match the kernel ABI").not.toMatch(/ABI version mismatch/);

  // Gate 3: CTRL+ALT+Space runs Omarchy's `omarchy-menu toggle apps`, whose
  // fuzzel launcher lists the image's applications. "term" narrows them to
  // Terminal: stock foot 1.28.0 on an empty workspace.
  await workspace(page, 2);
  await openApp(page, "term", (w) => w.app === "foot" && w.windows === 1);
  await expectTerminal(page, /SWAY binding exec omarchy-menu toggle apps/, 10_000);

  // Gate 3b: a real application through the same path. "vim" runs unmodified
  // vim inside foot, fetched lazily from vim.zip on first exec.
  await workspace(page, 3);
  await openApp(page, "vim", (w) => w.app === "foot" && w.windows === 1);
  expect(await syslogText(page), "vim binary does not match the kernel ABI").not.toMatch(/ABI version mismatch/);

  // Gate 4: CTRL+SHIFT+Space opens Omarchy's theme menu. Gruvbox runs
  // omarchy-theme-set, which renders the theme's templates and sends
  // Waybar SIGUSR2; Waybar reads the rendered style and paints the bar in
  // Gruvbox's background (#282828). The strip sampled is the bar's empty
  // stretch between the workspaces and the clock.
  await workspace(page, 5);
  const screen = await output(page);
  const bar = () => outputShot(screen, screen.width * 0.2, 4, screen.width * 0.2, 16);
  await pressCtrl(page, "Space", true);
  await expectTerminal(page, /SWAY binding exec omarchy-menu toggle theme/, 30_000);
  await expect.poll(async () => {
    await pressKeys(page, ["Backspace", "Backspace", "Backspace", "Backspace"]);
    await page.keyboard.type("gruv", { delay: 20 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3_000);
    return (await rowColors(page, await bar())).every((row) => near(row, [40, 40, 40], 6));
  }, { timeout: 180_000, intervals: [0] }).toBe(true);

  // Gate 5: a notification from Omarchy's own script. In a terminal,
  // omarchy-notification-send calls Notify through busctl on the session bus,
  // mako answers with the id it assigned, and the command names a workspace
  // after that id, so sway's workspace event carries mako's answer.
  await pressCtrl(page, "Enter");
  await expectWindow(page, (w) => w.change === "new" && w.app === "foot" && w.windows === 1, 60_000);
  await page.waitForTimeout(3_000); // let foot's shell reach its prompt
  await pressKeys(page, []);
  await typeUs(page, "swaymsg workspace notification-$(omarchy-notification-send -p kandelo)\n");
  await expectTerminal(page, /SWAY workspace focus name=notification-\d+/, 60_000);

  // Gate 6: CTRL+Escape opens Omarchy's System menu, and its Lock entry runs
  // swaylock through omarchy-system-lock. The lock covers the whole output,
  // bar included, with Gruvbox's JPEG background: the strip holding the bar's
  // logo and workspace numbers no longer matches its unlocked capture. It
  // keeps sway from running the session's binds; a wrong password keeps it
  // locked, and the demo user's password unlocks it.
  await workspace(page, 6);
  const out = await output(page);
  const barLabels = () => outputShot(out, 4, 4, out.width * 0.15, 18);
  const unlocked = await rowColors(page, await barLabels());
  const locked = async () => (await rowColors(page, await barLabels())).some((row, i) => !near(row, unlocked[i], 12));
  await pressCtrl(page, "Escape");
  await expectTerminal(page, /SWAY binding exec omarchy-menu toggle system/, 30_000);
  await expect.poll(async () => {
    await pressKeys(page, ["Backspace", "Backspace", "Backspace", "Backspace"]);
    await page.keyboard.type("lock", { delay: 20 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3_000);
    return locked();
  }, { timeout: 180_000, intervals: [0] }).toBe(true);

  await pressKeys(page, ["KeyX", "Enter"]);
  await page.waitForTimeout(3_000);
  await pressCtrl(page, "7");
  await page.waitForTimeout(3_000);
  expect(await locked(), "a wrong password unlocked the session").toBe(true);
  await openSurface(page, "Terminal");
  expect(await terminalText(page), "sway ran a bind while locked").not.toMatch(/SWAY workspace focus name=7/);

  // swaylock typed CTRL+7's "7" into its password; Escape clears it.
  await pressKeys(page, ["Escape", "KeyK", "KeyA", "KeyN", "KeyD", "KeyE", "KeyL", "KeyO", "Enter"]);
  await expect.poll(locked, { timeout: 60_000 }).toBe(false);
  await workspace(page, 7);
});

/**
 * Regression gate for the kernel SCM_RIGHTS fd-delivery coalescing bug.
 *
 * Launching windows rapidly makes the tiler resize every existing window on
 * each new map — a storm of buffer allocations, each carrying a gbm prime-fd
 * over the Unix socket as SCM_RIGHTS ancillary data. The kernel used to pop
 * only ONE ancillary fd-group per recvmsg, but a single recvmsg can drain the
 * coalesced bytes of several messages — so only the first message's fd was
 * delivered and the rest were stranded, and libwayland killed the client
 * whose message lost its fd: launched slowly all windows mapped, hammered
 * they stalled at five. The kernel fix tags each ancillary group with the
 * byte-stream offset of its send and caps each recvmsg at the next boundary.
 * This gate hammers eight launches back-to-back and asserts all eight map.
 */
test("Kandelo omarchy survives a rapid 8-window launch storm without SCM_RIGHTS fd loss", async ({ page }) => {
  test.setTimeout(300_000);

  await bootDesktop(page);
  // An empty workspace, so the storm's window count is unambiguous.
  await workspace(page, 2);

  // Eight wlclock launches back-to-back (CTRL+K, no delay).
  await openSurface(page, "Graphics");
  await canvasLocator(page).focus();
  await expect(canvasLocator(page)).toBeFocused();
  await page.keyboard.down("Control");
  for (let i = 0; i < 8; i++) await page.keyboard.press("KeyK", { delay: 0 });
  await page.keyboard.up("Control");

  // All eight must map. Pre-fix this stalled at five — connected but killed
  // before mapping.
  await expectWindow(page, (w) => w.change === "new" && w.app === "wlclock" && w.windows === 8, 120_000);
  expect(await terminalText(page), "a client failed during the launch storm").not.toMatch(CLIENT_FAILURE);

  // Close two windows and let the survivors resize: every buffer must still
  // import. A flood of import failures fills the screen, so it cannot scroll
  // out of view.
  for (let i = 0; i < 2; i++) {
    await pressCtrl(page, "KeyW");
    await page.waitForTimeout(600);
  }
  await expectWindow(page, (w) => w.change === "focus" && w.app === "wlclock" && w.windows === 6, 30_000);
  await page.waitForTimeout(2_000);
  expect(await terminalText(page), "a client failed after the close").not.toMatch(CLIENT_FAILURE);
});

/**
 * ScummVM as a Wayland client: upstream ScummVM on upstream SDL2's Wayland
 * backend, presenting through the libwayland-egl stand-in. It must fill its
 * tile: the launch wrapper picks SDL's Wayland backend because a compositor
 * socket exists, SDL takes the tiled size sway configures, and
 * wl_egl_window_resize reallocates the GL buffer. A client that kept its
 * creation-size buffer drew into one corner of the tile, and sway's IPC
 * cannot tell: it reports the size the window had when it mapped. So the gate
 * reads the tile from the canvas: ScummVM's launcher paints one background
 * color, and the tile's far corner must show it too.
 */
test("Kandelo omarchy runs ScummVM as a GL window that takes its tile's size", async ({ page }) => {
  test.setTimeout(300_000);

  await bootDesktop(page);
  await workspace(page, 2);

  // Launch it the way a user does: the launcher's entry runs the image's
  // wrapper, which execs the lazy engine.
  const scummvm = await openApp(page, "scummvm", (w) => w.windows === 1);
  expect(await syslogText(page), "scummvm binary does not match the kernel ABI").not.toMatch(/ABI version mismatch/);

  // sway reports a new window before its first configure, with an empty
  // rect; the tile's size arrives with the focus event of the mapped window.
  const tile = await expectWindow(page, (w) => w.change === "focus" && w.pid === scummvm.pid && w.content.w > 0, 60_000);
  const out = await output(page);
  const area = contentArea(tile);
  const patch = (fx: number, fy: number) =>
    outputShot(out, area.x + area.w * fx, area.y + area.h * fy, area.w * 0.04, area.h * 0.04);
  const mean = async (fx: number, fy: number) => {
    const rows = await rowColors(page, await patch(fx, fy));
    return rows.reduce((a, r) => [a[0] + r[0] / rows.length, a[1] + r[1] / rows.length, a[2] + r[2] / rows.length], [0, 0, 0]) as Rgb;
  };
  await expect.poll(async () => {
    const [background, far] = [await mean(0.1, 0.02), await mean(0.94, 0.94)];
    return near(background, far, 12) && far.some((v) => v > 8)
      ? "tile filled"
      : `the tile's far corner ${far} differs from ScummVM's background ${background}`;
  }, { timeout: 60_000 }).toBe("tile filled");

  expect(await terminalText(page), "a client failed while ScummVM ran").not.toMatch(CLIENT_FAILURE);
});

test("Kandelo omarchy launches all six LÖVE games as Wayland GL windows @slow", async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (/GL_INVALID_|GL_OUT_OF_MEMORY|WebGL: INVALID_|\[webgl\].*failed/.test(message.text()))
      errors.push(message.text());
  });
  await bootDesktop(page);
  await workspace(page, 2);

  for (const game of ["pong", "snake", "breakout", "asteroids", "bytepath", "snkrx"]) {
    // The workspace is empty again after each game, so keys typed before
    // fuzzel holds the keyboard reach no window.
    const window = await openApp(page, game, (w) => w.windows === 1);
    await expectTerminal(page, /love: using upstream LÖVE OpenGL renderer on Kandelo Wayland\/EGL/, 180_000);
    expect(await terminalText(page), game).not.toMatch(/lovefb:.*(?:error|main\.lua:)|Wayland.*failed/);

    // BYTEPATH's first run opens fullscreen, where sway maps a new window
    // without focus. SNKRX asks for a fixed size, so sway floats it, and
    // Alt+Tab cycles through tiles only. Omarchy's SUPER+F and SUPER+T tile them.
    const tiling = ({ bytepath: ["KeyF", "fullscreen toggle"], snkrx: ["KeyT", "floating toggle"] } as Record<string, [string, string]>)[game];
    if (tiling) {
      await pressKeys(page, []);
      await page.keyboard.down("Meta");
      await page.keyboard.press(tiling[0]);
      await page.keyboard.up("Meta");
      await expectTerminal(page, new RegExp(`SWAY binding ${tiling[1]}`), 30_000);
    }

    // A second window makes sway resize the running game, including the
    // games with their own love.run loops. The desktop must stay alive.
    if (game === "pong" || game === "bytepath" || game === "snkrx") {
      // An earlier game's clock can still be on screen.
      const clocks = new Set(swayWindows(await terminalText(page)).map((w) => w.pid));
      await pressCtrl(page, "KeyK");
      const clock = await expectWindow(page, (w) => w.change === "new" && w.app === "wlclock" && !clocks.has(w.pid) && w.windows === 2, 60_000);
      await expectTerminal(page, /WLCLOCK_READY/, 60_000);
      if (game === "snkrx") {
        // SNKRX's custom loop must dispatch resize, and its local pointer
        // scale must follow the smaller tile. Clicking the resized menu opens
        // colored shop cards in a region that was empty in the menu. Mod1+Tab
        // (Omarchy's focus-next bind) brings the game's tile back into focus.
        await pressKeys(page, []);
        await page.keyboard.press("Alt+Tab");
        const tile = await expectWindow(page, (w) => w.change === "focus" && w.pid === window.pid && w.windows === 2, 30_000);
        const area = contentArea(tile);
        const out = await output(page);
        const box = (await out.canvas.boundingBox())!;
        const x = (gx: number) => box.x + (area.x + gx * area.w / 480) * box.width / out.width;
        const y = (gy: number) => box.y + (area.y + gy * area.h / 270) * box.height / out.height;
        const clip = { x: x(20), y: y(25), width: x(240) - x(20), height: y(70) - y(25) };
        const colored = async () => (await rowColors(page, await page.screenshot({ clip })))
          .some(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 12);
        expect(await colored(), "the menu region holds no colored row").toBe(false);
        await page.mouse.move(x(55), y(125));
        await page.waitForTimeout(250); // upstream button hover state
        await page.mouse.click(x(55), y(125), { delay: 120 });
        await expect.poll(colored, { timeout: 15_000 }).toBe(true);
        await pressKeys(page, []);
        await page.keyboard.press("Alt+Tab");
        await expectWindow(page, (w) => w.change === "focus" && w.pid === clock.pid, 30_000);
      }
      await pressCtrl(page, "KeyW");
      await expectTerminal(page, /WLCLOCK_EXIT/, 60_000);
      await expectWindow(page, (w) => w.change === "focus" && w.pid === window.pid && w.windows === 1, 30_000);
    }
    if (game === "bytepath") {
      await pressKeys(page, []);
      await page.waitForTimeout(30_000); // upstream animated introduction
      await page.keyboard.press("ArrowDown", { delay: 120 });
      await page.keyboard.press("Enter", { delay: 120 });
      await page.waitForTimeout(2_000);
    }
    // Close the game through xdg-shell; the workspace is empty again.
    await pressCtrl(page, "KeyW");
    await expectWindow(page, (w) => w.change === "close" && w.pid === window.pid, 60_000);
    expect(await terminalText(page), game).not.toMatch(CLIENT_FAILURE);
  }
  expect(errors).toEqual([]);
});

/**
 * Copy and paste between two foot terminals, through sway's Wayland
 * selection. Nothing here touches the host clipboard: foot A owns the
 * selection, foot B reads it over a pipe sway hands from one client to the
 * other. The pasted text is a command that names a workspace, so the paste is
 * observable end to end: foot B runs what it received, and sway reports the
 * workspace. SUPER+C (Cmd+C on macOS) copies and Ctrl+V pastes, the chords
 * foot's own key bindings take in place of Omarchy's universal clipboard.
 */
test("Kandelo omarchy copies and pastes between foot windows through the Wayland clipboard", async ({ page }) => {
  test.setTimeout(300_000);

  await bootDesktop(page);
  await workspace(page, 3);

  // foot A prints the command. Its own echo line and its output both contain
  // the text, so the search below lands on exactly these bytes either way.
  await pressCtrl(page, "Enter");
  await expectWindow(page, (w) => w.change === "new" && w.app === "foot" && w.windows === 1, 60_000);
  await page.waitForTimeout(3_000); // let foot's shell reach its prompt
  await pressKeys(page, []);
  await typeUs(page, "echo swaymsg workspace clip-ok; swaymsg -t send_tick clip-printed\n");
  await expectTerminal(page, /SWAY tick clip-printed/, 60_000);

  // Select it from the keyboard (foot's scrollback search, committed with
  // Enter), then copy with SUPER+C.
  await pressCtrl(page, "KeyR", true);
  await page.keyboard.type("swaymsg workspace clip-ok", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Meta");

  // foot B takes focus and pastes with Ctrl+V.
  await pressCtrl(page, "Enter");
  await expectWindow(page, (w) => w.change === "new" && w.app === "foot" && w.windows === 2, 60_000);
  await page.waitForTimeout(3_000); // let foot B's shell reach its prompt
  await pressCtrl(page, "KeyV");

  // The pasted bytes are the command foot A held: running it names the
  // workspace.
  await pressKeys(page, ["Enter"]);
  await expectTerminal(page, /SWAY workspace focus name=clip-ok/, 60_000);
  expect(await terminalText(page), "a client failed during copy and paste").not.toMatch(CLIENT_FAILURE);
});

/**
 * Paste from the host clipboard: the page lets the browser's paste happen,
 * offers its text on /dev/kandelo/clipboard, kclipd makes it the desktop's
 * selection through ext_data_control_v1, and only then is the chord
 * delivered, so foot pastes the host's text. The pasted text is a command
 * that names a workspace, so the paste is observable end to end. Then kclipd
 * is stopped and a second paste fails visibly: the KMS pane's alert names the
 * cause, and the chord never reaches foot.
 *
 * Writing the host clipboard needs Chromium's clipboard permissions; the
 * other engines are verified by hand (docs/browser-support.md).
 */
test("Kandelo omarchy pastes text from the host clipboard into foot", async ({ page, browserName, context }) => {
  test.skip(browserName !== "chromium", "writes the host clipboard through Chromium's permission grant");
  test.setTimeout(300_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await bootDesktop(page);
  await expectTerminal(page, /KCLIPD_READY/, 180_000);
  await workspace(page, 4);
  await pressCtrl(page, "Enter");
  await expectWindow(page, (w) => w.change === "new" && w.app === "foot" && w.windows === 1, 60_000);
  await page.waitForTimeout(3_000); // let foot's shell reach its prompt

  // The host clipboard holds a command; paste it with the platform chord.
  const command = "swaymsg workspace host-paste-ok";
  await openSurface(page, "Graphics");
  await canvasLocator(page).focus();
  await expect(canvasLocator(page)).toBeFocused();
  await page.evaluate((text) => navigator.clipboard.writeText(text), command);
  await page.keyboard.press("ControlOrMeta+KeyV");
  await expectTerminal(page, new RegExp(`KCLIPD_OFFER seq=\\d+ len=${command.length}`), 30_000);
  await pressKeys(page, ["Enter"]);
  await expectTerminal(page, /SWAY workspace focus name=host-paste-ok/, 60_000);
  await expect(page.getByTestId("kms-paste-error")).toHaveCount(0);

  // Stop the agent from inside the desktop, then paste new text: the offer
  // has no agent, the alert says so, and foot receives nothing. The pasted
  // command left foot's workspace, so return to it first.
  await workspace(page, 4);
  await pressKeys(page, []);
  await typeUs(page, "for p in /proc/[0-9]*; do grep -qa kclipd $p/cmdline && kill ${p#/proc/}; done; swaymsg -t send_tick kclipd-stopped\n");
  await expectTerminal(page, /SWAY tick kclipd-stopped/, 60_000);
  await page.evaluate(() => navigator.clipboard.writeText("swaymsg workspace should-not-arrive"));
  await openSurface(page, "Graphics");
  await canvasLocator(page).focus();
  await expect(canvasLocator(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+KeyV");
  await expect(page.getByTestId("kms-paste-error")).toContainText(
    "Paste failed: the clipboard agent is not running in this machine",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("kms-paste-error")).toHaveAttribute("role", "alert");
  await pressKeys(page, ["Enter"]);
  await page.waitForTimeout(3_000);
  await openSurface(page, "Terminal");
  expect(await terminalText(page), "the paste reached foot without an agent")
    .not.toMatch(/name=should-not-arrive/);
  expect(await terminalText(page), "a client failed during host paste").not.toMatch(CLIENT_FAILURE);
});

/**
 * Copy-out: a copy chord over the desktop puts the guest's new selection on
 * the host clipboard. foot copies its selection; kclipd sees the desktop's
 * selection change through ext_data_control_v1, reads the text, and reports
 * it on /dev/kandelo/clipboard; the page, which started waiting on the
 * chord's keydown, writes it to the host clipboard. Both Linux/Windows copy
 * chords are exercised, Ctrl+Shift+C and the CUA Ctrl+Insert, each a foot
 * key binding. Then Ctrl+C — SIGINT in a terminal, which copies nothing —
 * must leave the host clipboard exactly as it was.
 *
 * Reading the host clipboard needs Chromium's clipboard permissions; the
 * other engines are verified by hand (docs/browser-support.md).
 */
test("Kandelo omarchy copies foot's selection to the host clipboard", async ({ page, browserName, context }) => {
  test.skip(browserName !== "chromium", "reads the host clipboard through Chromium's permission grant");
  test.setTimeout(300_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await bootDesktop(page);
  await expectTerminal(page, /KCLIPD_READY/, 180_000);
  await workspace(page, 5);
  await pressCtrl(page, "Enter");
  await expectWindow(page, (w) => w.change === "new" && w.app === "foot" && w.windows === 1, 60_000);
  await page.waitForTimeout(3_000); // let foot's shell reach its prompt
  // A loaded machine can read a key's release after foot's repeat delay, and
  // foot then types the key again, so each typed step is retried until it
  // lands. The shell echoes the text it sends as a tick, so the tick proves
  // the echoed line; a search that matches nothing selects nothing, and the
  // host clipboard keeps its text.
  const echo = async (text: string) => {
    await expect(async () => {
      await pressKeys(page, []);
      await typeUs(page, `t=${text}; echo $t; swaymsg -t send_tick $t\n`);
      await expectTerminal(page, new RegExp(`SWAY tick ${text}\\s*$`, "m"), 20_000);
    }).toPass({ timeout: 120_000 });
  };
  const copy = async (text: string, chord: string) => {
    await expect(async () => {
      await pressCtrl(page, "KeyR", true);
      await page.keyboard.type(text, { delay: 20 });
      await page.keyboard.press("Enter");
      await page.keyboard.press(chord);
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 })
        .toBe(text);
    }).toPass({ timeout: 120_000 });
  };
  const copiedNothing = async () =>
    (await syslogText(page)).match(/clipboard: copy chord copied nothing to the host \(timeout\)/g)?.length ?? 0;

  await echo("copyout-first");
  await echo("copyout-second");
  await page.evaluate(() => navigator.clipboard.writeText("host-before"));

  // Ctrl+Shift+C: the terminal's own copy chord. The chords go straight to
  // the keyboard: a click could clear foot's selection.
  await copy("copyout-first", "Control+Shift+KeyC");
  await expectTerminal(page, /KCLIPD_COPIED len=13/, 30_000);

  // Ctrl+Insert: the CUA chord, which foot's key bindings also take as copy.
  await copy("copyout-second", "Control+Insert");

  // Ctrl+C copies nothing in a terminal: once the copy-out wait expires
  // (Internals logs one more timeout; the terminal only holds the rows on
  // screen, so its lines cannot be counted), the host clipboard still holds
  // what it had.
  await openSurface(page, "Internals");
  const before = await copiedNothing();
  await page.evaluate(() => navigator.clipboard.writeText("host-after"));
  await pressCtrl(page, "KeyC");
  await openSurface(page, "Internals");
  await expect.poll(copiedNothing, { timeout: 10_000 }).toBeGreaterThan(before);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("host-after");
  expect(await terminalText(page), "a client failed during copy-out").not.toMatch(CLIENT_FAILURE);
});
