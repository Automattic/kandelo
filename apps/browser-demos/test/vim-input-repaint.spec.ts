import { expect, test } from "@playwright/test";

test("Vim repaints a paused open-line command before the next key", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/pages/kandelo/?profile=shell");
  const rows = page.locator(".xterm-rows:visible");
  const screen = () => rows.textContent();
  await expect.poll(screen, { timeout: 120_000 }).toMatch(/kandelo\$/);
  await page.locator(".xterm-helper-textarea:visible").focus();
  await page.keyboard.type("vim /etc/gitconfig");
  await page.keyboard.press("Enter");
  // Startup also performs availability checks while processing terminal replies.
  await expect.poll(screen, { timeout: 30_000 }).toContain("defaultBranch");
  await page.keyboard.type("6G$");

  for (let round = 0; round < 16; round++) {
    await page.keyboard.press("o");
    // The first edit of a readonly file deliberately displays W10 for 1002ms.
    // Every later open-line command must paint without needing a second key.
    await expect.poll(screen, { timeout: round === 0 ? 3_000 : 1_000 })
      .toContain("-- INSERT --");
    if (round === 0) {
      await expect.poll(async () => {
        const lines = await rows.locator(":scope > div").allTextContents();
        const pager = lines.findIndex(line => line.includes("pager = cat"));
        const user = lines.findIndex(line => line.trim() === "[user]");
        return user - pager;
      }, { timeout: 1_000 }).toBe(2);
    }
    if (round === 1) {
      await page.keyboard.press("Control+l");
      // Ctrl-L is a literal insertion in this mode, not a redraw command.
      await expect.poll(screen, { timeout: 1_000 }).toContain("^L");
    }
    await page.keyboard.press("Escape");
    await expect.poll(screen, { timeout: 2_000 }).not.toContain("-- INSERT --");
  }
  await page.keyboard.type(":q!");
  await page.keyboard.press("Enter");
  await expect.poll(screen, { timeout: 10_000 }).toMatch(/kandelo\$/);
  expect(errors).toEqual([]);
});
