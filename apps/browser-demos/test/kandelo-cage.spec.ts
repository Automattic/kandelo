import { expect, type Page } from "../playwright-test";
// Why: machine setup opens the OPFS computer library before starting Cage;
// WebKit's ephemeral context cannot exercise that storage-backed boot path.
import { test } from "./support/persistent-page";

import { gotoMachine, waitForMachineBootInput } from "./support/kandelo-machine";
import { cageShellTextColumns } from "./support/cage-shell-frame";
import { screenshotPixelDelta } from "./support/screenshot-pixels";
import { setInternalsOpen } from "./support/dock";
import { bootStoredComputer } from "./support/computer-library";
import { typePhysicalText } from "./support/physical-typing";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures, memoryBoundaryRealmId } from "./support/browser-memory-boundary";

/** Show the Internals syslog, Graphics, or the machine's terminal.
 *  Internals opens through More in the dock; showing another view means
 *  closing it and selecting that view. */
async function openSurface(page: Page, label: "Internals" | "Graphics" | "Terminal") {
  if (label === "Internals") await waitForMachineBootInput(page);
  await page.getByRole("button", { name: "More", exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
  await setInternalsOpen(page, label === "Internals");
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
  const terminal = page.locator(".kshell-terminal-slot:not([hidden])");
  if ((await terminal.locator(".xterm-screen:visible").count()) === 0) return "";
  // Why: old terminals survive a machine switch; only the selected terminal's
  // actual repaint proves that this session produced its readiness/exit log.
  await terminal.locator(".xterm-screen").screenshot({ timeout: 2_000 });
  const rows = await terminal.locator(".xterm-rows").locator(":scope > div").allInnerTexts();
  return rows.join("\n");
}

async function expectTerminal(page: Page, pattern: RegExp, timeout: number) {
  // Why: the first graphics frame may select Graphics after an early click.
  // Select the terminal again on observation instead of reading a hidden pane.
  await expect(async () => {
    await openSurface(page, "Terminal");
    expect(await terminalText(page)).toMatch(pattern);
  }).toPass({ timeout });
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas").first();

test("Cage reports computer storage bootstrap failure before launching a guest", async ({ page }) => {
  const workers: string[] = [];
  page.on("worker", worker => workers.push(worker.url()));
  await page.addInitScript(() => {
    (window as unknown as { storageFailureCalls: number }).storageFailureCalls = 0;
    StorageManager.prototype.getDirectory = async () => {
      (window as unknown as { storageFailureCalls: number }).storageFailureCalls++;
      throw new DOMException("original storage failure", "UnknownError");
    };
  });
  await gotoMachine(page, "cage");
  await expect(page.getByRole("alert")).toHaveText(
    "Opening browser computer storage (navigator.storage.getDirectory) failed: UnknownError: original storage failure",
    { timeout: 30_000 },
  );
  expect(await page.evaluate(() => (window as unknown as { storageFailureCalls: number }).storageFailureCalls)).toBe(1);
  expect(workers).toEqual([]);
});

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
 *   4. After the shell's first output appears, only typing changes the
 *      frame: the frame holds still for a second
 *      (wlterm draws nothing on a timer), then a keystroke goes through
 *      libinput, cage's seat, wl_keyboard and wlterm's PTY, and the
 *      shell's echo is drawn into wlterm's wl_shm buffer, which wlroots
 *      uploads as a texture.
 *   5. `exit` ends the shell, and wlterm reports a clean exit.
 */
test("Kandelo cage renders a wlterm session with wlroots' GLES2 renderer", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoMachine(page, "cage");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running .*\/usr\/bin\/cage/);
  expect(await syslogText(page)).not.toMatch(/configured command failed/);

  // Gate 1.
  await expectTerminal(page, /WLTERM_READY/, 120_000);

  // Gate 2.
  await openSurface(page, "Graphics");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => chipText(page), { timeout: 30_000 })
    .toMatch(/webgl2-gl/i);

  // Gate 3. PNG size varies with mode and browser encoder; prove real shell
  // pixels rather than rejecting a valid lower-resolution frame by byte size.
  // The first committed frame is an empty grid. Wait for actual shell
  // output before testing idle stability: loading the shell and drawing its
  // prompt is a legitimate change after WLTERM_READY, without any input.
  const mode = (await chipText(page)).match(/(\d+)×(\d+)/);
  expect(mode, "the Modeset chip reports the connector mode").not.toBeNull();
  const output = { width: Number(mode![1]), height: Number(mode![2]) };
  await expect.poll(
    async () => cageShellTextColumns(page, await canvas.screenshot(), output),
    { timeout: 60_000, message: "wlterm has rendered the shell's first output" },
  ).toBeGreaterThan(24);
  // Browser focus must not inject a guest click and change wlterm or
  // compositor state before the typing-only framebuffer assertion.
  await canvas.focus();
  await expect(canvas).toBeFocused();
  // Locator screenshots include DOM overlays above the canvas. The initial
  // lazy-download toasts can finish after the shell prompt is painted; their
  // disappearance is not a change in wlterm's framebuffer.
  await expect(page.getByRole("complementary", { name: "Download status" }))
    .toBeHidden({ timeout: 60_000 });
  const frame = () => canvas.screenshot({ animations: "disabled" });
  const before = await frame();
  await page.waitForTimeout(1_000);
  const idleDelta = await screenshotPixelDelta(page, before, await frame());
  expect(idleDelta, "wlterm's rendered pixels remain unchanged while idle").toMatchObject({ same: true, changed: 0 });
  await page.keyboard.type("echo cage-gles2-ok\n", { delay: 40 });
  await expect
    .poll(
      async () => (await screenshotPixelDelta(page, before, await frame())).same,
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(false);

  // Gate 5. Physical Shift transitions must not write modifier keysyms as
  // invisible text. A zero exit proves the shell parsed the actual uppercase
  // and shifted punctuation, beyond merely repainting the typed command.
  await typePhysicalText(page, 'test "CAGE" = "CAGE" && test "$((5+7))" -eq 12; exit $?\n', { delay: 40 });
  await expectTerminal(page, /WLTERM_EXIT code=0/, 60_000);
});

test("Cage resizes, releases its display on exit and survives repeated live restarts", async ({ page }) => {
  test.setTimeout(600_000);
  await installBrowserMemoryBoundaryProbe(page);
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" || /force-terminating|retirement.*timed out|graceful.*timed out/.test(message.text())) {
      failures.push(message.text());
    }
  });
  await gotoMachine(page, "cage", { search: { memoryProfile: "constrained" } });
  await waitForMachineBootInput(page);
  const id = new URL(page.url()).searchParams.get("computer");
  expect(id).not.toBeNull();
  const realm = await memoryBoundaryRealmId(page);
  const display = page.locator(".kmachine-primary .kmodeset-surface");
  const owner = async () => Number(await display.getAttribute("data-kms-owner-pid"));
  for (let cycle = 0; cycle < 6; cycle++) {
    if (cycle > 0) {
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await bootStoredComputer(page, id!);
      // Why: the old machine can still say Running until asynchronous unload
      // starts. Observe this restart before accepting the next Running state.
      await expect(page.locator(".kmprogress-overlay")).toBeVisible({ timeout: 30_000 });
      await waitForMachineBootInput(page);
    }
    await expectTerminal(page, /WLTERM_READY/, 120_000);
    await openSurface(page, "Graphics");
    const canvas = canvasLocator(page);
    await expect.poll(() => chipText(page), { timeout: 120_000 }).toMatch(/webgl2-gl/i);
    await expect.poll(owner, { timeout: 60_000 }).toBeGreaterThan(0);
    // A small valid frame may compress below the old PNG-size heuristic.
    // Why: WLTERM_READY marks the first committed grid, before its shell has
    // necessarily loaded. Early keys can precede the PTY's initial setup.
    const mode = (await chipText(page)).match(/(\d+)×(\d+)/)!;
    await expect.poll(async () => cageShellTextColumns(page, await canvas.screenshot(),
      { width: Number(mode[1]), height: Number(mode[2]) }), { timeout: 60_000 }).toBeGreaterThan(24);
    const beforeWidth = (await canvas.boundingBox())!.width;
    const compositor = await owner();
    await page.setViewportSize(cycle % 2 === 0 ? { width: 1000, height: 720 } : { width: 1280, height: 800 });
    // Why: resizing changes the host viewport and preferred connector mode;
    // it does not force wlroots to modeset an already active CRTC.
    await expect.poll(async () => (await canvas.boundingBox())!.width,
      { timeout: 60_000 }).not.toBe(beforeWidth);
    expect(await owner()).toBe(compositor);
    await expect(page.getByRole("complementary", { name: "Download status" })).toBeHidden({ timeout: 60_000 });
    await canvas.focus();
    await expect(canvas).toBeFocused();
    const before = await canvas.screenshot();
    await typePhysicalText(page, `echo cage-cycle-${cycle}\n`, { delay: 40 });
    await expect.poll(async () => (await screenshotPixelDelta(page, before, await canvas.screenshot())).same,
      { timeout: 60_000 }).toBe(false);
    if (cycle % 2 === 1 && cycle < 5) continue;
    // Why: alternate restarts keep Cage and wlterm alive, exercising machine
    // teardown as well as client-driven release. The final cycle exits cleanly.
    await typePhysicalText(page, "exit\n", { delay: 40 });
    await expect.poll(owner, { timeout: 60_000 }).toBe(0);
    await expect(page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }))
      .toHaveAttribute("aria-current", "true", { timeout: 60_000 });
    await expect.poll(() => terminalText(page), { timeout: 60_000 }).toMatch(/WLTERM_EXIT code=0/);
    await page.locator(".kshell-host:visible .xterm").first().click();
    await typePhysicalText(page, `echo CAGE_STATUS_${cycle}=$?\n`, { delay: 40 });
    await expect.poll(() => terminalText(page), { timeout: 30_000 }).toMatch(new RegExp(`CAGE_STATUS_${cycle}=0(?:\\s|$)`));
  }
  expect(await memoryBoundaryRealmId(page)).toBe(realm);
  expect(await memoryBoundaryFailures(page)).toEqual([]);
  expect(failures).toEqual([]);
});


for (const density of [1, 2]) {
  test.describe(`Cage CSS display at browser density ${density}`, () => {
    test.use({
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: density,
      page: async ({ page, playwright, browserName, channel, launchOptions,
        contextOptions, baseURL, viewport, extraHTTPHeaders, proxy }, use, testInfo) => {
        if (density !== 2 || browserName === "webkit") { await use(page); return; }
        // The native device-pixel box is an independent input from context DPR.
        // Exercise it too, using the same launch scaling as the Sway checks.
        const browser = await playwright[browserName].launch({
          ...launchOptions, channel, headless: true,
          ...(browserName === "chromium" ? {
            args: [...(launchOptions.args ?? []), "--force-device-scale-factor=2"],
          } : {
            firefoxUserPrefs: { ...launchOptions.firefoxUserPrefs, "layout.css.devPixelsPerPx": "2.0" },
          }),
        });
        try {
          const context = await browser.newContext({
            ...contextOptions, baseURL, viewport, deviceScaleFactor: density, extraHTTPHeaders, proxy,
          });
          const nativePage = await context.newPage();
          try { await use(nativePage); }
          finally {
            if (testInfo.status !== testInfo.expectedStatus) {
              try { await testInfo.attach("native-density-page", {
                body: await nativePage.screenshot({ timeout: 5_000 }), contentType: "image/png",
              }); } catch (error) {
                testInfo.annotations.push({ type: "screenshot unavailable", description: String(error) });
              }
            }
          }
        } finally { await browser.close(); }
      },
    });
    test(`Cage uses its CSS pane size at browser density ${density}`, async ({ page, browserName }) => {
      test.setTimeout(240_000);
      await gotoMachine(page, "cage");
      await expectTerminal(page, /WLTERM_READY/, 120_000);
      await openSurface(page, "Graphics");
      const canvas = canvasLocator(page);
      await expect(canvas).toBeVisible({ timeout: 30_000 });
      const pixels = await canvas.evaluate(element => new Promise<{
        cssWidth: number; cssHeight: number; nativeWidth?: number; dpr: number;
      }>(resolve => {
        const observer = new ResizeObserver(([entry]) => {
          if (entry.contentRect.width < 1) return;
          observer.disconnect();
          resolve({ cssWidth: entry.contentRect.width, cssHeight: entry.contentRect.height,
            nativeWidth: entry.devicePixelContentBoxSize?.[0]?.inlineSize, dpr: devicePixelRatio });
        });
        observer.observe(element);
      }));
      expect(pixels.dpr).toBe(density);
      if (browserName !== "webkit") {
        expect(pixels.nativeWidth, "measure the actual native pixel box").toBeDefined();
        expect(pixels.nativeWidth! / pixels.cssWidth).toBeCloseTo(density, 1);
      }
      await expect.poll(() => chipText(page), { timeout: 120_000 }).toMatch(/webgl2-gl/i);
      const mode = (await chipText(page)).match(/([0-9]+)×([0-9]+)/)!;
      const output = { width: Number(mode[1]), height: Number(mode[2]) };
      console.log("CAGE_MODE_DENSITY", JSON.stringify({ browserName, density, ...pixels, guest: output }));
      expect(output.width).toBeGreaterThan(1280);
      expect(Math.abs(output.width - pixels.cssWidth)).toBeLessThanOrEqual(1);
      expect(Math.abs(output.height - pixels.cssHeight)).toBeLessThanOrEqual(1);
      await expect.poll(async () => cageShellTextColumns(page, await canvas.screenshot(), output),
        { timeout: 60_000 }).toBeGreaterThan(24);
      await expect(page.getByRole("complementary", { name: "Download status" }))
        .toBeHidden({ timeout: 60_000 });
      const width = (await canvas.boundingBox())!.width;
      await page.setViewportSize({ width: 2560, height: 1440 });
      await expect.poll(async () => (await canvas.boundingBox())!.width).not.toBe(width);
      // Host layout fits the active mode; changing the browser size must not
      // silently replace this live compositor's framebuffer or input grid.
      expect((await chipText(page)).match(/([0-9]+)×([0-9]+)/)![0]).toBe(mode[0]);
      await canvas.focus(); await expect(canvas).toBeFocused();
      const before = await canvas.screenshot();
      await page.keyboard.type("echo CAGE_CSS_GRID_OK\n", { delay: 40 });
      await expect.poll(async () => (await screenshotPixelDelta(page, before, await canvas.screenshot())).same,
        { timeout: 60_000 }).toBe(false);
      await page.keyboard.type("exit\n", { delay: 40 });
      await expectTerminal(page, /WLTERM_EXIT code=0/, 60_000);
    });
  });
}
