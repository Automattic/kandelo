import { expect } from "../playwright-test";
import { test } from "./support/persistent-page";
import { machineUrl } from "./support/kandelo-machine";
import { currentComputerMetadata } from "./support/computer-library";
import { quitDosAndCheck } from "./support/dos-exit";
import { runTerminalCommand } from "./support/terminal-command";

test("DOS games Activity plays Apogee shareware and switches games in the base computer @slow", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(await machineUrl(page, "shell"));
  const terminal = page.locator(".kshell-terminal-slot:not([hidden]) .xterm-rows").first();
  await expect(terminal).toContainText(/maker@[^:\s]+:[^\r\n]*\$\s*$/, { timeout: 180_000 });
  const originalUrl = page.url();
  const originalComputer = await currentComputerMetadata(page);
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const panel = page.getByRole("region", { name: "Installed activities" });
  const activity = panel.locator('[data-image-activity="dos-games"]');
  await expect(activity).toContainText("DOS games");
  await expect(activity).toContainText("Apogee shareware");
  await activity.getByRole("button", { name: "Start", exact: true }).click();
  await expect(panel).not.toBeVisible();
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  const pixels = () => canvas.evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set<number>();
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      const value = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
      colors.add(value); hash = Math.imul(hash ^ value, 16777619);
    }
    return { colors: colors.size, hash };
  });
  await expect.poll(async () => (await pixels()).colors, { timeout: 120_000 }).toBeGreaterThan(8);
  const keenOwner = /pid (\d+)/i.exec(await page.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" }).innerText())![1];
  await canvas.focus();
  const before = (await pixels()).hash;
  await page.keyboard.press("Space", { delay: 100 });
  await expect.poll(async () => (await pixels()).hash, { timeout: 30_000 }).not.toBe(before);
  await test.info().attach("keen-shareware", { body: await page.screenshot(), contentType: "image/png" });

  await page.getByTestId("fb-dock-action-games").click();
  for (const id of ["keen1", "dosdefender", "vitetris", "anarch"])
    await expect(page.getByTestId(`fb-dock-menu-entry-${id}`)).toBeVisible();
  await expect(page.getByTestId("fb-dock-menu-entry-keen1")).toContainText("Apogee shareware");
  await page.getByTestId("fb-dock-menu-entry-dosdefender").click();
  await expect.poll(async () => {
    const owner = /pid (\d+)/i.exec(await page.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" }).innerText())?.[1];
    return owner !== undefined && owner !== keenOwner;
  }, { timeout: 120_000 }).toBe(true);
  await expect.poll(async () => (await pixels()).colors, { timeout: 60_000 }).toBeGreaterThan(4);
  expect(page.url()).toBe(originalUrl);
  expect(await currentComputerMetadata(page)).toEqual(originalComputer);
  await quitDosAndCheck(page, "DOS_ACTIVITY");

  // Check the installed original bytes through the guest, including the
  // distribution notice. Expected digests are from the pinned shareware ZIP.
  const result = await runTerminalCommand(page,
    'sha256sum "$HOME/.local/share/dos-play/keen1/VENDOR.DOC" "$HOME/.local/share/dos-play/keen1/KEEN1.EXE"; ' +
    `test ! -d /proc/${keenOwner}`);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("214abcbae7045291f78e08a1ee28194620c72c5326cfd9186f98f2c23ba38f51");
  expect(result.output).toContain("8b3f829f7eeab18a7fbf9d539967e9ae9c856258aa78efc0531fa922df71c4a2");
});
