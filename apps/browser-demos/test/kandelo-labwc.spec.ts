import { expect, test, type Page } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";

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

interface Rect { x: number; y: number; width: number; height: number }
interface Frame { width: number; height: number; foot: Rect | null; ink: number }

/** Find the connected neutral dark background of the real foot client.
 * Root background and SSD titlebars are lighter; text creates small holes.
 * This reads the rendered screenshot, never a guest-memory or mock surface.
 */
async function footFrame(page: Page): Promise<Frame> {
  const png = await canvas(page).screenshot();
  return page.evaluate(async base64 => {
    const png = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { width, height, data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    const seen = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    const dark = (pixel: number) => {
      const at = pixel * 4, r = data[at], g = data[at + 1], b = data[at + 2];
      return r > 20 && r < 60 && Math.abs(r - g) < 8 && Math.abs(r - b) < 8;
    };
    let foot: Rect | null = null;
    let largest = 0;
    for (let pixel = 0; pixel < seen.length; pixel++) {
      if (seen[pixel] || !dark(pixel)) continue;
      seen[pixel] = 1;
      queue[0] = pixel;
      let tail = 1, left = width, top = height, right = 0, bottom = 0;
      for (let head = 0; head < tail; head++) {
        const current = queue[head], x = current % width, y = Math.floor(current / width);
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (const next of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1,
          y > 0 ? current - width : -1, y + 1 < height ? current + width : -1]) {
          if (next < 0 || seen[next] || !dark(next)) continue;
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
      if (right - left > 150 && bottom - top > 80 && tail > largest) {
        largest = tail;
        foot = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
      }
    }
    let ink = 0;
    if (foot) for (let y = foot.y; y < foot.y + foot.height; y++) {
      for (let x = foot.x; x < foot.x + foot.width; x++) {
        const p = (y * width + x) * 4;
        if (data[p] > 150 && data[p + 1] > 150 && data[p + 2] > 150) ink++;
      }
    }
    return { width, height, foot, ink };
  }, png.toString("base64"));
}

/** A newly painted menu must contain a large connected changed rectangle.
 * A cursor or blinking terminal cell cannot satisfy this area/fill gate.
 * Baseline and current captures use the same pointer position.
 */
async function menuChange(page: Page, before: Buffer): Promise<Rect | null> {
  const after = await canvas(page).screenshot();
  return page.evaluate(async ([before, after]) => {
    const decode = async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = surface.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      return image;
    };
    const a = await decode(before), b = await decode(after);
    if (a.width !== b.width || a.height !== b.height) throw new Error("canvas resized during root-menu check");
    const { width, height } = a;
    const changed = new Uint8Array(width * height);
    for (let p = 0; p < changed.length; p++) {
      const at = p * 4;
      changed[p] = Math.max(...[0, 1, 2].map(c => Math.abs(a.data[at + c] - b.data[at + c]))) > 35 ? 1 : 0;
    }
    const queue = new Int32Array(changed.length);
    for (let p = 0; p < changed.length; p++) {
      if (!changed[p]) continue;
      changed[p] = 0; queue[0] = p;
      let tail = 1, left = width, top = height, right = 0, bottom = 0;
      for (let head = 0; head < tail; head++) {
        const current = queue[head], x = current % width, y = Math.floor(current / width);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (const next of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1,
          y > 0 ? current - width : -1, y + 1 < height ? current + width : -1]) {
          if (next < 0 || !changed[next]) continue;
          changed[next] = 0; queue[tail++] = next;
        }
      }
      const rect = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
      if (rect.width > 80 && rect.height > 50 && tail > 2_000 && tail / (rect.width * rect.height) > 0.65) return rect;
    }
    return null;
  }, [before.toString("base64"), after.toString("base64")] as const);
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
    return first.foot !== null && first.ink > 200;
  }, { timeout: 180_000, intervals: [1_000] }).toBe(true);
  first = await footFrame(page);
  const bounds = first.foot!;
  // A floating client leaves root visible; this must not be a fullscreen
  // kiosk/tile or merely a dark unpainted output.
  expect(bounds.width).toBeLessThan(first.width - 20);
  expect(bounds.height).toBeLessThan(first.height - 20);
  expect(bounds.y).toBeGreaterThan(12);
  await footProcesses(page, 1);
  await page.keyboard.type("mark=first\n", { delay: 40 });

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
  await page.keyboard.type("mark=second\n", { delay: 40 });
  await page.keyboard.press("Alt+Tab");
  await page.keyboard.type("echo FIRST:$mark > /tmp/labwc-first\n", { delay: 40 });
  await page.keyboard.press("Alt+Tab");
  await page.keyboard.type("echo SECOND:$mark > /tmp/labwc-second\n", { delay: 40 });
  await page.keyboard.press("Control+Shift+E");

  // Observe real display release and automatic return to the launching shell.
  // A prompt, hidden xterm text or host termination is not compositor exit.
  await expect.poll(() => displayOwner(page), { timeout: 60_000 }).toBe(0);
  await expect(page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }))
    .toHaveAttribute("aria-current", "true", { timeout: 60_000 });
  await page.locator(".xterm").first().click();
  await page.keyboard.type("echo labwc-exit=$?; cat /tmp/labwc-first /tmp/labwc-second\n", { delay: 40 });
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toMatch(/labwc-exit=0/);
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("FIRST:first");
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("SECOND:second");
  expect(owner).toBeGreaterThan(0);
  await footProcesses(page, 0, false);
  await expect.poll(() => displayOwner(page)).toBe(0);
});
