import { expect, test, type Page } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { typePhysicalText } from "./support/physical-typing";
import { footFrame, menuChange, type Frame } from "./support/labwc-frame";

// These real-rendering checks must never claim the user's desktop focus.
test.use({ headless: true });

async function openSurface(page: Page, label: "Internals" | "Demo" | "Terminal") {
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  await internals.waitFor({ state: "visible", timeout: 30_000 });
  if (((await internals.getAttribute("aria-pressed")) === "true") !== (label === "Internals")) {
    await internals.click();
  }
  if (label !== "Internals") {
    const view = page.getByLabel("Computer views").getByRole("button", { name: label, exact: true });
    if ((await view.getAttribute("aria-current")) !== "true") await view.click();
  }
}
const canvas = (page: Page) => page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
async function chipText(page: Page) {
  return (await page.locator(".kdemo-surface-controls").filter({ hasText: "flips" }).allInnerTexts()).join(" ");
}
async function displayOwner(page: Page) {
  const owner = await page.locator(".kmachine-primary .kmodeset-surface").getAttribute("data-kms-owner-pid");
  return owner === null ? Number.NaN : Number(owner);
}
async function terminalText(page: Page) {
  return (await page.locator(".xterm-rows").first().locator(":scope > div").allInnerTexts()).join("\n");
}


async function movePointer(page: Page, frame: Frame, x: number, y: number, steps = 1) {
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + x * box.width / frame.width, box.y + y * box.height / frame.height, { steps });
}
async function focusDemo(page: Page) {
  await openSurface(page, "Demo");
  // The dock button otherwise retains keyboard focus. This point is outside
  // the canvas, so focusing the page does not change the compositor's seat.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
}
async function footProcesses(page: Page, count: number, returnToDemo = true) {
  await openSurface(page, "Internals");
  await page.getByRole("tab", { name: "Procs", exact: true }).click();
  await expect(page.locator(".ktable tbody tr > td:last-child").filter({ hasText: /^(?:\/\S*\/)?foot(?:\s|$)/ }))
    .toHaveCount(count, { timeout: 180_000 });
  if (returnToDemo) await focusDemo(page);
}

/** Shipped gallery boot, stock labwc actions and real foot shells. The Node
 * companion uses pixman; this spec exercises GLES2 through GBM/EGL/WebGL2 in
 * each of Chromium, Firefox and WebKit when selected by the normal runner.
 * Upstream control reference:
 * https://github.com/labwc/labwc/blob/0.20.2/docs/labwc-actions.5.scd
 */
test("Kandelo labwc moves decorated foot windows, changes focus and exits cleanly", async ({ page }) => {
  test.setTimeout(480_000);
  await gotoMachine(page, "labwc");
  await openSurface(page, "Internals");
  await expect.poll(async () => (await page.locator(".ksys-line").allInnerTexts()).join("\n"), { timeout: 180_000 })
    .toMatch(/running .*\/usr\/local\/bin\/labwc/);
  await focusDemo(page);
  await expect(canvas(page)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => chipText(page), { timeout: 120_000 }).toMatch(/webgl2-gl/i);
  await expect.poll(() => displayOwner(page), { timeout: 120_000 }).toBeGreaterThan(0);
  const owner = await displayOwner(page);

  let first: Frame;
  await expect.poll(async () => {
    first = await footFrame(page);
    return first.foot !== null;
  }, { timeout: 180_000, intervals: [1_000] }).toBe(true);
  // The initial prompt is short. Require executed, rendered output instead
  // of assuming it occupies an arbitrary number of white pixels.
  await typePhysicalText(page, "printf '\\033[41mLABWC_RENDERED_READY\\033[0m\\n'\n", { delay: 40 });
  await expect.poll(async () => {
    const frame = await footFrame(page);
    return frame.ink > 200 && frame.red > 200;
  }, { timeout: 60_000 }).toBe(true);
  first = await footFrame(page);
  const bounds = first.foot!;
  // A floating client leaves root visible; this must not be a fullscreen
  // kiosk/tile or merely a dark unpainted output.
  expect(bounds.width).toBeLessThan(first.width - 20);
  expect(bounds.height).toBeLessThan(first.height - 20);
  expect(bounds.y).toBeGreaterThan(12);
  await footProcesses(page, 1);
  await typePhysicalText(page, "mark=first\n", { delay: 40 });

  // Drag the server-side title, above the client background. The renderer
  // must move the same-sized client, exposing root at its original position.
  const dx = bounds.x + bounds.width + 100 < first.width ? 80 : -80;
  const dy = bounds.y + bounds.height + 90 < first.height ? 60 : -60;
  await movePointer(page, first, bounds.x + bounds.width / 2, bounds.y - 12);
  await page.mouse.down();
  try {
    await movePointer(page, first, bounds.x + bounds.width / 2 + dx, bounds.y - 12 + dy, 12);
  } finally { await page.mouse.up(); }
  await expect.poll(async () => {
    const after = (await footFrame(page)).foot;
    return after !== null && Math.abs(after.x - bounds.x) > 40 && Math.abs(after.y - bounds.y) > 25
      && Math.abs(after.width - bounds.width) < 5 && Math.abs(after.height - bounds.height) < 5;
  }, { timeout: 60_000, intervals: [500] }).toBe(true);

  // Right-click exposed root: the shipped menu is real compositor paint,
  // with a connected rectangle far larger than a hardware cursor. Escape
  // must remove that rectangle; reopen it and activate its Terminal item.
  const movedFrame = await footFrame(page), movedBounds = movedFrame.foot!;
  const root = [[24, 24], [movedFrame.width - 30, 24], [24, movedFrame.height - 30],
    [movedFrame.width - 30, movedFrame.height - 30]].find(([x, y]) =>
    x < movedBounds.x - 10 || x > movedBounds.x + movedBounds.width + 10
      || y < movedBounds.y - 50 || y > movedBounds.y + movedBounds.height + 10);
  expect(root, "floating desktop leaves an exposed root point").toBeDefined();
  await movePointer(page, movedFrame, root![0], root![1]);
  const rootBefore = await canvas(page).screenshot();
  await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" });
  await expect.poll(() => menuChange(page, rootBefore), { timeout: 30_000 }).not.toBeNull();
  await page.keyboard.press("Escape");
  await expect.poll(() => menuChange(page, rootBefore), { timeout: 30_000 }).toBeNull();
  await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" });
  await expect.poll(() => menuChange(page, rootBefore), { timeout: 30_000 }).not.toBeNull();
  // Upstream's default ignoreButtonReleasePeriod is 250 ms, not readiness.
  await page.waitForTimeout(300);
  const terminalItem = (await menuChange(page, rootBefore))!;
  await movePointer(page, movedFrame, terminalItem.x + terminalItem.width / 2, terminalItem.y + 10);
  await page.mouse.down(); await page.mouse.up();
  await footProcesses(page, 2);
  await page.keyboard.press("Alt+F4");
  await footProcesses(page, 1);

  // Open another real terminal. Distinct shell variables then prove each
  // focus change reached the intended PTY, not only a repaint or key echo.
  await page.keyboard.press("Control+Enter");
  await footProcesses(page, 2);
  await typePhysicalText(page, "mark=second\n", { delay: 40 });
  await page.keyboard.press("Alt+Tab");
  await typePhysicalText(page, "echo FIRST:$mark > /tmp/labwc-first\n", { delay: 40 });
  await page.keyboard.press("Alt+Tab");
  await typePhysicalText(page, "echo SECOND:$mark > /tmp/labwc-second\n", { delay: 40 });
  await page.keyboard.press("Control+Shift+E");

  // Observe real display release and automatic return to the launching shell.
  // A prompt, hidden xterm text or host termination is not compositor exit.
  await expect.poll(() => displayOwner(page), { timeout: 60_000 }).toBe(0);
  await expect(page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }))
    .toHaveAttribute("aria-current", "true", { timeout: 60_000 });
  await page.locator(".xterm").first().click();
  await typePhysicalText(page, "echo labwc-exit=$?; cat /tmp/labwc-first /tmp/labwc-second\n", { delay: 40 });
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toMatch(/labwc-exit=0/);
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("FIRST:first");
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("SECOND:second");
  expect(owner).toBeGreaterThan(0);
  await footProcesses(page, 0, false);
  await expect.poll(() => displayOwner(page)).toBe(0);
});
