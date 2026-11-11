import { expect, test } from "../playwright-test";
import { terminalHistoryMatching } from "./support/terminal-history";

test("terminal history gates find old output and restore the live bottom", async ({ page }) => {
  await page.goto("/test/fixtures/terminal-repaint.html");
  await expect.poll(() => page.evaluate(() =>
    (window as any).__terminalRepaint.listeners("/dev/pts/0"),
  )).toBe(1);
  await page.evaluate(() => {
    const lines = Array.from({ length: 600 }, (_, i) =>
      i === 200 ? "NOTIFICATION id=1 summary=Theme" : `HISTORY ROW ${i}`);
    (window as any).__terminalRepaint.emit("/dev/pts/0", `${lines.join("\r\n")}\r\n`);
  });
  const terminal = page.locator(".xterm:visible");
  await expect(terminal.locator(".xterm-rows")).toContainText("HISTORY ROW 599");
  await expect(terminal.locator(".xterm-rows")).not.toContainText("NOTIFICATION");
  // The former scanner cannot reach the marker through this retained element.
  const oldViewport = terminal.locator(".xterm-viewport");
  await oldViewport.evaluate(node => node.scrollTo(0, 0));
  await terminal.locator(".xterm-screen").screenshot();
  await expect(terminal.locator(".xterm-rows")).toContainText("HISTORY ROW 599");
  expect(await terminalHistoryMatching(terminal, /NOTIFICATION id=1 summary=Theme/))
    .toMatch(/NOTIFICATION id=1 summary=Theme/);
  await expect(terminal.locator(".xterm-rows")).toContainText("HISTORY ROW 599");
  expect(await terminalHistoryMatching(terminal, /MISSING NOTIFICATION/))
    .not.toMatch(/MISSING NOTIFICATION/);
  await expect(terminal.locator(".xterm-rows")).toContainText("HISTORY ROW 599");
  expect(await page.evaluate(() => (window as any).__terminalRepaint.inputs)).toEqual([]);
});

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

test("hidden resize keeps new output visible and preserves deliberate scrollback", async ({ page }) => {
  await page.goto("/test/fixtures/terminal-repaint.html");
  await expect.poll(() => page.evaluate(() =>
    (window as any).__terminalRepaint.listeners("/dev/pts/0"),
  )).toBe(1);
  const rows = page.locator(".xterm-rows:visible");
  const surface = page.locator(".kshell-surface");
  const toggle = page.getByRole("button", { name: "Toggle terminal view" });
  await page.evaluate(() => {
    const fixture = (window as any).__terminalRepaint;
    fixture.setOutputOnResize(true);
    fixture.emit("/dev/pts/0", Array.from({ length: 100 }, (_, i) =>
      `ROW ${i} ${"word ".repeat(20)}\r\n`).join(""));
  });
  await expect(rows).toContainText("ROW 99");
  for (let cycle = 0; cycle < 6; cycle++) {
    await toggle.click();
    await expect(rows).toHaveCount(0);
    await surface.evaluate((node, cycle) => {
      const style = (node as HTMLElement).style;
      style.width = cycle % 2 ? "800px" : "650px";
      style.height = cycle % 2 ? "500px" : "350px";
    }, cycle);
    await page.evaluate(async cycle => {
      (window as any).__terminalRepaint.emit("/dev/pts/0", `HIDDEN ${cycle}\r\n`);
      // Why: observe actual hidden layout so this exercises a suspended
      // renderer rather than a hide/reveal completed within one paint.
      await new Promise<void>(resolve => {
        const observer = new IntersectionObserver(entries => {
          if (entries.some(entry => !entry.isIntersecting)) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(document.querySelector(".kshell-terminal-slot[hidden] .xterm-screen")!);
      });
    }, cycle);
    await toggle.click();
    await page.evaluate(cycle => (window as any).__terminalRepaint.emit("/dev/pts/0",
      `EXIT_MARKER_${cycle}\r\nPROMPT_${cycle}\r\n`), cycle);
    await expect(rows).toContainText(`EXIT_MARKER_${cycle}`);
    await expect(rows).toContainText(`PROMPT_${cycle}`);
  }

  await page.locator(".xterm:visible").click();
  await page.keyboard.press("Shift+PageUp");
  await expect(rows).not.toContainText("PROMPT_5");
  const history = await rows.innerText();
  await toggle.click();
  await page.evaluate(() => (window as any).__terminalRepaint.emit("/dev/pts/0", "WHILE_SCROLLED\r\n"));
  await toggle.click();
  await page.locator(".xterm-screen:visible").screenshot({ timeout: 2_000 });
  await expect.poll(() => rows.innerText()).toBe(history);
  expect(await page.evaluate(() => (window as any).__terminalRepaint.inputs)).toEqual([]);

  // Why: retiring a hidden terminal must cancel its layout work; a newly
  // visible terminal owns its own PTY and must not resize the retired one.
  await toggle.click();
  await page.getByRole("button", { name: "Remove TTY1" }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as any).__terminalRepaint.listeners("/dev/pts/0"),
  )).toBe(0);
  const retiredResizes = await page.evaluate(() =>
    (window as any).__terminalRepaint.resizes.filter((resize: { path: string }) => resize.path === "/dev/pts/0").length);
  await toggle.click();
  await surface.evaluate(node => { (node as HTMLElement).style.height = "400px"; });
  await expect.poll(() => page.evaluate(() =>
    (window as any).__terminalRepaint.listeners("/dev/pts/1"),
  )).toBe(1);
  await expect(rows).toContainText("RESIZE");
  expect(await page.evaluate(() =>
    (window as any).__terminalRepaint.resizes.filter((resize: { path: string }) => resize.path === "/dev/pts/0").length))
    .toBe(retiredResizes);
});
