import { expect, test, type Page } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

async function gotoOrSkip(page: Page, path: string) {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }
}

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

test("Kandelo evdev demo forwards keystrokes + pointer through /dev/input/event{0,1}", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=evdev");

  // The evdev_demo binary prints "ready:" once both /dev/input/event0
  // and /dev/input/event1 have been opened and EVIOCGNAME has succeeded
  // on both. Waiting for that proves: the binary was staged into the
  // VFS, bash exec'd it, and the kernel's A3 EVIOC* dispatch returned
  // the correct device names.
  await expect
    .poll(() => terminalText(page), { timeout: 180_000 })
    .toContain("ready:");

  const readyText = await terminalText(page);
  expect(readyText).toContain("kbd: wpk virtual keyboard");
  expect(readyText).toContain("ptr: wpk virtual pointer");

  // BrowserInputSource preventDefaults every key it translates, so when
  // the terminal pane is focused the only way "key down: code=30"
  // (KEY_A) can appear in the xterm output is if BrowserInputSource
  // caught the keydown, dispatched into kernel_input_event, the kernel
  // fanned out to /dev/input/event0, and evdev_demo's read returned it.
  // The dual-host parity claim of B4 is what this proves end-to-end.
  await page.keyboard.press("KeyA");
  await expect
    .poll(() => terminalText(page), { timeout: 15_000 })
    .toMatch(/key down: code=30/);

  // Pointer move → ABS_X/ABS_Y (pointer-lock inactive) → evdev_demo
  // prints "ptr abs code=0 value=N" (REL_X==ABS_X==0 in Linux UAPI).
  // The exact value depends on which DOM element pointermove fires on
  // and its offsetX/offsetY, so just assert the shape of the line.
  await page.mouse.move(100, 200);
  await page.mouse.move(150, 250);
  await expect
    .poll(() => terminalText(page), { timeout: 15_000 })
    .toMatch(/ptr (abs|rel) code=\d+ value=-?\d+/);
});
