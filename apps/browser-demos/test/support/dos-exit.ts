import { expect, type Page } from "../../playwright-test";

/** Observe terminal handoff, the foreground command's status and /proc cleanup. */
export async function quitDosAndCheck(page: Page, marker: string): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(marker)) throw new Error("Invalid test marker");
  const titles = await page.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" }).allTextContents();
  const pid = /pid (\d+)/i.exec(titles.join(" "))?.[1];
  expect(pid, "DOSBox must own the visible framebuffer before quitting").toBeTruthy();
  await page.locator("canvas.kframebuffer-canvas").first().focus();
  await page.keyboard.press("Control+Shift+F12");
  const terminal = page.locator(".kshell-terminal-slot:not([hidden]) .xterm-rows").first();
  await expect(terminal).toBeVisible({ timeout: 60_000 });
  await expect(terminal).toContainText(/maker@[^:\s]+:[^\r\n]*\$\s*$/, { timeout: 60_000 });
  await page.locator(".kshell-terminal-slot:not([hidden]) .xterm-screen").first().click();
  // Save $? before running any probe. Split markers ensure echoed input
  // cannot be mistaken for output the guest actually produced.
  await page.keyboard.insertText(
    `previous=$?; printf '%s%s:%s\\n' '${marker}_' EXIT "$previous"; ` +
    `if test -d /proc/${pid}; then printf '%s%s\\n' '${marker}_' STALE; ` +
    `else printf '%s%s\\n' '${marker}_' CLEAN; fi`,
  );
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(`${marker}_EXIT:0`, { timeout: 30_000 });
  await expect(terminal).toContainText(`${marker}_CLEAN`, { timeout: 30_000 });
  await expect(terminal).toContainText(/maker@[^:\s]+:[^\r\n]*\$\s*$/, { timeout: 30_000 });
}
