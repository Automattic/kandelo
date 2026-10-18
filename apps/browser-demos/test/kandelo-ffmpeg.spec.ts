import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  gotoMachine,
  gotoMachineOrSkip,
  machineUrl,
  VfsProductImageMissing,
} from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

/**
 * FFmpeg in browser machines: the shell image carries ffmpeg, ffprobe and
 * ffplay as lazy files, and two presentation profiles (not in the gallery)
 * open the panes they draw into.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "../../../packages/registry/ffmpeg/test/fixtures");
const ACCEPTANCE = process.env.KANDELO_FFMPEG_ACCEPTANCE === "1";

/** In acceptance runs an unavailable machine is a failure, not a skip. */
function open(page: Page, profile: string): Promise<void> {
  return ACCEPTANCE ? gotoMachine(page, profile) : gotoMachineOrSkip(page, profile);
}

/**
 * Boot a profile of the shell image that the gallery does not list. The
 * image URL comes from the gallery's shell machine, the same image.
 */
async function openShellImageProfile(page: Page, profile: string): Promise<void> {
  let shellUrl: string;
  try {
    shellUrl = await machineUrl(page, "shell");
  } catch (error) {
    if (!ACCEPTANCE && error instanceof VfsProductImageMissing) {
      test.skip(true, `shell image: ${error.message}`);
      return;
    }
    throw error;
  }
  const url = new URL(shellUrl, "https://kandelo.invalid/");
  url.searchParams.set("profile", profile);
  const target = process.env.KANDELO_TEST_BASE_URL === undefined
    ? `${url.pathname}${url.search}`
    : url.href;
  await page.goto(target, { waitUntil: "domcontentloaded" });
}

/** Distinct colours in a 2D canvas, counting up to 9. */
function distinctColors(canvas: Locator): Promise<number> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (seen.size > 8) break;
    }
    return seen.size;
  });
}

/**
 * How many of testsrc's six saturated bar colours (red, green, blue, yellow,
 * cyan, magenta) appear in a screenshot of `target`. The KMS pane is a WebGL
 * canvas, whose pixels a page cannot read back, so the screenshot is decoded
 * in the page instead.
 */
async function testsrcBarColours(page: Page, target: Locator): Promise<number> {
  const png = (await target.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const hi = (v: number) => v > 200;
    const lo = (v: number) => v < 60;
    const found = new Set<string>();
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (hi(r) && lo(g) && lo(b)) found.add("red");
      else if (lo(r) && hi(g) && lo(b)) found.add("green");
      else if (lo(r) && lo(g) && hi(b)) found.add("blue");
      else if (hi(r) && hi(g) && lo(b)) found.add("yellow");
      else if (lo(r) && hi(g) && hi(b)) found.add("cyan");
      else if (hi(r) && lo(g) && hi(b)) found.add("magenta");
      if (found.size === 6) break;
    }
    return found.size;
  }, png);
}

/**
 * Whether testsrc's picture arrived with its red and blue channels in the
 * right places. A red/blue swap maps testsrc's six bar colours onto the same
 * six, so the count above cannot see one; the bars' order can. testsrc's top
 * rows lie outside its moving circle and band and read, left to right,
 * black, red, ..., blue, yellow, ..., cyan, white, so on the picture's top
 * row red comes before blue. Returns the first x of each on that row (-1 if
 * absent), found below whatever letterbox sits above the picture.
 */
async function testsrcTopRowRedBlue(
  page: Page,
  target: Locator,
): Promise<{ red: number; blue: number }> {
  const png = (await target.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const { width, height } = bitmap;
    const { data } = ctx.getImageData(0, 0, width, height);
    const hi = (v: number) => v > 200;
    const lo = (v: number) => v < 60;
    const at = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const saturated = ([r, g, b]: number[]) =>
      (hi(r) || hi(g) || hi(b)) && (lo(r) || lo(g) || lo(b));
    // The picture's top row: the first row that is mostly bar colours.
    let top = -1;
    for (let y = 0; y < height && top < 0; y++) {
      let n = 0;
      for (let x = 0; x < width; x++) if (saturated(at(x, y))) n++;
      if (n > width / 3) top = y;
    }
    if (top < 0) return { red: -1, blue: -1 };
    const y = Math.min(top + 3, height - 1);  // clear of edge filtering
    let red = -1;
    let blue = -1;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y);
      if (red < 0 && hi(r) && lo(g) && lo(b)) red = x;
      if (blue < 0 && lo(r) && lo(g) && hi(b)) blue = x;
    }
    return { red, blue };
  }, png);
}

async function openSurface(page: Page, label: "Demo" | "Terminal") {
  const view = page
    .getByLabel("Computer views")
    .getByRole("button", { name: label, exact: true });
  await view.waitFor({ state: "visible", timeout: 60_000 });
  if ((await view.getAttribute("aria-current")) !== "true") await view.click();
}

async function terminalText(page: Page): Promise<string> {
  if ((await page.locator(".xterm-rows").count()) === 0) return "";
  const rows = await page.locator(".xterm-rows").first().locator(":scope > div").allInnerTexts();
  return rows.join("\n");
}

const displayCanvas = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

/** sha256 of a fixture, the digest the machine's sha256sum must print. */
function fixtureSha256(name: string): string {
  return createHash("sha256").update(readFileSync(join(FIXTURES, name))).digest("hex");
}

test("ffmpeg encodes and decodes bit-exactly in a browser machine", async ({ page }) => {
  test.setTimeout(600_000);
  await open(page, "shell");
  // The terminal shows rows, not bytes, so compare digests computed in the
  // machine: the framecrc text must equal the committed fixture exactly.
  const enc = await runTerminalCommand(page,
    "ffmpeg -nostdin -v error -f lavfi -i testsrc=duration=2:size=176x144:rate=10 " +
    "-threads 1 -c:v mpeg4 -q:v 5 -g 5 -bf 1 -flags +bitexact -fflags +bitexact " +
    "-f framecrc - | sha256sum");
  expect(enc.exitCode, enc.output).toBe(0);
  expect(enc.output).toContain(fixtureSha256("fixture.browser-encode.framecrc"));

  const dec = await runTerminalCommand(page,
    "ffmpeg -nostdin -v error -f lavfi -i testsrc=duration=2:size=176x144:rate=10 " +
    "-threads 1 -c:v mpeg4 -q:v 5 -g 5 -bf 1 -flags +bitexact -fflags +bitexact " +
    "-f mp4 -movflags frag_keyframe+empty_moov pipe:1 | " +
    "ffmpeg -nostdin -v error -threads 1 -i pipe:0 -map 0:v -flags +bitexact -fflags +bitexact " +
    "-f framecrc - | sha256sum");
  expect(dec.exitCode, dec.output).toBe(0);
  expect(dec.output).toContain(fixtureSha256("fixture.video.framecrc"));
});

test("ffmpeg draws into the framebuffer pane", async ({ page }) => {
  test.setTimeout(600_000);
  await openShellImageProfile(page, "ffmpeg-fbdev");
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 300_000 });
  await canvas.click(); // the audio-autoplay gesture
  await expect.poll(() => distinctColors(canvas), { timeout: 240_000 }).toBeGreaterThan(8);
  await canvas.screenshot({ path: test.info().outputPath("ffmpeg-fbdev.png") });
});

test("ffplay shows video in the KMS pane", async ({ page }) => {
  test.setTimeout(600_000);
  await openShellImageProfile(page, "ffplay");
  const canvas = displayCanvas(page);
  await expect(canvas).toBeVisible({ timeout: 300_000 });
  await canvas.click();
  // SDL's GLES2 renderer draws through WebGL. A failed renderer leaves the
  // pane on its placeholder, and a renderer whose draws WebGL rejects leaves
  // it black; only drawn video shows testsrc's colour bars.
  await expect.poll(() => testsrcBarColours(page, canvas),
    { timeout: 240_000, intervals: [1_000, 2_000, 5_000] }).toBe(6);
  const kmsOrder = await testsrcTopRowRedBlue(page, canvas);
  expect(kmsOrder.red, JSON.stringify(kmsOrder)).toBeGreaterThanOrEqual(0);
  expect(kmsOrder.red, JSON.stringify(kmsOrder)).toBeLessThan(kmsOrder.blue);
  await canvas.screenshot({ path: test.info().outputPath("ffplay.png") });
});

test.describe("in the Omarchy desktop", () => {
  // The desktop machine declares a 1920x1080 minimum display.
  test.use({ viewport: { width: 1920, height: 1200 } });

test("ffplay runs as a Wayland client in the Omarchy desktop", async ({ page }) => {
  test.setTimeout(600_000);
  await open(page, "omarchy");
  await openSurface(page, "Terminal");
  // Quickshell reports its workspace after attaching the desktop bar.
  await expect.poll(() => terminalText(page), { timeout: 240_000 }).toMatch(/BAR_WORKSPACE active=1/);

  // CTRL+Return opens foot; type the command into it with real keys.
  await expect.poll(async () => {
    await openSurface(page, "Demo");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await openSurface(page, "Terminal");
    await page.waitForTimeout(15_000);
    return terminalText(page);
  }, { timeout: 180_000, intervals: [0] }).toMatch(/GLDRAW app_id=foot/);
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (const key of "ffplay -an -f lavfi testsrc") {
    await page.keyboard.press(key === " " ? "Space" : key === "-" ? "Minus" : key);
  }
  await page.keyboard.press("Enter");

  // The compositor draws ffplay's GLES2 window...
  await openSurface(page, "Terminal");
  await expect.poll(() => terminalText(page), { timeout: 180_000 }).toMatch(/GLDRAW app_id=SDL_App/);
  // ...and keeps drawing the desktop. ffplay and the compositor share one
  // WebGL context; when they shared vertex-attribute state, ffplay's draws
  // broke every compositor draw and the whole display went black.
  await openSurface(page, "Demo");
  const canvas = displayCanvas(page);
  await expect.poll(() => testsrcBarColours(page, canvas),
    { timeout: 60_000, intervals: [1_000, 2_000, 5_000] }).toBe(6);
  // ffplay's GL buffer must reach the screen in its own channel order: the
  // compositor reads it as the format libwayland-egl declares for it.
  const order = await testsrcTopRowRedBlue(page, canvas);
  expect(order.red, JSON.stringify(order)).toBeGreaterThanOrEqual(0);
  expect(order.red, JSON.stringify(order)).toBeLessThan(order.blue);
  await canvas.screenshot({ path: test.info().outputPath("omarchy-ffplay.png") });
});
});
