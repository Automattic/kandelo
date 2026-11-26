import { expect, type Page } from "../playwright-test";
// Why: machine setup opens the OPFS computer library before starting Cage;
// WebKit's ephemeral context cannot exercise that storage-backed boot path.
import { test } from "./support/persistent-page";

import { gotoMachine, waitForMachineBootInput } from "./support/kandelo-machine";
import { cageShellTextColumns } from "./support/cage-shell-frame";
import { screenshotPixelDelta } from "./support/screenshot-pixels";
import { setInternalsOpen } from "./support/dock";
import { configureNewComputer } from "./support/computer-library";
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

/** The launching shell's terminal, including the actual foreground exit status. */
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

test.use({ headless: true });

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

/** Wait for the real Foot and its Bash child before checking rendered output. */
async function waitForFoot(page: Page): Promise<number[]> {
  await openSurface(page, "Internals");
  await page.getByRole("tab", { name: "Procs", exact: true }).click();
  let pids: number[] = [];
  await expect.poll(async () => {
    const rows = await page.locator(".ktable tbody tr").evaluateAll(elements => elements.flatMap(row => {
      const cells = row.querySelectorAll("td");
      return cells.length === 5 ? [{
        pid: Number(cells[0].textContent?.match(/\d+/)?.[0]),
        ppid: Number(cells[1].textContent), command: cells[4].textContent ?? "",
      }] : [];
    }));
    const foot = rows.filter(row => /^(?:\/\S*\/)?foot(?:\s|$)/.test(row.command));
    const shell = rows.find(row => row.ppid === foot[0]?.pid && /^(?:-?(?:\/\S*\/)?(?:bash|sh))(?:\s|$)/.test(row.command));
    if (foot.length !== 1 || !shell) return false;
    pids = [foot[0].pid, shell.pid];
    return true;
  }, { timeout: 120_000 }).toBe(true);
  return pids;
}

async function expectCleanCageExit(page: Page, marker: string, children: number[]) {
  const surface = page.locator(".kmachine-primary .kmodeset-surface");
  await expect(surface).toHaveAttribute("data-kms-owner-pid", "0", { timeout: 60_000 });
  await expect(page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }))
    .toHaveAttribute("aria-current", "true", { timeout: 60_000 });
  await page.locator(".kshell-host:visible .xterm").first().click();
  await typePhysicalText(page, `echo ${marker}=$?\n`, { delay: 40 });
  await expectTerminal(page, new RegExp(`${marker}=0(?:\\s|$)`), 30_000);
  await openSurface(page, "Internals");
  await page.getByRole("tab", { name: "Procs", exact: true }).click();
  // Loading/empty tables cannot establish that the graphical processes retired.
  await expect.poll(async () => page.locator(".ktable tbody tr td:first-child").evaluateAll(
    cells => cells.filter(cell => Number(cell.textContent?.match(/\d+/)?.[0]) === 1).length,
  ), { timeout: 30_000 }).toBe(1);
  await expect(page.locator(".ktable tbody tr > td:last-child").filter({ hasText: /^(?:\/\S*\/)?(?:cage|foot)(?:\s|$)/ }))
    .toHaveCount(0, { timeout: 60_000 });
  await expect.poll(async () => page.locator(".ktable tbody tr td:first-child").evaluateAll(
    (cells, children) => cells.filter(cell => children.includes(Number(cell.textContent?.match(/\d+/)?.[0]))).length,
    children,
  ), { timeout: 60_000 }).toBe(0);
}

/** Normal image, GLES pixels, idle/input behavior, real shell exit and cleanup. */
test("Kandelo cage renders a Foot session with wlroots' GLES2 renderer", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoMachine(page, "cage");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running .*\/usr\/bin\/cage/);
  expect(await syslogText(page)).not.toMatch(/configured command failed/);

  // Gate 1: real Foot and child shell.
  const children = await waitForFoot(page);

  // Gate 2.
  await openSurface(page, "Graphics");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => chipText(page), { timeout: 30_000 })
    .toMatch(/webgl2-gl/i);

  // Gate 3. PNG size varies with mode and browser encoder; prove real shell
  // pixels with the configured Foot font.
  // Process creation precedes the prompt; wait for actual shell pixels
  // before testing idle stability.
  const mode = (await chipText(page)).match(/(\d+)×(\d+)/);
  expect(mode, "the Modeset chip reports the connector mode").not.toBeNull();
  const output = { width: Number(mode![1]), height: Number(mode![2]) };
  await expect.poll(
    async () => cageShellTextColumns(page, await canvas.screenshot(), output),
    { timeout: 60_000, message: "Foot has rendered the shell's first output" },
  ).toBeGreaterThan(24);
  // Browser focus must not inject a guest click and change Foot or
  // compositor state before the typing-only framebuffer assertion.
  await canvas.focus();
  await expect(canvas).toBeFocused();
  // Locator screenshots include DOM overlays above the canvas. The initial
  // lazy-download toasts can finish after the shell prompt is painted; their
  // disappearance is not a change in Foot's framebuffer.
  await expect(page.getByRole("complementary", { name: "Download status" }))
    .toBeHidden({ timeout: 60_000 });
  const frame = () => canvas.screenshot({ animations: "disabled" });
  const before = await frame();
  await page.waitForTimeout(1_000);
  const idleDelta = await screenshotPixelDelta(page, before, await frame());
  expect(idleDelta, "Foot's rendered pixels remain unchanged while idle").toMatchObject({ same: true, changed: 0 });
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
  await expectCleanCageExit(page, "CAGE_EXIT_STATUS", children);
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
  let id = new URL(page.url()).searchParams.get("computer");
  expect(id, "desktop uses the normal computer store").toMatch(/^[0-9a-f-]{36}$/);
  const realm = await memoryBoundaryRealmId(page);
  const display = page.locator(".kmachine-primary .kmodeset-surface");
  const owner = async () => Number(await display.getAttribute("data-kms-owner-pid"));
  for (let cycle = 0; cycle < 6; cycle++) {
    if (cycle > 0) {
      await configureNewComputer(page, "cage");
      await expect(page.getByRole("radio", { name: "Temporary", exact: true })).toBeChecked();
      await page.getByRole("button", { name: "Create and boot", exact: true }).click();
      // Why: the old machine can still say Running until asynchronous unload
      // starts. Observe this restart before accepting the next Running state.
      await expect(page.locator(".kmprogress-overlay")).toBeVisible({ timeout: 30_000 });
      await waitForMachineBootInput(page);
      await expect.poll(() => {
        const next = new URL(page.url()).searchParams.get("computer");
        return next !== id && /^[0-9a-f-]{36}$/.test(next ?? "");
      }, { timeout: 240_000 }).toBe(true);
      id = new URL(page.url()).searchParams.get("computer");
    }
    const children = await waitForFoot(page);
    await openSurface(page, "Graphics");
    const canvas = canvasLocator(page);
    await expect.poll(() => chipText(page), { timeout: 120_000 }).toMatch(/webgl2-gl/i);
    await expect.poll(owner, { timeout: 60_000 }).toBeGreaterThan(0);
    // A small valid frame may compress below the old PNG-size heuristic.
    // Why: Foot and Bash can exist before the first prompt is rendered.
    // Early keys can precede the PTY's initial setup.
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
    // Why: alternate restarts keep Cage and Foot alive, exercising machine
    // teardown as well as client-driven release. The final cycle exits cleanly.
    await typePhysicalText(page, "exit\n", { delay: 40 });
    await expect.poll(owner, { timeout: 60_000 }).toBe(0);
    await expect(page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }))
      .toHaveAttribute("aria-current", "true", { timeout: 60_000 });
    await expectCleanCageExit(page, `CAGE_STATUS_${cycle}`, children);
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
      const children = await waitForFoot(page);
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
      await expectCleanCageExit(page, "CAGE_EXIT_STATUS", children);
    });
  });
}
