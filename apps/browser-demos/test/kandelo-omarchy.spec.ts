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

// Press bare keys with the Demo surface focused, then return to Internals.
async function pressKeys(page: Page, keys: string[]) {
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (const key of keys) await page.keyboard.press(key);
  await openSurface(page, "Internals");
}

const SETUP_FAILURE =
  /omarchy failed|wlcompositor failed|kbar failed|wlclock failed|wlterm failed/;

/**
 * The O1 gate of docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md:
 * `/?demo=omarchy` boots the tiling compositor with the desktop shell Omarchy
 * is made of — a layer-shell status bar reserving the top strip, a launcher on
 * CTRL+Space, and switchable themes — and every piece is driven from the
 * keyboard. Skips (via gotoOrSkip) when the binaries aren't built.
 */
test("Kandelo omarchy boots a themed tiling desktop with a bar, a launcher, and live theme switching", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=omarchy");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running wlterm/);
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
    .toMatch(/WALLPAPER image w=960 h=540/);

  // Gate 2: the bar is a real layer-shell surface — anchored across the top at
  // the size it asked for, and reading the compositor's live theme.
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/LAYER ns=bar layer=2 x=0 y=0 w=\d+ h=30/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/KBAR_READY w=\d+ h=30/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/KBAR_THEME name=tokyo-night/);

  // Gate 3: the windows tile UNDER the bar. Only the tiles emitted after the
  // bar mapped are the desktop's answer — a client that maps first is laid out
  // over the whole output and re-configured once the bar reserves its strip,
  // so read the log from KBAR_READY onward.
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/TILE n=2 i=1 /);
  const afterBar = (await syslogStream(page)).split(/KBAR_READY /).pop() ?? "";
  const tiles = [...afterBar.matchAll(
    /TILE n=\d+ i=\d+ x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+)/g)];
  expect(tiles.length, "no tiles emitted after the bar mapped")
    .toBeGreaterThan(0);
  for (const t of tiles)
    expect(Number(t[2]), `a window tiled over the bar: ${t[0]}`)
      .toBeGreaterThanOrEqual(30);

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

  // Gate 5: CTRL+Space opens the launcher. It is an overlay layer surface that
  // takes the keyboard away from the focused terminal, so the "t" that follows
  // filters its list instead of being typed into the shell.
  await pressCtrl(page, "Space");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/LAYER ns=launcher layer=3 /);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_READY n=7/);

  // "te" narrows the seven entries (Bash, Clock, Nano, NetHack, Paint,
  // Terminal, Vim) to Terminal alone — "t" alone still matches Paint.
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
  await pressCtrl(page, "Space");
  await pressKeys(page, ["KeyV", "KeyI", "Enter"]);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/wlterm \/usr\/bin\/vim/);
  await expect
    .poll(() => syslogStream(page), { timeout: 120_000 })
    .toMatch(/TILE n=5 i=4 /);
  expect(await syslogText(page), "vim binary does not match the kernel ABI")
    .not.toMatch(/ABI version mismatch/);

  // Gate 6: CTRL+SHIFT+Space cycles the theme. One palette file repaints the
  // whole desktop — the compositor's borders, gaps and wallpaper, and the
  // bar's own colours, which it reloads off the broadcast.
  await pressCtrl(page, "Space", true);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/THEME (catppuccin|everforest|gruvbox|nord|rose-pine)/);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KBAR_THEME name=(catppuccin|everforest|gruvbox|nord|rose-pine)/);

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

  // Gate 7: the bar tracks the desktop. CTRL+2 switches workspace and the bar
  // moves its active pill — the kwlctl event feed reaching a shell client.
  await pressCtrl(page, "2");
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/WORKSPACE active=2/);
  await expect
    .poll(() => syslogStream(page), { timeout: 60_000 })
    .toMatch(/KBAR_WORKSPACE n=2/);
});
