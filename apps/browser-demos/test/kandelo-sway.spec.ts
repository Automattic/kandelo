import { test } from "./support/persistent-page";
import { expect, type Locator, type Page } from "../playwright-test";

import { gotoMachine, waitForMachineBootInput } from "./support/kandelo-machine";
import { setInternalsOpen } from "./support/dock";
import { workspaceButtonPixels } from "./support/sway-workspace-pixels";
import { typePhysicalText } from "./support/physical-typing";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { extractZipEntry, parseZipCentralDirectory } from "../../../host/src/vfs/zip";

// Browser checks must never take the user's desktop focus.
test.use({ headless: true });

/** Show the Internals syslog, Graphics, or the machine's terminal.
 *  Internals is opened through More in the dock; showing another view means
 *  closing it and selecting that view. */
async function openSurface(page: Page, label: "Internals" | "Graphics" | "Terminal") {
  if (label === "Internals") await waitForMachineBootInput(page);
  await page.getByRole("button", { name: "More", exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
  await setInternalsOpen(page, label === "Internals");
  if (label !== "Internals") {
    const view = page
      .getByLabel("Computer views")
      .getByRole("button", { name: label, exact: true });
    if ((await view.getAttribute("aria-current")) !== "true") await view.click();
  }
}

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

/** The machine's terminal: the shell that runs sway, and sway's stderr. */
async function terminalText(page: Page): Promise<string> {
  if ((await page.locator(".kshell-host:visible .xterm-rows").count()) === 0) return "";
  const rows = await page.locator(".kshell-host:visible .xterm-rows").first().locator(":scope > div").allInnerTexts();
  return rows.join("\n");
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas").first();

/** Full text of the Modeset status chip in the dock ("" while mounting). */
async function chipText(page: Page): Promise<string> {
  const texts = await page
    .locator(".kdemo-surface-controls")
    .filter({ hasText: "flips" })
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.join(" ");
}

/** The DRM master published by the machine's display statistics. */
async function displayOwner(page: Page): Promise<number> {
  // KMS stays mounted and publishes statistics while Terminal hides its slot;
  // the release check runs there, independently of the visible canvas.
  const owner = await page.locator(".kmachine-primary .kmodeset-surface")
    .getAttribute("data-kms-owner-pid");
  return owner === null ? Number.NaN : Number(owner);
}

type Rgb = [number, number, number];

/** The canvas and the size of the output sway drives on it. */
type Output = { canvas: Locator; width: number; height: number };

/** The connector mode follows the pane's device pixels, and the Modeset
 *  chip reports it ("1088×612 · 40 flips · …"). */
async function output(page: Page): Promise<Output> {
  const mode = (await chipText(page)).match(/(\d+)×(\d+)/);
  expect(mode, "the Modeset chip reports the connector mode").not.toBeNull();
  return { canvas: canvasLocator(page), width: Number(mode![1]), height: Number(mode![2]) };
}

/** A region of the output, as it is on screen. */
async function outputShot({ canvas, ...size }: Output, x: number, y: number, width: number, height: number) {
  const box = (await canvas.boundingBox())!;
  const sx = box.width / size.width;
  const sy = box.height / size.height;
  return canvas.page().screenshot({
    animations: "disabled",
    clip: { x: box.x + x * sx, y: box.y + y * sy, width: width * sx, height: height * sy },
  });
}

/** The mean color of each pixel row, or each column, of a PNG, decoded in
 *  the page. */
async function lineColors(page: Page, png: Buffer, axis: "row" | "column"): Promise<Rgb[]> {
  return page.evaluate(async ([base64, axis]) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const [lines, length] = axis === "row" ? [height, width] : [width, height];
    const colors: [number, number, number][] = [];
    for (let line = 0; line < lines; line++) {
      const sum = [0, 0, 0];
      for (let i = 0; i < length; i++) {
        const pixel = axis === "row" ? line * width + i : i * width + line;
        for (let c = 0; c < 3; c++) sum[c] += data[pixel * 4 + c];
      }
      colors.push([sum[0] / length, sum[1] / length, sum[2] / length]);
    }
    return colors;
  }, [png.toString("base64"), axis] as const);
}

async function meanColor(page: Page, png: Buffer): Promise<Rgb> {
  const rows = await lineColors(page, png, "row");
  const sum = rows.reduce((a, r) => [a[0] + r[0], a[1] + r[1], a[2] + r[2]], [0, 0, 0]);
  return [sum[0] / rows.length, sum[1] / rows.length, sum[2] / rows.length];
}

/** The middle of the output, where the tiled windows are. */
const middle = (out: Output) => outputShot(out, out.width / 4, out.height / 4, out.width / 2, out.height / 2);

/** The painted bands belong to different normal clients: native Swaybar
 * is at the bottom; Sway's focused 12pt title remains at the top. */
async function paintedBandHeight(out: Output, edge: "top" | "bottom", color: Rgb): Promise<number> {
  const height = Math.min(128, out.height);
  let measured = 0;
  // The renderer can claim its CRTC before a lazy panel/title client paints.
  // Measure the same actual edge band only after its first repaint.
  await expect(async () => {
    const png = await outputShot(out, out.width / 2, edge === "top" ? 0 : out.height - height,
      out.width / 2, height);
    const rows = await out.canvas.page().evaluate(async ([base64, color]) => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      return Array.from({ length: image.height }, (_, y) => {
        let background = 0;
        for (let x = 0; x < image.width; x++) {
          const p = (y * image.width + x) * 4;
          if ([0, 1, 2].every(channel => Math.abs(image.data[p + channel] - color[channel]) <= 3)) background++;
        }
        return background / image.width;
      });
    }, [png.toString("base64"), color] as const);
    if (edge === "bottom") rows.reverse();
    // Permit a thin toolkit/window border, but require a contiguous painted
    // band adjoining the actual output edge. Text occupies under half a row.
    const first = rows.findIndex(background => background >= 0.5);
    expect(first, `${edge} band reaches the output edge`).toBeGreaterThanOrEqual(0);
    expect(first * height / rows.length).toBeLessThanOrEqual(4);
    const boundary = rows.findIndex((background, row) => row > first && background < 0.5);
    expect(boundary, `${edge} band has a measured nonempty boundary`).toBeGreaterThan(first);
    measured = boundary * height / rows.length;
  }).toPass({ timeout: 120_000, intervals: [100, 500, 1_000] });
  return measured;
}

const barHeight = (out: Output) => paintedBandHeight(out, "bottom", [50, 50, 50]);
// Sway 1.12 config.c: focused.background = 0x285577FF; the shipped config
// preserves that title color while choosing the readable 12pt font.
const titleHeight = (out: Output) => paintedBandHeight(out, "top", [40, 85, 119]);

/** Native Swaybar's focused-workspace background and its real text ink. */
async function workspaceButton(out: Output) {
  const height = await barHeight(out);
  const png = await outputShot(out, 0, out.height - height, out.width / 2, height);
  const pixels = await out.canvas.page().evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    // Return independent test pixels, so the pure Node oracle requires no
    // eval/import injection into the app or production rendering changes.
    return { width: image.width, height: image.height, data: Array.from(image.data) };
  }, png.toString("base64"));
  const button = workspaceButtonPixels(pixels);
  if (button === null) return null;
  return { x: button.x * (out.width / 2) / pixels.width,
    y: out.height - height + button.y * height / pixels.height,
    width: button.width * (out.width / 2) / pixels.width,
    height: button.height * height / pixels.height };
}

async function nativeBarProcess(page: Page) {
  await releasePointer(page);
  await openSurface(page, "Internals");
  await page.getByRole("tab", { name: "Procs", exact: true }).click();
  const commands = page.locator(".ktable tbody tr > td:last-child");
  await expect(commands.filter({ hasText: /^(?:\/\S*\/)?swaybar(?:\s|$)/ }))
    .toHaveCount(1, { timeout: 120_000 });
  await expect(commands.filter({ hasText: /^(?:\/\S*\/)?sfwbar(?:\s|$)/ })).toHaveCount(0);
  await openSurface(page, "Graphics");
  await canvasLocator(page).focus();
}

/** Inspector clicks must not become relative captured guest pointer input. */
async function releasePointer(page: Page) {
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __swayReleaseCapture?: () => void };
    if (!scope.__swayReleaseCapture) {
      scope.__swayReleaseCapture = () => {
        if (document.pointerLockElement) document.exitPointerLock();
      };
      // Handle the preceding real click's asynchronous capture completion too.
      document.addEventListener("pointerlockchange", scope.__swayReleaseCapture);
    }
    scope.__swayReleaseCapture();
  });
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
}

/** Read Sway's own IPC result through the shipped kernel-owned VFS view. */
async function workspaceEvidence(page: Page, file: string, focused: string) {
  await releasePointer(page);
  await openSurface(page, "Internals");
  await page.getByRole("tab", { name: "VFS", exact: true }).click();
  await page.getByRole("button", { name: "/", exact: true }).click();
  const row = (name: string) => page.locator(".ktable tbody tr").filter({
    has: page.locator("td:first-child", { hasText: new RegExp(`^${name}$`) }),
  }).first();
  await row("tmp/").click();
  const preview = page.locator("pre").filter({ hasText: /^\s*\[[\s\S]*\]\s*$/ });
  await expect.poll(async () => {
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    if (await row(file).count() !== 1) return false;
    await row(file).click();
    return preview.isVisible();
  }, { timeout: 60_000, intervals: [500, 1_000] }).toBe(true);
  const text = await preview.innerText();
  await test.info().attach(file, { body: text, contentType: "application/json" });
  const workspaces = JSON.parse(text) as { name: string; focused: boolean; visible: boolean }[];
  expect(workspaces.filter(workspace => workspace.focused).map(workspace => workspace.name)).toEqual([focused]);
  expect(workspaces.find(workspace => workspace.name === focused)?.visible).toBe(true);
  await openSurface(page, "Graphics");
  await canvasLocator(page).focus();
}

async function statusLine(out: Output) {
  const height = await barHeight(out), width = Math.min(out.width / 2, height * 5);
  // The rightmost clock contains no task labels or terminal cursor. Its
  // normal HH:MM:SS value must change without keyboard/pointer activity.
  return outputShot(out, out.width - width, out.height - height, width, height);
}

async function clockInk(page: Page, png: Buffer, before?: Buffer) {
  return page.evaluate(async ([current, previous]) => {
    const decode = async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      return image;
    };
    const image = await decode(current), old = previous ? await decode(previous) : undefined;
    if (old && (old.width !== image.width || old.height !== image.height))
      throw new Error("clock region resized during tick check");
    const bright = (data: Uint8ClampedArray<ArrayBufferLike>, at: number) =>
      data[at] > 180 && data[at + 1] > 180 && data[at + 2] > 180;
    let pixels = 0, changed = 0;
    for (let at = 0; at < image.data.length; at += 4) {
      const now = bright(image.data, at);
      if (now) pixels++;
      if (old && now !== bright(old.data, at)) changed++;
    }
    return { pixels, changed };
  }, [png.toString("base64"), before?.toString("base64")] as const);
}

async function expectClockTicks(page: Page, out: Output) {
  await expect.poll(async () => (await clockInk(page, await statusLine(out))).pixels,
    { timeout: 120_000, intervals: [1_000] }).toBeGreaterThan(20);
  await expect.poll(async () => {
    const before = await statusLine(out);
    await page.waitForTimeout(1_500);
    return (await clockInk(page, await statusLine(out), before)).changed;
  }, { timeout: 120_000, intervals: [1_000] }).toBeGreaterThan(5);
}

/** The columns at the middle of the output, where two tiles meet. */
const seam = (out: Output) => outputShot(out, out.width / 2 - 8, out.height / 4, 16, out.height / 2);

/** foot's background is a dark, neutral gray. */
const isFoot = ([r, g, b]: Rgb) => r > 20 && r < 60 && Math.abs(r - g) < 8 && Math.abs(r - b) < 8;

/** The sway wallpaper, and sway's focused window border, are blue. */
const isBlue = ([r, , b]: Rgb) => b > r + 40;

/** swaynag's warning bar is yellow. */
const isWarning = ([r, g, b]: Rgb) => r > 180 && g > 120 && b < 90;

/** Press a point of the output, scaled to the canvas on screen. */
async function clickOutput({ canvas, ...size }: Output, x: number, y: number) {
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: (x * box.width) / size.width, y: (y * box.height) / size.height } });
}

/** Exit through Sway's actual confirmation action, then observe its shell. */
async function exitSway(page: Page, out: Output, marker: string) {
  await canvasLocator(page).focus();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("q");
  // swaynag lays out Yes, exit sway about 56–155 pixels from the right edge.
  const top = 120;
  let band: number[] = [];
  await expect.poll(async () => {
    const rows = await lineColors(page, await outputShot(out, 0, 0, out.width, top), "row");
    band = rows.flatMap((row, y) => isWarning(row) ? [(y * top) / rows.length] : []);
    return band.length;
  }, { timeout: 120_000, intervals: [1_000] }).toBeGreaterThan(0);
  await clickOutput(out, out.width - 105, (band[0] + band[band.length - 1]) / 2);
  // A signal/window close or a visible prompt is not this completion proof.
  // Require native authority release and automatic terminal handback first.
  await expect.poll(() => displayOwner(page), { timeout: 60_000 }).toBe(0);
  await expect(page.getByLabel("Computer views")
    .getByRole("button", { name: "Terminal", exact: true }))
    .toHaveAttribute("aria-current", "true", { timeout: 60_000 });
  await releasePointer(page);
  await page.locator(".kshell-host:visible .xterm").first().click();
  await typePhysicalText(page, `echo ${marker}=$?\n`, { delay: 40 });
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toMatch(new RegExp(`${marker}=0(?:\\s|$)`));
}

/**
 * Browser gate for the sway machine: upstream sway on wlroots' GLES2
 * renderer, which reaches the host's WebGL2 bridge through libEGL's GBM
 * platform. The Node gates (host/test/sway-smoke.test.ts) run the pixman
 * renderer, so this spec is the only gate on that path for sway.
 *
 * Gates:
 *   1. The machine runs sway, and sway's GL context owns the canvas: the
 *      Modeset chip reports the `webgl2-gl` renderer.
 *   2. The native Swaybar paints its clock glyphs and redraws
 *      HH:MM:SS every second, without input.
 *   3. The config's `exec $term` starts foot, whose window fills the
 *      output. Once its prompt holds still, a keystroke reaches it: the
 *      shell's echo changes it.
 *   4. Alt+2 shows an empty workspace. Native workspace buttons return to
 *      the first Foot; real swaymsg IPC confirms both workspace identities.
 *   5. Alt+Return opens a second foot, and sway tiles the two: the new
 *      window's focused border runs down the middle of the output.
 *   6. Alt+M then Q starts swaynag, and its "Yes, exit sway" button runs
 *      `swaymsg exit`: sway exits with status 0 to the machine's shell.
 *   7. A sway started next on the pixman renderer reaches the canvas that
 *      the GLES2 session gave up: the vblank pump presents its CPU frames,
 *      so the same native Swaybar clock moves again.
 */
test("Kandelo sway tiles foot terminals above its native workspace bar with wlroots' GLES2 renderer", async ({ page }) => {
  test.setTimeout(420_000);

  await gotoMachine(page, "sway");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running .*\/usr\/bin\/sway/);
  expect(await syslogText(page)).not.toMatch(/configured command failed/);

  // Gate 1.
  await openSurface(page, "Graphics");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => chipText(page), { timeout: 120_000 })
    .toMatch(/webgl2-gl/i);
  await expect.poll(() => displayOwner(page), { timeout: 120_000 }).toBeGreaterThan(0);
  const glesOwner = await displayOwner(page);
  let out = await output(page);

  // Gate 2.
  await expectClockTicks(page, out);
  await nativeBarProcess(page);

  // Gate 3. foot is lazy and large, so its first frame can take a while.
  await expect
    .poll(async () => isFoot(await meanColor(page, await middle(out))), { timeout: 180_000, intervals: [2_000] })
    .toBe(true);
  // Return DOM keyboard capture without clicking a guest control: (5,5)
  // belongs to the real desktop, so a click can change its compositor seat.
  await canvasLocator(page).focus();
  await expect(canvasLocator(page)).toBeFocused();
  const prompt = () => outputShot(out, 0, 40, out.width / 2, 200);
  let idle = await prompt();
  await expect
    .poll(async () => {
      await page.waitForTimeout(1_000);
      const next = await prompt();
      const still = next.equals(idle);
      idle = next;
      return still;
    }, { timeout: 60_000, intervals: [0] })
    .toBe(true);
  await typePhysicalText(page, "echo sway-gles2-ok\n", { delay: 40 });
  await expect
    .poll(async () => (await prompt()).equals(idle), { timeout: 60_000, intervals: [500, 1_000] })
    .toBe(false);

  // Gate 4.
  const buttons: { first: Awaited<ReturnType<typeof workspaceButton>>;
    second: Awaited<ReturnType<typeof workspaceButton>> } = { first: null, second: null };
  await expect.poll(async () => {
    buttons.first = await workspaceButton(out);
    return buttons.first !== null;
  }, { timeout: 60_000 }).toBe(true);
  const firstWorkspace = buttons.first!;
  await page.keyboard.press("Alt+2");
  await expect
    .poll(async () => isBlue(await meanColor(page, await middle(out))), { timeout: 120_000, intervals: [2_000] })
    .toBe(true);
  // Swaybar is a separate native client: wait for its own workspace repaint.
  await expect.poll(async () => {
    buttons.second = await workspaceButton(out);
    return buttons.second !== null && buttons.second.x > firstWorkspace.x;
  }, { timeout: 60_000 }).toBe(true);
  // Query from an actual terminal on workspace two, then close that client.
  // This observes compositor state rather than inferring it from blue paint.
  await page.keyboard.press("Alt+Enter");
  await expect.poll(async () => isFoot(await meanColor(page, await middle(out))),
    { timeout: 180_000, intervals: [1_000] }).toBe(true);
  await typePhysicalText(page, "swaymsg -r -t get_workspaces > /tmp/sway-workspace-two\n", { delay: 40 });
  await workspaceEvidence(page, "sway-workspace-two", "2");
  await page.keyboard.press("Alt+Shift+Q");
  await expect.poll(async () => isBlue(await meanColor(page, await middle(out))),
    { timeout: 60_000, intervals: [1_000] }).toBe(true);
  // Click the actual painted workspace-one button, not a guessed coordinate
  // or a host-side workspace setter. Its Foot and IPC must both return.
  await clickOutput(out, firstWorkspace.x + firstWorkspace.width / 2,
    firstWorkspace.y + firstWorkspace.height / 2);
  await expect
    .poll(async () => isFoot(await meanColor(page, await middle(out))), { timeout: 30_000, intervals: [1_000] })
    .toBe(true);
  await canvas.focus();
  await typePhysicalText(page, "swaymsg -r -t get_workspaces > /tmp/sway-workspace-returned\n", { delay: 40 });
  await workspaceEvidence(page, "sway-workspace-returned", "1");

  // Gate 5.
  const tiled = async () => (await lineColors(page, await seam(out), "column")).some(isBlue);
  expect(await tiled()).toBe(false);
  await page.keyboard.press("Alt+Enter");
  await expect.poll(tiled, { timeout: 180_000, intervals: [2_000] }).toBe(true);

  // Gate 6: real swaynag action, owner release, terminal return and exit0.
  await exitSway(page, out, "sway-exit");

  // Gate 7.
  await typePhysicalText(page,
    "WLR_RENDERER=pixman LIBSEAT_BACKEND=noop XDG_RUNTIME_DIR=/tmp XDG_CONFIG_HOME=/usr/share/kandelo"
      + " FONTCONFIG_FILE=/usr/share/kandelo/fonts/fonts.conf /usr/bin/sway -c /usr/share/kandelo/sway/config\n",
    { delay: 20 },
  );
  await openSurface(page, "Graphics");
  // A startup repaint can change the screenshot before the dock drains its
  // 4 Hz statistics. First prove the new session owns the display and its
  // CPU frames reached the scanout presenter; then measure its moving clock.
  await expect.poll(() => displayOwner(page), { timeout: 180_000 }).toBeGreaterThan(0);
  expect(await displayOwner(page)).not.toBe(glesOwner);
  await expect.poll(() => chipText(page), { timeout: 180_000 }).toMatch(/·\s*webgl2\s*$/i);
  out = await output(page);
  await expect
    .poll(async () => isFoot(await meanColor(page, await middle(out))), { timeout: 180_000, intervals: [2_000] })
    .toBe(true);
  await expectClockTicks(page, out);
  await nativeBarProcess(page);
  // This second foreground compositor must retire too; context closure is
  // not a substitute for its real exit or the display's authority release.
  await exitSway(page, out, "sway-pixman-exit");
  await openSurface(page, "Internals");
  await page.getByRole("tab", { name: "Procs", exact: true }).click();
  await expect(page.locator(".ktable tbody tr > td:last-child").filter({
    hasText: /^(?:\/\S*\/)?(?:sway|swaybar|swaynag|swaybg|foot)(?:\s|$)/,
  })).toHaveCount(0, { timeout: 90_000 });
  expect(await displayOwner(page)).toBe(0);
});


/** Activity launch uses its own login/PTY; it must exercise the same real keys. */
test("Sway Activity from shell opens another tiled Foot with Alt+Enter and exits cleanly", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  await gotoMachine(page, "shell");
  await waitForMachineBootInput(page);
  await expect.poll(() => terminalText(page), { timeout: 120_000 })
    .toMatch(/maker@[^\r\n]*[$]\s*$/);
  const computerUrl = page.url();
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const activities = page.getByRole("region", { name: "Installed activities" });
  await activities.getByRole("button", { name: "Apps & Tools", exact: true }).click();
  const sway = activities.locator('[data-image-activity="sway"]');
  await expect(sway).toBeVisible({ timeout: 60_000 });
  await expect(sway.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await sway.getByRole("button", { name: "Start", exact: true }).click();
  await expect(activities).not.toBeVisible({ timeout: 180_000 });
  expect(page.url(), "launch the Activity on this shell computer").toBe(computerUrl);

  await openSurface(page, "Graphics");
  await expect(canvasLocator(page)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => chipText(page), { timeout: 120_000 }).toMatch(/webgl2-gl/i);
  await expect.poll(() => displayOwner(page), { timeout: 120_000 }).toBeGreaterThan(0);
  const compositorOwner = await displayOwner(page);
  const out = await output(page);
  await expectClockTicks(page, out);
  await nativeBarProcess(page);
  await expect.poll(async () => isFoot(await meanColor(page, await middle(out))),
    { timeout: 180_000, intervals: [2_000] }).toBe(true);

  const footPids = async (count: number, attachment: string) => {
    await releasePointer(page);
    await openSurface(page, "Internals");
    await page.getByRole("tab", { name: "Procs", exact: true }).click();
    const rows = page.locator(".ktable tbody tr").filter({
      has: page.locator("td:last-child", { hasText: /^(?:\/\S*\/)?foot(?:\s|$)/ }),
    });
    await expect(rows).toHaveCount(count, { timeout: 120_000 });
    const pids: number[] = [];
    for (const row of await rows.all()) {
      const text = await row.locator("td:first-child").innerText();
      const pid = text.match(/\b\d+\b/);
      expect(pid, "actual process row has a PID").not.toBeNull();
      pids.push(Number(pid![0]));
    }
    await testInfo.attach(attachment, { body: JSON.stringify({ pids, rows: await rows.allInnerTexts() }, null, 2), contentType: "application/json" });
    await openSurface(page, "Graphics");
    await canvasLocator(page).focus();
    await expect(canvasLocator(page)).toBeFocused();
    return pids;
  };
  const before = await footPids(1, "activity-foot-before.json");
  const tiled = async () => (await lineColors(page, await seam(out), "column")).some(isBlue);
  expect(await tiled(), "one initial Foot has no middle tile border").toBe(false);
  await page.keyboard.press("Alt+Enter");
  await expect.poll(tiled, { timeout: 180_000, intervals: [2_000] }).toBe(true);
  const after = await footPids(2, "activity-foot-after.json");
  expect(after.filter(pid => !before.includes(pid)), "Alt+Enter adds one actual Foot process").toHaveLength(1);
  expect(after).toContain(before[0]);
  expect(await displayOwner(page), "same live compositor owns both tiles").toBe(compositorOwner);
  await testInfo.attach("activity-two-foot-tiles.png", { body: await canvasLocator(page).screenshot(), contentType: "image/png" });

  // The shared helper presses Alt+M/Q, clicks real swaynag confirmation,
  // then requires owner0, automatic terminal handback and parent exit status0.
  await exitSway(page, out, "sway-activity-exit");
  await openSurface(page, "Internals");
  await page.getByRole("tab", { name: "Procs", exact: true }).click();
  await expect(page.locator(".ktable tbody tr > td:last-child").filter({
    hasText: /^(?:\/\S*\/)?(?:sway|swaybar|swaynag|swaybg|foot)(?:\s|$)/,
  })).toHaveCount(0, { timeout: 90_000 });
  expect(await displayOwner(page)).toBe(0);
});

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`Sway logical desktop at ${deviceScaleFactor}x`, () => {
    test.use({
      deviceScaleFactor, viewport: { width: 1100, height: 650 },
      page: async ({ page, playwright, browserName, channel, launchOptions,
        contextOptions, baseURL, viewport, extraHTTPHeaders, proxy }, use, testInfo) => {
        // Context DPR emulation alone leaves Chromium/Firefox's native
        // device-pixel box at 1x. Keep the ordinary browser for the 1x case
        // and WebKit's unchanged CSS*DPR fallback path.
        if (deviceScaleFactor !== 2 || browserName === "webkit") {
          await use(page);
          return;
        }
        const browser = await playwright[browserName].launch({
          ...launchOptions, channel, headless: true,
          ...(browserName === "chromium" ? {
            args: [...(launchOptions.args ?? []), "--force-device-scale-factor=2"],
          } : {
            firefoxUserPrefs: {
              ...launchOptions.firefoxUserPrefs, "layout.css.devPixelsPerPx": "2.0",
            },
          }),
        });
        try {
          const context = await browser.newContext({
            ...contextOptions, baseURL, viewport, deviceScaleFactor, extraHTTPHeaders, proxy,
          });
          const nativePage = await context.newPage();
          try {
            await use(nativePage);
          } finally {
            if (testInfo.status !== testInfo.expectedStatus) {
              try {
                await testInfo.attach("native-density-page", {
                  body: await nativePage.screenshot({ timeout: 5_000 }), contentType: "image/png",
                });
              } catch (error) {
                testInfo.annotations.push({ type: "screenshot unavailable", description: String(error) });
              }
            }
          }
        } finally {
          await browser.close();
        }
      },
    });
    test("keeps readable fonts, actual output scale and click targets on a small pane", async ({ page, browserName }, testInfo) => {
      test.setTimeout(300_000);
      // These are the normal resolver-owned archive bytes mounted by the
      // shell image at /usr/share/kandelo, not a test-only substitute config.
      const zip = new Uint8Array(readFileSync(resolveBinary("programs/wayland-demo/kandelo-desktop-data.zip")));
      const entries = parseZipCentralDirectory(zip);
      const member = (path: string) => {
        const entry = entries.find(entry => entry.fileName === path);
        expect(entry, `production archive contains ${path}`).toBeDefined();
        return new TextDecoder().decode(extractZipEntry(zip, entry!));
      };
      expect(member("sway/config")).toContain("font pango:monospace 12");
      expect(member("sway/config")).toContain("set $term foot --config=/usr/share/kandelo/sway/foot.ini");
      expect(member("sway/config")).toContain("bindsym --no-warn $mod+Return exec $term");
      const config = member("sway/config");
      expect(config).toContain("set $mod Mod1");
      expect(config).not.toMatch(/^include \/etc\/sway\/config$/m);
      expect(config).not.toMatch(/^bindsym .*Ctrl\+/m);
      expect(config).toContain("bindsym $mod+1 workspace number 1");
      expect(config).toContain("bindsym $mod+Shift+1 move container to workspace number 1");
      expect(config).toContain("position bottom");
      expect(config).toContain("height 32");
      expect(config).not.toContain("kandelo-sfwbar");
      expect(member("sway/foot.ini")).toContain("font=monospace:size=14");
      expect(member("sway/foot.ini")).toContain("dpi-aware=no");

      await gotoMachine(page, "sway");
      await openSurface(page, "Graphics");
      const canvas = canvasLocator(page);
      await canvas.waitFor({ state: "visible", timeout: 30_000 });
      // Establish density from the actual browser measurement independently
      // of the connector/output being tested. WebKit lacks this native box
      // and retains the production CSS*DPR fallback.
      const pixels = await canvas.evaluate(element => new Promise<{
        cssWidth: number; cssHeight: number; width?: number; height?: number; dpr: number;
      }>(resolve => {
        const observer = new ResizeObserver(([entry]) => {
          const native = entry.devicePixelContentBoxSize?.[0];
          observer.disconnect();
          resolve({ cssWidth: entry.contentRect.width, cssHeight: entry.contentRect.height,
            width: native?.inlineSize, height: native?.blockSize, dpr: devicePixelRatio });
        });
        observer.observe(element);
      }));
      await testInfo.attach("native-density-measurement", {
        body: JSON.stringify(pixels), contentType: "application/json",
      });
      expect(pixels.dpr).toBe(deviceScaleFactor);
      expect(pixels.cssWidth).toBeGreaterThan(0);
      expect(pixels.cssHeight).toBeGreaterThan(0);
      if (browserName !== "webkit") {
        expect(pixels.width, "native device-pixel width").toBeDefined();
        expect(pixels.height, "native device-pixel height").toBeDefined();
      }
      if (pixels.width !== undefined && pixels.height !== undefined) {
        expect(Math.abs(pixels.width - pixels.cssWidth * deviceScaleFactor)).toBeLessThanOrEqual(1);
        expect(Math.abs(pixels.height - pixels.cssHeight * deviceScaleFactor)).toBeLessThanOrEqual(1);
      }
      await expect.poll(() => chipText(page), { timeout: 180_000 }).toMatch(/webgl2-gl/i);
      const out = await output(page);
      await expect.poll(async () => isFoot(await meanColor(page, await middle(out))),
        { timeout: 180_000, intervals: [1_000] }).toBe(true);
      const box = (await out.canvas.boundingBox())!;
      // The mode remains native pixels. In particular, the 2x pane must
      // exercise the old automatic-scale policy's <1200-pixel failure case.
      expect(Math.abs(out.width - box.width * deviceScaleFactor)).toBeLessThanOrEqual(2);
      if (deviceScaleFactor === 2) expect(out.height).toBeLessThan(1200);
      const cssBarHeight = await barHeight(out) * box.height / out.height;
      expect(cssBarHeight, "native Swaybar remains readable in CSS pixels").toBeGreaterThanOrEqual(30);
      expect(cssBarHeight).toBeLessThan(50);
      const cssTitleHeight = await titleHeight(out) * box.height / out.height;
      expect(cssTitleHeight, "12pt Sway title remains readable in CSS pixels").toBeGreaterThanOrEqual(18);
      expect(cssTitleHeight).toBeLessThan(32);

      // Click an actual rendered client using CSS→mode coordinates. Query
      // Sway's real IPC state through its shell; preserve it across exit so
      // the parent terminal can report scale and the committed input marker.
      await clickOutput(out, out.width / 3, out.height / 3);
      await typePhysicalText(page, `echo HIDPI_CLICK_${deviceScaleFactor} > /tmp/sway-hidpi-click\n`, { delay: 40 });
      await typePhysicalText(page, "swaymsg -t get_outputs > /tmp/sway-hidpi-outputs\n", { delay: 40 });
      await typePhysicalText(page, "swaymsg exit\n", { delay: 40 });
      await expect.poll(() => displayOwner(page), { timeout: 60_000 }).toBe(0);
      await expect(page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }))
        .toHaveAttribute("aria-current", "true", { timeout: 60_000 });
      await page.locator(".xterm").first().click();
      await typePhysicalText(page, "echo HIDPI_EXIT=$?; cat /tmp/sway-hidpi-click; "
        + `while IFS= read -r line; do case "$line" in *'"scale"'*) echo HIDPI_SCALE:$line;; esac; done < /tmp/sway-hidpi-outputs\n`, { delay: 20 });
      await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("HIDPI_EXIT=0");
      await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain(`HIDPI_CLICK_${deviceScaleFactor}`);
      await expect.poll(() => terminalText(page), { timeout: 30_000 })
        .toMatch(new RegExp(`HIDPI_SCALE:.*"scale":\\s*${deviceScaleFactor}(?:\\.0)?(?:,|\\s|$)`));
    });
  });
}
