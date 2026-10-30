import { expect, test, type Page } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { typePhysicalText } from "./support/physical-typing";
import { runTerminalCommand } from "./support/terminal-command";

test.use({ headless: true });

const canvas = (page: Page) => page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
const owner = async (page: Page) => Number(await page.locator(".kmachine-primary .kmodeset-surface")
  .getAttribute("data-kms-owner-pid"));

async function showDemo(page: Page) {
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  if ((await internals.getAttribute("aria-pressed")) === "true") await internals.click();
  const demo = page.getByLabel("Computer views").getByRole("button", { name: "Demo", exact: true });
  if ((await demo.getAttribute("aria-current")) !== "true") await demo.click();
  await expect(canvas(page)).toBeVisible();
}

type Rect = { x: number; y: number; width: number; height: number; pixels: number };
type Paint = {
  width: number; height: number; orange: Rect; orangePixels: number;
  pale: Rect[]; buttons: Rect[]; greenPixels: number; footPixels: number;
};

/** Inspect a real screenshot, not a DOM canvas backing store (the KMS canvas
 * is transferred to its renderer). Palette values come from the packaged
 * ScummVM 2026.3 Remastered theme, remastered_gfx.stx. Its mainmenu_bg is
 * orange, widget_default is pale cream, buttons are dark red, and logo.svg
 * is green. Terminal glyphs or a cursor cannot satisfy this spatial layout.
 * A future default-theme change should update this explicit paint contract.
 */
async function painted(page: Page): Promise<Paint> {
  const png = await canvas(page).screenshot({ animations: "disabled" });
  return page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    const masks = [new Uint8Array(width * height), new Uint8Array(width * height), new Uint8Array(width * height)];
    let orangePixels = 0, greenPixels = 0, footPixels = 0;
    let left = width, top = height, right = -1, bottom = -1;
    for (let i = 0; i < width * height; i++) {
      const r = data[4 * i], g = data[4 * i + 1], b = data[4 * i + 2];
      if (Math.abs(r - 204) <= 5 && Math.abs(g - 102) <= 5 && b <= 5) {
        masks[0][i] = 1; orangePixels++;
        left = Math.min(left, i % width); right = Math.max(right, i % width);
        top = Math.min(top, Math.floor(i / width)); bottom = Math.max(bottom, Math.floor(i / width));
      }
      // Both widget_default's cream and default_bg's pale gradient.
      if (r >= 225 && r <= 255 && g >= 215 && g <= 250 && b >= 180 && b <= 215) masks[1][i] = 1;
      if (r >= 120 && r <= 195 && g >= 20 && g <= 45 && b <= 18) masks[2][i] = 1;
      if (r < 25 && g > 90 && g > b * 2 && b < 80) greenPixels++;
      if (r > 20 && r < 60 && Math.abs(r - g) < 8 && Math.abs(r - b) < 8) footPixels++;
    }
    function components(mask: Uint8Array) {
      const result: Rect[] = [], queue = new Int32Array(width * height);
      for (let seed = 0; seed < mask.length; seed++) {
        if (!mask[seed]) continue;
        let head = 0, tail = 1, minX = width, minY = height, maxX = 0, maxY = 0;
        queue[0] = seed; mask[seed] = 0;
        while (head < tail) {
          const i = queue[head++], x = i % width, y = Math.floor(i / width);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          const visit = (next: number) => { if (mask[next]) { mask[next] = 0; queue[tail++] = next; } };
          if (x) visit(i - 1); if (x + 1 < width) visit(i + 1);
          if (y) visit(i - width); if (y + 1 < height) visit(i + width);
        }
        const w = maxX - minX + 1, h = maxY - minY + 1;
        if (w >= 30 && h >= 10 && tail / (w * h) > 0.45)
          result.push({ x: minX, y: minY, width: w, height: h, pixels: tail });
      }
      return result;
    }
    return { width, height, orange: { x: left, y: top, width: right - left + 1, height: bottom - top + 1, pixels: orangePixels },
      orangePixels, pale: components(masks[1]), buttons: components(masks[2]), greenPixels, footPixels };
  }, png.toString("base64"));
}

function isLauncher(paint: Paint): boolean {
  const app = paint.orange;
  const inside = (r: Rect) => r.x >= app.x && r.y >= app.y
    && r.x + r.width <= app.x + app.width + 2 && r.y + r.height <= app.y + app.height + 2;
  return app.width >= 300 && app.height >= 200 && paint.orangePixels > app.width * app.height * 0.06
    && paint.pale.some(r => inside(r) && r.width >= 120 && r.height >= 70)
    && paint.buttons.filter(r => inside(r) && r.width >= 40 && r.height <= 65).length >= 3
    && paint.greenPixels >= 100;
}

test.describe("ScummVM's ordinary Wayland GLES launcher inside Sway", () => {
  test.use({ deviceScaleFactor: 1, viewport: { width: 1440, height: 1000 } });

  test("paints the launcher, handles its dialog and quits without taking the compositor's DRM master", async ({ page }) => {
    test.setTimeout(480_000);
    await gotoMachine(page, "sway");
    await showDemo(page);
    await expect.poll(async () => (await page.locator(".kdemo-surface-controls").allInnerTexts()).join(" "),
      { timeout: 180_000 }).toMatch(/webgl2-gl/i);
    await expect.poll(async () => {
      const p = await painted(page); return p.footPixels / (p.width * p.height);
    }, { timeout: 180_000, intervals: [1_000] }).toBeGreaterThan(0.5);
    const swayOwner = await owner(page);
    expect(swayOwner).toBeGreaterThan(0);

    // Ordinary wrapper chooses Wayland from the actual inherited compositor
    // socket. No SDL/GL driver overrides or test-created theme/config files.
    // This real interactive shell waits for the exact wrapper PID, then saves
    // its exit status and the post-wait process table. Echoed input cannot
    // manufacture these files. Existing bug: failed graphics setup exits 0,
    // which is why rendered launcher/dialog assertions precede status checks.
    await canvas(page).click({ position: { x: 100, y: 140 } });
    await typePhysicalText(page, "/usr/local/bin/scummvm & launch=$!; wait $launch; result=$?; "
      + "printf '%s\\n' $result > /tmp/scumm-sway-result; "
      + "test ! -d /proc/$launch && echo reaped > /tmp/scumm-sway-wrapper; "
      + "ps -A -o pid,comm > /tmp/scumm-sway-processes\n", { delay: 30 });

    await expect.poll(async () => isLauncher(await painted(page)),
      { timeout: 180_000, intervals: [1_000] }).toBe(true);
    expect(await owner(page)).toBe(swayOwner);
    const launcher = await painted(page);
    await test.info().attach("scummvm-wayland-launcher", { body: await canvas(page).screenshot(), contentType: "image/png" });

    // The shipped highres landscape list layout puts About immediately
    // above Quit at the bottom of its right button column. Click the actual
    // painted button, avoiding guessed fixed coordinates or a shortcut that
    // Search might consume. About's modal dims the orange launcher and draws
    // its own large pale dialog; this repaint is much larger than a cursor.
    expect(launcher.orange.width).toBeGreaterThan(launcher.orange.height);
    const rightButtons = launcher.buttons.filter(r => r.width >= 40 && r.height <= 65
      && r.x > launcher.orange.x + launcher.orange.width * 0.65).sort((a, b) => a.y - b.y);
    expect(rightButtons.length).toBeGreaterThanOrEqual(3);
    const about = rightButtons.at(-2)!;
    const box = (await canvas(page).boundingBox())!;
    await canvas(page).click({ position: {
      x: (about.x + about.width / 2) * box.width / launcher.width,
      y: (about.y + about.height / 2) * box.height / launcher.height,
    } });
    await expect.poll(async () => {
      const p = await painted(page);
      return p.orangePixels < launcher.orangePixels * 0.6
        && p.pale.some(r => r.width >= 250 && r.height >= 150);
    }, { timeout: 60_000, intervals: [500, 1_000] }).toBe(true);
    expect(await owner(page)).toBe(swayOwner);
    await test.info().attach("scummvm-wayland-about", { body: await canvas(page).screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect.poll(async () => isLauncher(await painted(page)), { timeout: 60_000 }).toBe(true);

    // DefaultEventManager's POSIX global keymap maps Ctrl+Q to EVENT_QUIT.
    // Cooperative application Quit, not a kill/interrupt/compositor close.
    await page.keyboard.press("Control+KeyQ");
    await expect.poll(async () => {
      const p = await painted(page); return p.footPixels / (p.width * p.height);
    }, { timeout: 90_000, intervals: [1_000] }).toBeGreaterThan(0.5);
    expect(await owner(page), "ScummVM never becomes the KMS owner").toBe(swayOwner);
    await canvas(page).click({ position: { x: 100, y: 140 } });
    await typePhysicalText(page, "swaymsg exit\n", { delay: 40 });
    await expect.poll(() => owner(page), { timeout: 60_000 }).toBe(0);
    await expect(page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }))
      .toHaveAttribute("aria-current", "true", { timeout: 60_000 });

    // Capture $? in the launching shell itself before any probe child runs.
    await page.locator(".kshell-terminal-slot:not([hidden]) .xterm-screen").click();
    await typePhysicalText(page, 'printf "SWAY_STATUS:%s\\n" "$?"\n', { delay: 30 });
    await expect.poll(() => page.locator(".kshell-terminal-slot:not([hidden]) .xterm-rows").innerText(),
      { timeout: 30_000 }).toContain("SWAY_STATUS:0");
    const report = await runTerminalCommand(page,
      "printf 'SCUMM_STATUS:'; cat /tmp/scumm-sway-result; "
      + "printf 'WRAPPER:'; cat /tmp/scumm-sway-wrapper; "
      + "cat /tmp/scumm-sway-processes");
    expect(report.output).toMatch(/SCUMM_STATUS:0\s*WRAPPER:reaped/);
    expect(report.output, "engine and exact waited wrapper are reaped while Sway was still alive").not.toContain("scummvm");
    await expect.poll(async () => (await runTerminalCommand(page, "ps -A -o pid,comm")).output,
      { timeout: 60_000, intervals: [500, 1_000] },
    ).not.toMatch(/scummvm|\/sway(?:bar|bg)?\b|\/foot\b/);
    expect(await owner(page)).toBe(0);
  });
});
