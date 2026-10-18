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

/** Show the Internals syslog, the demo canvas, or the machine's terminal.
 *  Internals is an overlay toggle in the dock; showing another view means
 *  closing it and selecting that view. */
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

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

/** The machine's terminal: cage and wlterm write their stdout there. */
async function terminalText(page: Page): Promise<string> {
  if ((await page.locator(".xterm-rows").count()) === 0) return "";
  const rows = await page.locator(".xterm-rows").first().locator(":scope > div").allInnerTexts();
  return rows.join("\n");
}

async function expectTerminal(page: Page, pattern: RegExp, timeout: number) {
  await openSurface(page, "Terminal");
  await expect.poll(() => terminalText(page), { timeout }).toMatch(pattern);
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

/** Full text of the Modeset status chip in the dock ("" while mounting). */
async function chipText(page: Page): Promise<string> {
  const texts = await page
    .locator(".kdemo-surface-controls")
    .filter({ hasText: "flips" })
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.join(" ");
}

/**
 * Browser gate for the cage machine: upstream cage on wlroots, with no
 * WLR_RENDERER override. The card has a render node, so wlroots takes its
 * GLES2 renderer, which reaches the host's WebGL2 bridge through libEGL's
 * GBM platform. The Node host has no WebGL2, so this spec is the only gate
 * on that path.
 *
 * Gates:
 *   1. The machine runs cage, and wlterm maps (WLTERM_READY, which wlterm
 *      prints after its first committed frame).
 *   2. cage's GL context owns the canvas: the Modeset chip reports the
 *      `webgl2-gl` renderer, which only a GL session that claimed the CRTC
 *      shows. Every frame on screen is therefore a gbm buffer wlroots
 *      rendered with GLES2 and the page flip blitted.
 *   3. The canvas shows a frame, not a blank: wlterm's window compresses
 *      to a PNG far larger than an all-black canvas.
 *   4. Only typing changes the frame: the frame holds still for a second
 *      (wlterm draws nothing on a timer), then a keystroke goes through
 *      libinput, cage's seat, wl_keyboard and wlterm's PTY, and the
 *      shell's echo is drawn into wlterm's wl_shm buffer, which wlroots
 *      uploads as a texture.
 *   5. `exit` ends the shell, and wlterm reports a clean exit.
 */
test("Kandelo cage renders a wlterm session with wlroots' GLES2 renderer", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?profile=cage");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running .*\/usr\/local\/bin\/cage/);
  expect(await syslogText(page)).not.toMatch(/configured command failed/);

  // Gate 1.
  await expectTerminal(page, /WLTERM_READY/, 120_000);

  // Gate 2.
  await openSurface(page, "Demo");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => chipText(page), { timeout: 30_000 })
    .toMatch(/webgl2-gl/i);

  // Gate 3. An all-black canvas compresses to a few KB.
  await expect
    .poll(
      async () => (await canvas.screenshot()).byteLength,
      { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(8_000);

  // Gate 4.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const frame = () => canvas.screenshot({ animations: "disabled" });
  const before = await frame();
  await page.waitForTimeout(1_000);
  expect((await frame()).equals(before)).toBe(true);
  await page.keyboard.type("echo cage-gles2-ok\n", { delay: 40 });
  await expect
    .poll(
      async () => (await frame()).equals(before),
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(false);

  // Gate 5.
  await page.keyboard.type("exit\n", { delay: 40 });
  await expectTerminal(page, /WLTERM_EXIT code=0/, 60_000);
});
