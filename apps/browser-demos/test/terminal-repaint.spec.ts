import { expect, test } from "@playwright/test";

test("full-screen terminal state survives tab changes and hidden output", async ({ page }) => {
  await page.goto("/test/fixtures/terminal-repaint.html");
  await expect.poll(() => page.evaluate(() =>
    (window as any).__terminalRepaint.listeners("/dev/pts/0"),
  )).toBe(1);
  await page.evaluate(() => {
    (window as any).__terminalRepaint.emit("/dev/pts/0",
      "\x1b[?1049h\x1b[2J\x1b[H\x1b[10;1HANCHORED EDITOR LINE\x1b[H");
  });
  await expect(page.locator(".xterm-rows:visible")).toContainText("ANCHORED EDITOR LINE");

  await page.getByRole("button", { name: "TTY2", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as any).__terminalRepaint.listeners("/dev/pts/1"),
  )).toBe(1);
  await page.evaluate(() => {
    const fixture = (window as any).__terminalRepaint;
    // Incremental cursor updates exceed the session's byte-history window.
    // The terminal screen still contains the line painted before those writes.
    for (let n = 0; n < 2200; n++) fixture.emit("/dev/pts/0", `\x1b[H${n}`);
    fixture.emit("/dev/pts/0", "\x1b[11;");
  });
  await page.getByRole("button", { name: "TTY1", exact: true }).click();
  await expect(page.locator(".xterm-rows:visible")).toContainText("ANCHORED EDITOR LINE");
  await page.evaluate(() => {
    (window as any).__terminalRepaint.emit("/dev/pts/0", "1HREPAINT AFTER REVEAL");
  });
  await expect(page.locator(".xterm-rows:visible")).toContainText("REPAINT AFTER REVEAL");
  await page.getByRole("button", { name: "Toggle terminal view" }).click();
  await expect(page.locator(".xterm-rows:visible")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__terminalRepaint.emit("/dev/pts/0", "\x1b[12;1HHIDDEN VIEW OUTPUT");
  });
  await page.getByRole("button", { name: "Toggle terminal view" }).click();
  await expect(page.locator(".xterm-rows:visible")).toContainText("ANCHORED EDITOR LINE");
  await expect(page.locator(".xterm-rows:visible")).toContainText("HIDDEN VIEW OUTPUT");
  await expect.poll(() => page.evaluate(() =>
    (window as any).__terminalRepaint.attachments,
  )).toEqual(["/dev/pts/0", "/dev/pts/1"]);

  await page.getByRole("button", { name: "Remove TTY1" }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as any).__terminalRepaint.listeners("/dev/pts/0"),
  )).toBe(0);
});
