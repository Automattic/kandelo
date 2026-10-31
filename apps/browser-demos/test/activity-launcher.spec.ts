import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { test } from "./support/persistent-page";
import { machineUrl, previewFrame } from "./support/kandelo-machine";
import { currentComputerMetadata } from "./support/computer-library";
import { runTerminalCommand } from "./support/terminal-command";

test.use({ actionTimeout: 30_000 });

async function ready(page: Page) {
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 }).toMatch(/kandelo(?:-bash-[0-9.]+)?\$ ?/);
}

test("dock launches and replaces local activities without signalling or changing the saved computer", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let signallingRequests = 0;
  await page.route(/signalling/, async route => { signallingRequests++; await route.abort(); });
  await page.goto(await machineUrl(page, "shell"));
  await ready(page);
  const originalUrl = page.url();
  const originalMetadata = await currentComputerMetadata(page);
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const panel = page.getByRole("region", { name: "Installed activities" });
  await expect(panel.getByRole("button", { name: "Apps & tools", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator("[data-local-activity]")).toHaveCount(0);
  await expect(panel.locator('[data-image-activity="doom"]')).toBeVisible();
  const rows = panel.getByRole("list", { name: "Apps & tools", exact: true }).getByRole("listitem");
  const bounds = await rows.evaluateAll(elements => elements.slice(0, 2).map(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, height: rect.height };
  }));
  expect(bounds).toHaveLength(2);
  expect(bounds[1].y).toBeGreaterThanOrEqual(bounds[0].y + bounds[0].height - 1);
  expect(Math.abs(bounds[1].x - bounds[0].x)).toBeLessThan(1);
  await expect(panel.getByRole("button", { name: "All", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Set up a network session", exact: true })).toHaveCount(0);
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/compact-activities-${testInfo.project.name}.png`) });
  await panel.getByLabel("Find activities", { exact: true }).fill("no such app");
  await expect(panel).toContainText("No activities match.");
  await panel.getByRole("button", { name: "Group activities", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Group activities", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByLabel("Find activities", { exact: true })).toHaveValue("");
  await expect(panel.locator("[data-image-activity]")).toHaveCount(0);
  await expect(panel.locator('[data-local-activity="termchat/chat"]')).toBeVisible();
  await expect(panel.getByRole("button", { name: "Set up a network session", exact: true })).toBeEnabled();
  await panel.getByLabel("Find activities", { exact: true }).fill("Terminal chat");
  await expect(panel.locator("[data-local-activity]")).toHaveCount(1);
  await panel.getByRole("button", { name: "Start", exact: true }).click();
  await expect(panel.getByRole("form", { name: "Host activity" }).getByLabel("Activity", { exact: true })).toHaveValue("termchat/chat");
  await panel.getByRole("button", { name: "← Group activities", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/compact-activities-mobile-${testInfo.project.name}.png`) });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(panel.getByRole("button", { name: "Start locally", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Apps & tools", exact: true }).click();
  await panel.getByLabel("Find activities", { exact: true }).fill("node");
  const node = panel.locator('[data-image-activity="node"]');
  const title = await node.locator("h4").innerText();
  await node.getByRole("button", { name: "Start", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("tab", { name: "TTY1", exact: true }).click();
  await runTerminalCommand(page, "ps -A | grep '[n]ode' >/dev/null && printf '%s%s\\n' LOCAL_ACTIVITY_ RUNNING", "LOCAL_ACTIVITY_RUNNING");
  expect(page.url()).toBe(originalUrl);
  expect(await currentComputerMetadata(page)).toMatchObject(originalMetadata);
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  await panel.getByLabel("Find activities", { exact: true }).fill("node");
  await node.getByRole("button", { name: "Start", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await expect(page.getByRole("tab", { name: title, exact: true })).toHaveCount(1);
  await page.getByRole("tab", { name: "TTY1", exact: true }).click();
  await runTerminalCommand(page, "test \"$(ps -A | grep -c '[n]ode')\" -eq 1 && printf '%s%s\\n' LOCAL_REPLACEMENT_ OK", "LOCAL_REPLACEMENT_OK");
  await expect(page.getByRole("button", { name: "Network session: not connected", exact: true })).toBeVisible();
  expect(signallingRequests).toBe(0);
  expect(errors).toEqual([]);
});

test("ScummVM can replace its game and hand graphics to Freeciv on the same computer", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(await machineUrl(page, "shell"));
  await ready(page);
  const originalUrl = page.url();
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const panel = page.getByRole("region", { name: "Installed activities" });
  await panel.locator('[data-image-activity="scummvm"]').getByRole("button", { name: "Start", exact: true }).click();
  await expect(panel).not.toBeVisible();
  const display = page.locator(".kmodeset-surface");
  await expect(display).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => Number(await display.getAttribute("data-kms-present-count")), { timeout: 120_000 }).toBeGreaterThan(0);
  const initialOwner = await display.getAttribute("data-kms-owner-pid");
  await page.requestGC();
  await page.getByTestId("kms-dock-action-freeware").click();
  await page.getByTestId("kms-dock-menu-entry-mystery-house").click();
  await expect.poll(async () => ({
    status: await page.locator(".kdock-status-text").getAttribute("data-status"),
    owner: await display.getAttribute("data-kms-owner-pid"),
  }), { timeout: 180_000 }).toMatchObject({ status: "running", owner: expect.stringMatching(/^[1-9]\d*$/) });
  await expect(display).not.toHaveAttribute("data-kms-owner-pid", initialOwner!);
  await expect(page.getByTestId("kms-dock-action-progress")).toHaveCount(0, { timeout: 180_000 });
  await expect(page.getByTestId("kms-dock-action-error")).toHaveCount(0);
  const gameOwner = await display.getAttribute("data-kms-owner-pid");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("tab", { name: "ScummVM", exact: true }).click();
  await expect(page.locator(".kshell-terminal-slot:not([hidden]) .xterm-rows")).toContainText("/usr/local/bin/scummvm-play mystery-house");
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  await panel.locator('[data-image-activity="freeciv"]').getByRole("button", { name: "Start", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await expect(display).toBeVisible({ timeout: 120_000 });
  await expect(display).not.toHaveAttribute("data-kms-owner-pid", gameOwner!);
  await expect(display).not.toHaveAttribute("data-kms-owner-pid", "0");
  expect(page.url()).toBe(originalUrl);
  expect(errors).toEqual([]);
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/scummvm-freeciv-${testInfo.project.name}.png`) });
});

test("image workspaces start without restarting or changing the saved computer's boot selection", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto(await machineUrl(page, "shell"));
  await ready(page);
  const originalUrl = page.url();
  const original = await currentComputerMetadata(page);
  await runTerminalCommand(page, "printf 'launcher-disk\\n' > /home/projects/launcher-note; sync && printf '%s%s\\n' LAUNCHER_DISK_ SAVED", "LAUNCHER_DISK_SAVED");
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const panel = page.getByRole("region", { name: "Installed activities" });
  await panel.getByRole("button", { name: "Apps & tools", exact: true }).click();
  await expect(panel.locator("[data-local-activity]")).toHaveCount(0);
  await panel.getByLabel("Find activities", { exact: true }).fill("node");
  await expect(panel.getByRole("button", { name: /Restart/ })).toHaveCount(0);
  await panel.locator('[data-image-activity="node"]').getByRole("button").click();
  await expect(panel).not.toBeVisible({ timeout: 120_000 });
  await ready(page);
  expect(page.url()).toBe(originalUrl);
  expect(await currentComputerMetadata(page)).toMatchObject(original);
  await page.getByRole("tab", { name: "TTY1", exact: true }).click();
  await runTerminalCommand(page, "test \"$(cat /home/projects/launcher-note)\" = launcher-disk && printf '%s%s\\n' LAUNCHER_RESTART_ OK", "LAUNCHER_RESTART_OK");
  await page.reload();
  await ready(page);
  expect((await currentComputerMetadata(page)).profileId).toBe(original.profileId);
  await runTerminalCommand(page, "test \"$(cat /home/projects/launcher-note)\" = launcher-disk && printf '%s%s\\n' LAUNCHER_RELOAD_ OK", "LAUNCHER_RELOAD_OK");
});

test("WordPress activity opens its running service without restarting its database or computer", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto(await machineUrl(page, "wordpress-mariadb"));
  await expect(previewFrame(page, "WordPress MariaDB").locator("body")).toContainText(/Hello world|WordPress on Kandelo/i, { timeout: 240_000 });
  const originalUrl = page.url();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const databaseBefore = await runTerminalCommand(page, "ps -A | grep '[m]ariadbd' | awk '{print $1}'");
  expect(databaseBefore.output.trim()).toMatch(/^\d+$/);
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const panel = page.getByRole("region", { name: "Installed activities" });
  await panel.getByRole("button", { name: "Group activities", exact: true }).click();
  await expect(panel.locator("[data-image-activity]")).toHaveCount(0);
  const sharedService = panel.locator('[data-local-activity="lamp/service"], [data-local-activity="wordpress-family-vfs/service"]');
  await expect(sharedService).toBeVisible();
  await expect(sharedService.getByRole("button", { name: "Start locally", exact: true })).toHaveCount(0);
  await sharedService.getByRole("button", { name: "Start", exact: true }).click();
  const invite = panel.getByRole("form", { name: "Host activity" });
  await expect(invite.getByLabel("Activity", { exact: true })).toHaveValue(/^(lamp|wordpress-family-vfs)\/service$/);
  await expect(invite.getByRole("button", { name: "Show join link", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "← Group activities", exact: true }).click();
  await panel.getByRole("button", { name: "Apps & tools", exact: true }).click();
  await expect(panel.locator('[data-image-activity="wordpress-mariadb"]')).toBeVisible();
  await expect(panel.getByRole("button", { name: /Restart/ })).toHaveCount(0);
  await panel.locator('[data-image-activity="wordpress-mariadb"]').getByRole("button", { name: /^(Start|Open)$/ }).click();
  await expect(panel).not.toBeVisible();
  await expect(previewFrame(page, "WordPress MariaDB").locator("body")).toContainText(/Hello world|WordPress on Kandelo/i, { timeout: 120_000 });
  expect(page.url()).toBe(originalUrl);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const databaseAfter = await runTerminalCommand(page, "ps -A | grep '[m]ariadbd' | awk '{print $1}'");
  expect(databaseAfter.output.trim()).toBe(databaseBefore.output.trim());
});

test("a plain shell discovers a command-line KMS program without selecting a graphics profile", async ({ page }) => {
  test.setTimeout(240_000);
  const kernels: string[] = [];
  page.on("worker", worker => { if (worker.url().includes("browser-kernel-worker-entry")) kernels.push(worker.url()); });
  await page.goto(await machineUrl(page, "shell"));
  await ready(page);
  const original = await currentComputerMetadata(page);
  const kernelCount = kernels.length;
  expect(kernelCount).toBe(1);
  await expect(page.getByRole("button", { name: "Graphics", exact: true })).toBeDisabled();
  const terminal = page.locator(".kshell-host:visible .xterm-helper-textarea");
  await terminal.focus();
  await page.keyboard.insertText("/usr/local/bin/modeset");
  await page.keyboard.press("Enter");
  const surface = page.locator(".kmodeset-surface");
  await expect(surface).toBeVisible({ timeout: 120_000 });
  await expect(surface).not.toHaveAttribute("data-kms-owner-pid", "0");
  await expect.poll(async () => Number(await surface.getAttribute("data-kms-present-count")), { timeout: 120_000 }).toBeGreaterThan(2);
  expect(kernels).toHaveLength(kernelCount);
  expect(await currentComputerMetadata(page)).toMatchObject(original);
});

test("graphical image activities switch between KMS and framebuffer without rebooting or closing independent activities", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const kernels: string[] = [];
  const errors: string[] = [];
  page.on("worker", worker => { if (worker.url().includes("browser-kernel-worker-entry")) kernels.push(worker.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(await machineUrl(page, "shell"));
  await ready(page);
  const originalUrl = page.url();
  const original = await currentComputerMetadata(page);
  const kernelCount = kernels.length;
  expect(kernelCount).toBe(1);
  await runTerminalCommand(page, "printf '%s\\n' \"$PPID\" > /home/projects/activity-shell-pid; printf 'live-activity\\n' > /home/projects/live-activity-note; sync && printf '%s%s\\n' LIVE_NOTE_ SAVED", "LIVE_NOTE_SAVED");
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const panel = page.getByRole("region", { name: "Installed activities" });
  await panel.locator('[data-image-activity="node"]').getByRole("button", { name: "Start", exact: true }).click();
  await expect(panel).not.toBeVisible();
  for (const id of ["modeset", "doom", "sdl2"]) {
    await page.getByRole("button", { name: "Activities", exact: true }).click();
    await expect(panel.getByRole("button", { name: /Restart/ })).toHaveCount(0);
    await panel.locator(`[data-image-activity="${id}"]`).getByRole("button", { name: "Start", exact: true }).click();
    await expect(panel).not.toBeVisible({ timeout: 120_000 });
    if (id === "doom") {
      const canvas = page.locator("canvas.kframebuffer-canvas").first();
      await expect(canvas).toBeVisible({ timeout: 120_000 });
      await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
        const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
        const colors = new Set<number>();
        for (let offset = 0; offset < pixels.length; offset += 4) {
          colors.add((pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2]);
          if (colors.size > 8) break;
        }
        return colors.size;
      }), { timeout: 120_000 }).toBeGreaterThan(8);
      const framebufferTitle = page.locator(".kdemo-surface-title").filter({ hasText: "/DEV/FB0" });
      const previousTitle = await framebufferTitle.textContent();
      const menu = page.getByRole("button", { name: /^LAN game/ });
      await menu.click();
      await page.getByTestId("fb-dock-menu-entry-single").click();
      await expect(menu).toBeEnabled({ timeout: 60_000 });
      await expect(framebufferTitle).not.toHaveText(previousTitle!, { timeout: 60_000 });
      await expect(framebufferTitle).toContainText(/pid \d+/, { timeout: 60_000 });
      await expect(canvas).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-testid="fb-dock-action-error"]')).toHaveCount(0);
    } else {
      const surface = page.locator(".kmodeset-surface");
      await expect(surface).toBeVisible({ timeout: 120_000 });
      await expect(surface).not.toHaveAttribute("data-kms-owner-pid", "0");
      await expect.poll(async () => Number(await surface.getAttribute("data-kms-present-count")), { timeout: 120_000 }).toBeGreaterThan(2);
    }
    expect(kernels).toHaveLength(kernelCount);
    expect(page.url()).toBe(originalUrl);
    expect(await currentComputerMetadata(page)).toMatchObject(original);
  }
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/dynamic-activities-${testInfo.project.name}.png`) });
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  await panel.getByRole("button", { name: "Stop SDL2 GLSL playground", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Stop SDL2 GLSL playground", exact: true })).toHaveCount(0, { timeout: 60_000 });
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("tab", { name: "TTY1", exact: true }).click();
  await runTerminalCommand(page, "kill -0 \"$(cat /home/projects/activity-shell-pid)\" && test \"$(cat /home/projects/live-activity-note)\" = live-activity && ps -A | grep '[n]ode' >/dev/null && printf '%s%s\\n' UNRELATED_ACTIVITY_ PRESERVED", "UNRELATED_ACTIVITY_PRESERVED");
  expect(errors).toEqual([]);
});
