import { expect, type Page } from "@playwright/test";
import { test } from "./support/persistent-page";
import { gotoMachine, gotoMachineOrSkip, previewFrame } from "./support/kandelo-machine";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures, memoryBoundaryRealmId } from "./support/browser-memory-boundary";
import { QUAKE_ZIP_URL } from "../../../web-libs/kandelo-session/src/demo-guides";
import { expectRunningMachineAudio } from "./support/machine-audio";
import { configureNewComputer, currentComputerMetadata } from "./support/computer-library";

async function launch(page: Page, title: string, profile: string): Promise<void> {
  await configureNewComputer(page, profile);
  await page.getByLabel("Computer name", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Create and boot", exact: true }).click();
  await expect(page).toHaveURL(/computer=[0-9a-f-]{36}(?:&|$)/, { timeout: 240_000 });
  await expect.poll(async () => (await currentComputerMetadata(page)).profileId, { timeout: 240_000 }).toBe(profile);
  expect(new URL(page.url()).searchParams.get("memoryProfile")).toBe("constrained");
  await expect(page.locator(".kmprogress-card")).toHaveCount(0, { timeout: 240_000 });
}

async function expectGameFrame(page: Page): Promise<void> {
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('[data-audio-active="true"]')).toHaveCount(1, { timeout: 180_000 });
  await expectRunningMachineAudio(page);
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

test("@slow framebuffer games, Freeciv, LÖVE, tmux and WordPress survive repeated constrained-budget switches", async ({ page }) => {
  test.setTimeout(900_000);
  const required = process.env.KANDELO_MEMORY_SWITCH_REQUIRED === "1";
  // This follows the same external-data boundary as the Quake demo spec.
  const archive = await fetch(QUAKE_ZIP_URL, { method: "HEAD" }).catch(() => null);
  if (required) expect(archive?.ok, "required Quake shareware mirror unavailable").toBe(true);
  test.skip(!archive?.ok, "Quake shareware mirror unavailable");

  await installBrowserMemoryBoundaryProbe(page);
  const runtimeFailures: string[] = [];
  page.on("pageerror", error => runtimeFailures.push(error.message));
  page.on("console", message => {
    const failedRelease = /release acknowledgement timed out|retirement wake failed|incomplete graceful generation detach|graceful kernel-worker detach timed out/;
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
    await expectRunningMachineAudio(page, 60_000);
    await expect.poll(async () => Number(await page.locator(".kmodeset-surface").getAttribute("data-kms-present-count")),
      { timeout: 180_000 }).toBeGreaterThan(0);
    await launch(page, "LÖVE games", "love");
    const loveCanvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
    await expect(loveCanvas).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('[data-audio-active="true"]')).toHaveCount(1, { timeout: 180_000 });
    await expectRunningMachineAudio(page, 60_000);
    const loveFlips = () => page.locator("body").innerText().then(text =>
      Number(text.match(/(\d+)\s*flips\s*·/i)?.[1] ?? -1));
    const initialFlips = await loveFlips();
    await expect.poll(loveFlips, { timeout: 60_000 }).toBeGreaterThan(initialFlips + 5);
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
