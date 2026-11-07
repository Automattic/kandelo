import { setInternalsOpen } from "./support/dock";
import { expect, test, type Page } from "../playwright-test";
import { gotoMachine, waitForMachineBootInput } from "./support/kandelo-machine";
import { typePhysicalText } from "./support/physical-typing";
import { runTerminalCommand } from "./support/terminal-command";
import { painted, isLauncher, type Rect } from "./support/scummvm-paint";

test.use({ headless: true });

const canvas = (page: Page) => page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
const owner = async (page: Page) => Number(await page.locator(".kmachine-primary .kmodeset-surface")
  .getAttribute("data-kms-owner-pid"));

async function showDemo(page: Page) {
  await waitForMachineBootInput(page);
  await setInternalsOpen(page, false);
  const demo = page.getByLabel("Computer views").getByRole("button", { name: "Graphics", exact: true });
  if ((await demo.getAttribute("aria-current")) !== "true") await demo.click();
  await expect(canvas(page)).toBeVisible();
}

test.describe("ScummVM's ordinary Wayland GLES launcher inside Sway", () => {
  test.use({ deviceScaleFactor: 1, viewport: { width: 1440, height: 1000 } });

  test("paints the launcher, handles its dialog and quits without taking the compositor's DRM master", async ({ page }) => {
    test.setTimeout(480_000);
    await gotoMachine(page, "sway");
    await showDemo(page);
    await expect.poll(async () => (await page.locator(".kdemo-surface-controls").allInnerTexts()).join(" "),
      { timeout: 180_000 }).toMatch(/webgl2-gl/i);
    await expect.poll(async () => {
      const p = await painted(page); return p.footPixels / (p.width * p.height);
    }, { timeout: 180_000, intervals: [1_000] }).toBeGreaterThan(0.5);
    const swayOwner = await owner(page);
    expect(swayOwner).toBeGreaterThan(0);

    // Ordinary wrapper chooses Wayland from the actual inherited compositor
    // socket. No SDL/GL driver overrides or test-created theme/config files.
    // This real interactive shell waits for the exact wrapper PID, then saves
    // its exit status and the post-wait process table. Echoed input cannot
    // manufacture these files. Existing bug: failed graphics setup exits 0,
    // which is why rendered launcher/dialog assertions precede status checks.
    await canvas(page).click({ position: { x: 100, y: 140 } });
    await typePhysicalText(page, "/usr/bin/scummvm & launch=$!; wait $launch; result=$?; "
      + "printf '%s\\n' $result > /tmp/scumm-sway-result; "
      + "test ! -d /proc/$launch && echo reaped > /tmp/scumm-sway-wrapper; "
      + "ps -A -o pid,comm > /tmp/scumm-sway-processes\n", { delay: 30 });

    await expect.poll(async () => isLauncher(await painted(page)),
      { timeout: 180_000, intervals: [1_000] }).toBe(true);
    expect(await owner(page)).toBe(swayOwner);
    const launcher = await painted(page);
    await test.info().attach("scummvm-wayland-launcher", { body: await canvas(page).screenshot(), contentType: "image/png" });

    // Click the actual painted About button, avoiding guessed fixed
    // coordinates or a shortcut that Search might consume. The shipped
    // highres_layout.stx declares two Launcher layouts and ScummVM picks
    // one from its window's shape. Sway tiles the launcher beside Foot, so
    // on a landscape output each tile, and with it ScummVM's window, is
    // portrait. The landscape layout (`resolution = 'y<=x'`) puts About
    // immediately above Quit at the bottom of its right button column. The
    // portrait layout (`resolution = 'y>x'`) puts Quit, About, Global
    // Options and Start in one row below the Load/Add/Edit/Remove row;
    // with no games added, only Quit, About and Global Options are enabled
    // (dark red) there, Add Game alone is enabled above, and Help sits alone
    // below. The About dialog does not dim the launcher (the theme declares
    // no shading for it) and its pale credits pane can sit over the pale
    // game list, so require what only the dialog paints: its own dark-red
    // Close button, a button the launcher did not have. A cursor, a hover
    // highlight or a tooltip cannot add one.
    const actionButtons = launcher.buttons.filter(r => r.width >= 40 && r.height <= 65);
    let about: Rect;
    if (launcher.orange.width > launcher.orange.height) {
      const rightButtons = actionButtons.filter(r => r.x > launcher.orange.x + launcher.orange.width * 0.65)
        .sort((a, b) => a.y - b.y);
      expect(rightButtons.length).toBeGreaterThanOrEqual(3);
      about = rightButtons.at(-2)!;
    } else {
      const rows: Rect[][] = [];
      for (const button of [...actionButtons].sort((a, b) => a.y - b.y)) {
        const row = rows.find(r => Math.abs(r[0].y - button.y) <= 4);
        if (row) row.push(button); else rows.push([button]);
      }
      const quitRow = rows.filter(row => row.length >= 3).at(-1);
      expect(quitRow, "portrait launcher row with Quit, About and Global Options").toBeDefined();
      about = quitRow!.sort((a, b) => a.x - b.x)[1];
    }
    // The terminal click above captured the browser pointer. A locked
    // pointer reports only relative movement, and each engine derives a
    // synthetic absolute move's delta differently: Chromium from the
    // previous position, Firefox from the point it re-centres the hidden
    // cursor on. An absolute target is only meaningful uncaptured, so
    // release capture as other absolute-input checks do, without sending
    // the Escape key to the focused ScummVM window.
    await page.evaluate(() => { if (document.pointerLockElement) document.exitPointerLock(); });
    await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
    const box = (await canvas(page).boundingBox())!;
    await canvas(page).click({ position: {
      x: (about.x + about.width / 2) * box.width / launcher.width,
      y: (about.y + about.height / 2) * box.height / launcher.height,
    } });
    const near = (a: Rect, b: Rect) => Math.abs(a.x - b.x) <= 4 && Math.abs(a.y - b.y) <= 4
      && Math.abs(a.width - b.width) <= 4 && Math.abs(a.height - b.height) <= 4;
    await expect.poll(async () => {
      const p = await painted(page);
      return p.buttons.some(r => r.width >= 40 && r.height <= 65
        && !launcher.buttons.some(old => near(old, r)));
    }, { timeout: 60_000, intervals: [500, 1_000] }).toBe(true);
    expect(await owner(page)).toBe(swayOwner);
    await test.info().attach("scummvm-wayland-about", { body: await canvas(page).screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect.poll(async () => isLauncher(await painted(page)), { timeout: 60_000 }).toBe(true);

    // DefaultEventManager's POSIX global keymap maps Ctrl+Q to EVENT_QUIT.
    // Cooperative application Quit, not a kill/interrupt/compositor close.
    // Hold Control across the Q press as a person does: ScummVM's SDL event
    // source reads modifiers from SDL_GetModState() when it polls, not from
    // the key event (backends/events/sdl/sdl2-events.cpp handleKeyDown), so
    // a chord whose Control release is already queued at that poll arrives
    // as a plain Q. Playwright's "Control+KeyQ" sends all four transitions
    // at once.
    await page.keyboard.down("Control");
    await page.waitForTimeout(300);
    await page.keyboard.press("KeyQ", { delay: 300 });
    await page.keyboard.up("Control");
    await expect.poll(async () => {
      const p = await painted(page); return p.footPixels / (p.width * p.height);
    }, { timeout: 90_000, intervals: [1_000] }).toBeGreaterThan(0.5);
    expect(await owner(page), "ScummVM never becomes the KMS owner").toBe(swayOwner);
    await canvas(page).click({ position: { x: 100, y: 140 } });
    await typePhysicalText(page, "swaymsg exit\n", { delay: 40 });
    await expect.poll(() => owner(page), { timeout: 60_000 }).toBe(0);
    await expect(page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }))
      .toHaveAttribute("aria-current", "true", { timeout: 60_000 });

    // Capture $? in the launching shell itself before any probe child runs.
    await page.locator(".kshell-terminal-slot:not([hidden]) .xterm-screen").click();
    await typePhysicalText(page, 'printf "SWAY_STATUS:%s\\n" "$?"\n', { delay: 30 });
    await expect.poll(() => page.locator(".kshell-terminal-slot:not([hidden]) .xterm-rows").innerText(),
      { timeout: 30_000 }).toContain("SWAY_STATUS:0");
    const report = await runTerminalCommand(page,
      "printf 'SCUMM_STATUS:'; cat /tmp/scumm-sway-result; "
      + "printf 'WRAPPER:'; cat /tmp/scumm-sway-wrapper; "
      + "cat /tmp/scumm-sway-processes");
    expect(report.output).toMatch(/SCUMM_STATUS:0\s*WRAPPER:reaped/);
    expect(report.output, "engine and exact waited wrapper are reaped while Sway was still alive").not.toContain("scummvm");
    await expect.poll(async () => (await runTerminalCommand(page, "ps -A -o pid,comm")).output,
      { timeout: 60_000, intervals: [500, 1_000] },
    ).not.toMatch(/scummvm|\/sway(?:bar|bg)?\b|\/foot\b/);
    expect(await owner(page)).toBe(0);
  });
});
