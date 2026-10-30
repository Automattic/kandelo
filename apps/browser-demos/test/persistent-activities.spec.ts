import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { test } from "./support/persistent-page";
import { machineUrl } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";
import { expectRunningMachineAudio } from "./support/machine-audio";

const sharewareHash = "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771";

async function shell(page: Page, name = "TTY1") {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("tab", { name, exact: true }).click();
}

async function startDoom(page: Page) {
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const activities = page.getByRole("region", { name: "Installed activities" });
  await activities.getByRole("button", { name: "Apps & tools", exact: true }).click();
  await activities.locator('[data-image-activity="doom"]').getByRole("button", { name: "Start", exact: true }).click();
  await expect(activities).not.toBeVisible({ timeout: 120000 });
}

async function expectDoom(page: Page) {
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 120000 });
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    const colors = new Set<number>();
    for (let offset = 0; offset < pixels.length; offset += 4) {
      colors.add((pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2]);
      if (colors.size > 8) break;
    }
    return colors.size;
  }), { timeout: 120000 }).toBeGreaterThan(8);
}

async function doomKeys(page: Page, keys: string[]) {
  await page.locator("canvas.kframebuffer-canvas").first().focus();
  for (const key of keys) await page.keyboard.press(key, { delay: 150 });
}

test("the normal user home persists on the root filesystem while temporary files reset", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto(await machineUrl(page, "shell"));
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180000 });
  await shell(page);
  await runTerminalCommand(page, "set -eu; test \"$(id -u)\" = 1000; test \"$(stat -c '%u:%g:%a' \"$HOME\")\" = 1000:1000:755; test \"$(stat -c %a /root)\" = 700; test \"$(stat -c %d \"$HOME\")\" = \"$(stat -c %d /srv)\"; printf 'home-saved\\n' > \"$HOME/home-note\"; ln \"$HOME/home-note\" /home/projects/home-link; printf 'temporary\\n' > /tmp/home-test; sync");
  await page.reload();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180000 });
  await shell(page);
  await runTerminalCommand(page, "set -eu; test \"$(cat \"$HOME/home-note\")\" = home-saved; test \"$(cat /home/projects/home-link)\" = home-saved; test \"$(stat -c %i \"$HOME/home-note\")\" = \"$(stat -c %i /home/projects/home-link)\"; test ! -e /tmp/home-test; test \"$(stat -c '%u:%g:%a' \"$HOME\")\" = 1000:1000:755");
});

for (const initialProfile of ["shell", "doom"]) test(`Doom menu saves survive quitting, restarting and refreshing from ${initialProfile}`, async ({ page }, testInfo) => {
  test.setTimeout(420000);
  page.setDefaultTimeout(30000);
  const probeTerminal = initialProfile === "doom" ? "TTY2" : "TTY1";
  const probe = () => shell(page, probeTerminal);
  const addProbeTerminal = async () => {
    if (initialProfile !== "doom") return;
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await expect(page.locator(".kshell-host:visible .xterm-rows")).toContainText(/kandelo(?:-bash-[0-9.]+)?\$ ?/, { timeout: 30000 });
    await page.getByRole("button", { name: "Graphics", exact: true }).click();
  };
  await page.goto(await machineUrl(page, initialProfile));
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180000 });
  if (initialProfile === "shell") await startDoom(page);
  await expectDoom(page);
  await addProbeTerminal();
  await doomKeys(page, ["Escape", "Enter", "Enter", "Enter"]);
  await doomKeys(page, ["Escape", "ArrowDown", "ArrowDown", "ArrowDown", "Enter", "Enter", "s", "a", "v", "e", "Enter"]);
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/doom-save-menu-${initialProfile}-${testInfo.project.name}.png`) });
  await probe();
  const saved = await runTerminalCommand(page, "find \"$HOME/.fdoom.tar\" -type f; wc -c \"$HOME/.fdoom.tar/savegame/doomsav0.dsg\"; sha256sum \"$HOME/.fdoom.tar/savegame/doomsav0.dsg\"");
  console.log("Doom save files", saved.output);
  expect(saved.output).toContain("doomsav0.dsg");
  const hash = /([0-9a-f]{64})\s+.*doomsav0\.dsg/.exec(saved.output)?.[1];
  expect(hash).toBeDefined();
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await doomKeys(page, ["Escape", "ArrowDown", "ArrowDown", "Enter", "y"]);
  await expect(page.getByRole("button", { name: "Graphics", exact: true })).toBeDisabled({ timeout: 30000 });
  await page.getByRole("tab", { name: initialProfile === "doom" ? "TTY1" : "fbDOOM", exact: true }).click();
  await expect(page.locator(".kshell-host:visible .xterm-rows")).toContainText(/kandelo(?:-bash-[0-9.]+)?\$ ?/, { timeout: 30000 });
  await page.locator(".kshell-host:visible").click();
  await page.keyboard.press("Control+u");
  await page.keyboard.insertText("printf '%s%s=%s\\n' DOOM_ EXIT \"$?\"");
  await page.keyboard.press("Enter");
  await expect(page.locator(".kshell-host:visible .xterm-rows")).toContainText("DOOM_EXIT=0");
  await probe();
  const afterQuit = await runTerminalCommand(page, "sha256sum \"$HOME/.fdoom.tar/savegame/doomsav0.dsg\"; test ! -f /tmp/doom-launch.pid; test \"$(ps -A | grep -c '[f]bdoom')\" -eq 0");
  expect(afterQuit.output).toContain(hash!);
  await startDoom(page);
  await expectDoom(page);
  await probe();
  expect((await runTerminalCommand(page, "sha256sum \"$HOME/.fdoom.tar/savegame/doomsav0.dsg\"")).output).toContain(hash!);
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await doomKeys(page, ["F3", "Enter"]);
  await probe();
  expect((await runTerminalCommand(page, "sha256sum \"$HOME/.fdoom.tar/savegame/doomsav0.dsg\"")).output).toContain(hash!);
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await doomKeys(page, ["F2", "ArrowDown", "Enter", "r", "Enter"]);
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/doom-save-loaded-${initialProfile}-${testInfo.project.name}.png`) });
  await probe();
  const afterRestart = await runTerminalCommand(page, "find \"$HOME/.fdoom.tar\" -type f; sha256sum \"$HOME/.fdoom.tar/savegame/doomsav0.dsg\"; test -s \"$HOME/.fdoom.tar/savegame/doomsav1.dsg\"");
  expect(afterRestart.output).toContain(hash!);
  await page.reload();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180000 });
  if (initialProfile === "doom") await expectDoom(page);
  await addProbeTerminal();
  await probe();
  const afterReload = await runTerminalCommand(page, "sha256sum \"$HOME/.fdoom.tar/savegame/doomsav0.dsg\"");
  expect(afterReload.output).toContain(hash!);
  if (initialProfile === "shell") await startDoom(page);
  else await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await expectDoom(page);
  await doomKeys(page, ["F3", "Enter"]);
  await doomKeys(page, ["F2", "ArrowDown", "ArrowDown", "Enter", "p", "Enter"]);
  await probe();
  await runTerminalCommand(page, "test -s \"$HOME/.fdoom.tar/savegame/doomsav2.dsg\"");
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/doom-save-recovered-${initialProfile}-${testInfo.project.name}.png`) });
});

test("Doom activity retains its WAD and starts with music after a persistent shell refresh", async ({ page }, testInfo) => {
  test.setTimeout(420000);
  page.setDefaultTimeout(30000);
  await page.goto(await machineUrl(page, "shell"));
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180000 });
  const computerUrl = page.url();
  await startDoom(page);
  await expectDoom(page);
  await shell(page);
  const before = await runTerminalCommand(page, "sha256sum /usr/share/doom/doom1.wad; wc -c /usr/share/doom/doom1.wad");
  expect(before.exitCode).toBe(0);
  expect(before.output).toContain(sharewareHash);
  let recoveryDownloads = 0;
  await page.route(url => url.href.includes("doom1.wad"), async route => {
    recoveryDownloads++;
    await route.abort();
  });
  await page.reload();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180000 });
  expect(page.url()).toBe(computerUrl);
  await shell(page);
  const after = await runTerminalCommand(page, "sha256sum /usr/share/doom/doom1.wad; wc -c /usr/share/doom/doom1.wad");
  expect(after.exitCode).toBe(0);
  expect(after.output).toContain(sharewareHash);
  await startDoom(page);
  await expectDoom(page);
  await expect(page.locator('[data-audio-active="true"]')).toHaveCount(1, { timeout: 30000 });
  await expectRunningMachineAudio(page, 30000);
  expect(recoveryDownloads).toBe(0);
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/persistent-doom-recovered-${testInfo.project.name}.png`) });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".kshell-host:visible .xterm-rows")).not.toContainText("GENMIDI not found");
});
