import { footFrame } from "./support/labwc-frame";
import { expect, test, type Page } from "@playwright/test";
import { gotoMachine, gotoMachineOrSkip, previewFrame } from "./support/kandelo-machine";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures, memoryBoundaryRealmId } from "./support/browser-memory-boundary";
import { QUAKE_ZIP_URL } from "../../../web-libs/kandelo-session/src/demo-guides";

async function launch(page: Page, title: string, profile: string): Promise<void> {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.locator(".kgal-row", {
    has: page.locator(".kgal-machine-title", { hasText: title }),
  }).getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`profile=${profile}(?:&|$)`), { timeout: 240_000 });
  expect(new URL(page.url()).searchParams.get("memoryProfile")).toBe("constrained");
  await expect(page.locator(".kmprogress-card")).toHaveCount(0, { timeout: 240_000 });
}

async function expectGameFrame(page: Page): Promise<void> {
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('[data-audio-active="true"]')).toHaveCount(1, { timeout: 180_000 });
  // Guest audio backpressure can block the first rendered frame. Activate
  // through the production control before waiting for pixels, as a user can.
  await expect.poll(async () => {
    const state = await page.locator('[data-audio-state]').getAttribute("data-audio-state");
    if (state !== "running" && await page.locator(".kpcm-audio-enable").isVisible()) {
      await page.locator(".kpcm-audio-enable").click();
    }
    return page.locator('[data-audio-state]').getAttribute("data-audio-state");
  }, { timeout: 30_000 }).toBe("running");
  await expect.poll(() => canvas.evaluate((el: HTMLCanvasElement) => {
    const bytes = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < bytes.length; i += 4) {
      colors.add((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
      if (colors.size > 8) break;
    }
    return colors.size;
  }), { timeout: 180_000 }).toBeGreaterThan(8);
}

async function leaveDetachedTmuxSession(page: Page, cycle: number): Promise<void> {
  const screen = () => page.locator(".xterm-rows:visible").textContent();
  const input = page.locator(".xterm-helper-textarea:visible");
  const command = async (text: string) => {
    await input.focus();
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };
  await expect.poll(screen, { timeout: 120_000 }).toMatch(/kandelo\$/);
  await command("tmux new-session -s memory");
  await expect.poll(screen, { timeout: 30_000 }).toContain("[memory]");
  await command(`printf 'TMUX_%s\\n' 'MEMORY_LEFT_${cycle}'`);
  await expect.poll(screen, { timeout: 20_000 }).toContain(`TMUX_MEMORY_LEFT_${cycle}`);
  await page.keyboard.press("Control+b");
  await page.keyboard.type("%");
  await command(`printf 'TMUX_%s\\n' 'MEMORY_RIGHT_${cycle}'`);
  await expect.poll(screen, { timeout: 20_000 }).toContain(`TMUX_MEMORY_RIGHT_${cycle}`);
  await page.keyboard.press("Control+b");
  await page.keyboard.type("d");
  await expect.poll(screen, { timeout: 10_000 }).toContain("[detached (from session memory)]");
  // Leave the real server and both pane shells alive. Switching machines
  // must release them through normal host teardown in this same page realm.
}

test("@slow games, cage, sway, labwc, tmux and WordPress survive repeated constrained-budget switches", async ({ page }) => {
  test.setTimeout(1_200_000);
  const required = process.env.KANDELO_MEMORY_SWITCH_REQUIRED === "1";
  // This follows the same external-data boundary as the Quake demo spec.
  const archive = await fetch(QUAKE_ZIP_URL, { method: "HEAD" }).catch(() => null);
  if (required) expect(archive?.ok, "required Quake shareware mirror unavailable").toBe(true);
  test.skip(!archive?.ok, "Quake shareware mirror unavailable");

  await installBrowserMemoryBoundaryProbe(page);
  const runtimeFailures: string[] = [];
  page.on("pageerror", error => runtimeFailures.push(error.message));
  page.on("console", message => {
    const failedRelease = /release acknowledgement timed out|retirement wake failed|incomplete graceful generation detach|graceful kernel-worker detach timed out|destroy drain timed out with woken process|force-terminating/;
    if (message.type() === "error" || failedRelease.test(message.text())) {
      runtimeFailures.push(message.text());
    }
  });
  const navigate = required ? gotoMachine : gotoMachineOrSkip;
  await navigate(page, "doom", { search: { memoryProfile: "constrained" } });
  expect(new URL(page.url()).searchParams.get("memoryProfile")).toBe("constrained");
  await expectGameFrame(page);
  // A new page, context, or crash-triggered reload would hide accumulation.
  // Install this after the initial boot's service-worker takeover completes.
  // history.pushState also emits framenavigated, and timeOrigin precision can
  // vary. This document token changes on a real navigation or crash reload.
  const realmId = await memoryBoundaryRealmId(page);
  for (let cycle = 0; cycle < 4; cycle++) {
    if (cycle > 0) await launch(page, "fbDOOM", "doom");
    await expectGameFrame(page);
    await launch(page, "Quake (software)", "quake");
    await expectGameFrame(page);
    await launch(page, "Freeciv", "freeciv");
    await expect(page.locator(".kmodeset-canvas")).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('[data-audio-active="true"]')).toHaveCount(1, { timeout: 180_000 });
    await expect.poll(async () => {
      if (await page.locator(".kpcm-audio-enable").isVisible()) await page.locator(".kpcm-audio-enable").click();
      return page.locator('[data-audio-state]').getAttribute("data-audio-state");
    }, { timeout: 60_000 }).toBe("running");
    await expect.poll(async () => Number(await page.locator(".kmodeset-surface").getAttribute("data-kms-present-count")),
      { timeout: 180_000 }).toBeGreaterThan(0);
    await launch(page, "LÖVE games", "love");
    const loveCanvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
    await expect(loveCanvas).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('[data-audio-active="true"]')).toHaveCount(1, { timeout: 180_000 });
    await expect.poll(async () => {
      if (await page.locator(".kpcm-audio-enable").isVisible()) await page.locator(".kpcm-audio-enable").click();
      return page.locator('[data-audio-state]').getAttribute("data-audio-state");
    }, { timeout: 60_000 }).toBe("running");
    const loveFlips = () => page.locator("body").innerText().then(text =>
      Number(text.match(/(\d+)\s*flips\s*·/i)?.[1] ?? -1));
    const initialFlips = await loveFlips();
    await expect.poll(loveFlips, { timeout: 60_000 }).toBeGreaterThan(initialFlips + 5);
    await launch(page, "cage kiosk", "cage");
    const cageCanvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
    await expect(cageCanvas).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => page.locator(".kdemo-surface-controls").allTextContents()
      .then(text => text.join(" ")), { timeout: 180_000 }).toMatch(/webgl2-gl/);
    await expect.poll(async () => (await cageCanvas.screenshot()).byteLength,
      { timeout: 120_000 }).toBeGreaterThan(8_000);
    const beforeInput = await cageCanvas.screenshot();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.type(`printf 'CAGE_MEMORY_${cycle}\\n'\n`, { delay: 20 });
    await expect.poll(async () => (await cageCanvas.screenshot()).equals(beforeInput),
      { timeout: 60_000 }).toBe(false);
    // Leave the compositor and terminal alive. The next launch must retire
    // their pending flips, GL context, imported buffers and process memories.
    await launch(page, "sway tiling desktop", "sway");
    const swayCanvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
    await expect(swayCanvas).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => page.locator(".kdemo-surface-controls").allTextContents()
      .then(text => text.join(" ")), { timeout: 180_000 }).toMatch(/webgl2-gl/);
    // Wait for the actual foot tile, rather than accepting sway's wallpaper
    // before its client loads. The full sway consumer spec checks tiling,
    // input and bar behavior; here the live session must survive teardown.
    await expect.poll(async () => {
      const png = await swayCanvas.screenshot();
      return page.evaluate(async encoded => {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = surface.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        const { data } = context.getImageData(Math.floor(bitmap.width / 4),
          Math.floor(bitmap.height / 4), Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2));
        bitmap.close();
        const mean = [0, 0, 0];
        for (let i = 0; i < data.length; i += 4) {
          for (let channel = 0; channel < 3; channel++) mean[channel] += data[i + channel];
        }
        const [r, g, b] = mean.map(value => value / (data.length / 4));
        return r > 20 && r < 60 && Math.abs(r - g) < 8 && Math.abs(r - b) < 8;
      }, png.toString("base64"));
    }, { timeout: 180_000 }).toBe(true);
    // Leave sway, foot and the status-command/bar children alive too, so the
    // next switch must retire the whole session in the same browser realm.
    await launch(page, "labwc stacking desktop", "labwc");
    await expect(page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first())
      .toBeVisible({ timeout: 180_000 });
    await expect.poll(() => page.locator(".kdemo-surface-controls").allTextContents()
      .then(text => text.join(" ")), { timeout: 180_000 }).toMatch(/webgl2-gl/);
    await expect.poll(async () => {
      const frame = await footFrame(page);
      return frame.foot !== null && frame.ink > 200;
    }, { timeout: 180_000 }).toBe(true);
    const floating = await footFrame(page);
    const floatingBox = (await page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first().boundingBox())!;
    await page.mouse.click(
      floatingBox.x + (floating.foot!.x + floating.foot!.width / 2) * floatingBox.width / floating.width,
      floatingBox.y + (floating.foot!.y + floating.foot!.height / 2) * floatingBox.height / floating.height,
    );
    // Only execution in the real terminal paints the ANSI red background;
    // echoing the typed command or a blinking cursor cannot satisfy this.
    await page.keyboard.type(`printf '\\033[41mLABWC_MEMORY_${cycle}\\033[0m\\n'\n`, { delay: 20 });
    await expect.poll(async () => (await footFrame(page)).red,
      { timeout: 60_000 }).toBeGreaterThan(200);
    // Retire the live stacking compositor and its real terminal as well.
    // Keep all cycles in this same page realm and the existing memory budget.
    await launch(page, "Bare shell", "shell");
    await leaveDetachedTmuxSession(page, cycle);
    await launch(page, "WordPress MariaDB", "wordpress-mariadb");
    await expect(previewFrame(page, "WordPress MariaDB").locator("body"))
      .toContainText(/Hello world/i, { timeout: 240_000 });
    // PHP-FPM can answer with its first child before the static pool finishes
    // forking. Keep the site alive through that remaining startup interval.
    await page.waitForTimeout(3_000);
    await expect(previewFrame(page, "WordPress MariaDB").locator("body"))
      .toContainText(/Hello world/i);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
    expect(runtimeFailures).toEqual([]);
    expect(await memoryBoundaryRealmId(page),
      "demo switching must preserve the original browser realm").toBe(realmId);
  }
});
