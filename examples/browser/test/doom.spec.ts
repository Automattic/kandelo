/**
 * DOOM browser-demo smoke test.
 *
 * Catches the class of bug where fbdoom links and runs but silently
 * traps before reaching the title-screen demo loop, and where pressing
 * Esc has no effect (i.e. the kernel input pipeline isn't actually
 * wired through to fbDOOM's `/dev/tty` reader). The PR that introduced
 * the demo had a broken-on-second-build patch step that produced exactly
 * this failure mode and went unnoticed.
 *
 * Marked @slow because it boots the full fbdoom wasm and fetches the
 * ~4 MB DOOM shareware IWAD from a Linux-distro mirror on first run
 * (cached via the Cache API thereafter).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FBDOOM_PATH = join(REPO_ROOT, "examples/libs/fbdoom/fbdoom.wasm");

const skipIfMissing = !existsSync(FBDOOM_PATH);

test.describe("@slow doom", () => {
  test.skip(
    skipIfMissing,
    "fbdoom.wasm missing — run examples/libs/fbdoom/build-fbdoom.sh",
  );

  test("boots without trapping and responds to Esc", async ({ page }) => {
    const stdout: string[] = [];
    const errors: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("[doom stdout]")) stdout.push(text);
      // The kernel worker reports wasm traps as `pid=N _start() hit
      // unreachable trap: <reason>` on the warn channel.
      if (msg.type() === "error" && /trap|exitCode/.test(text)) errors.push(text);
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto("/pages/doom/");
    await page.click("#start");

    await page.waitForFunction(
      () => /Running/.test(document.getElementById("status")?.textContent ?? ""),
      { timeout: 60_000 },
    );

    // Wait for fbDOOM to finish booting and start its title-screen demo
    // loop. "Ready to read keycodes." is the last init-time message
    // printed by kbd_init() — once we see it, fbdoom is in D_DoomLoop.
    await expect
      .poll(() => stdout.some((l) => l.includes("Ready to read keycodes")), {
        timeout: 30_000,
      })
      .toBe(true);

    expect(stdout.some((l) => l.includes("101-key keyboard found"))).toBe(true);
    expect(stdout.some((l) => l.includes("Using keyboard on /dev/tty"))).toBe(true);
    // No traps — the I_InitInput signature mismatch lands here.
    expect(errors.filter((e) => /unreachable trap/.test(e))).toHaveLength(0);

    // Sample the canvas, press Esc, sample again — the menu has visibly
    // different pixels than the title-screen demo loop.
    const canvas = page.locator("#fb");
    await canvas.click();
    // Take two samples spaced apart so we baseline the natural variance
    // of the demo-loop animation.
    await page.waitForTimeout(500);
    const sampleA = await hashCanvas(page);
    await page.waitForTimeout(500);
    const sampleB = await hashCanvas(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1_000);
    const afterEsc = await hashCanvas(page);

    // Demo-loop tics shift the hash by some delta frame to frame; the
    // menu should land somewhere clearly outside that band.
    const naturalDelta = Math.abs(sampleA - sampleB);
    const escDelta = Math.abs(sampleA - afterEsc);
    expect(escDelta).toBeGreaterThan(naturalDelta * 4);
  });
});

async function hashCanvas(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.getElementById("fb") as HTMLCanvasElement;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    // djb2 across a strided sample — full O(n) is overkill for a frame
    // hash and getImageData on a 640×400 canvas is the slow path here.
    let h = 5381;
    for (let i = 0; i < data.length; i += 521) h = ((h << 5) + h + data[i]) | 0;
    return h;
  });
}
