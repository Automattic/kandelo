import { expect, test, type Locator, type Page } from "@playwright/test";

import { gotoMachine } from "./support/kandelo-machine";
import { typePhysicalText } from "./support/physical-typing";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { extractZipEntry, parseZipCentralDirectory } from "../../../host/src/vfs/zip";

// Browser checks must never take the user's desktop focus.
test.use({ headless: true });

/** Show the Internals syslog, the demo canvas, or the machine's terminal.
 *  Internals is an overlay toggle in the dock; showing another view means
 *  closing it and selecting that view. */
async function openSurface(page: Page, label: "Internals" | "Demo" | "Terminal") {
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  await internals.waitFor({ state: "visible", timeout: 30_000 });
  const open = (await internals.getAttribute("aria-pressed")) === "true";
  if (open !== (label === "Internals")) await internals.click();
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
  if ((await page.locator(".xterm-rows").count()) === 0) return "";
  const rows = await page.locator(".xterm-rows").first().locator(":scope > div").allInnerTexts();
  return rows.join("\n");
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

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

/** The right half of swaybar, where the status line is: upstream's config
 *  puts the bar at the top. */
async function barHeight(out: Output): Promise<number> {
  const height = Math.min(128, out.height);
  const png = await outputShot(out, out.width / 2, 0, out.width / 2, height);
  const rows = await out.canvas.page().evaluate(async base64 => {
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
        if ([0, 1, 2].every(channel => Math.abs(image.data[p + channel] - 50) <= 3)) background++;
      }
      return background / image.width;
    });
  }, png.toString("base64"));
  // Read the actual painted bar boundary, not a fixed font-dependent height.
  // The shipped /etc/sway/config sets background #323232. Text occupies
  // less than half a row; the foot client and its blue title differ.
  const boundary = rows.findIndex(background => background < 0.5);
  expect(boundary, "swaybar has painted a nonempty top band").toBeGreaterThan(0);
  return boundary * height / rows.length;
}
async function statusLine(out: Output) {
  return outputShot(out, out.width / 2, 0, out.width / 2, await barHeight(out));
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

/**
 * Browser gate for the sway machine: upstream sway on wlroots' GLES2
 * renderer, which reaches the host's WebGL2 bridge through libEGL's GBM
 * platform. The Node gates (host/test/sway-smoke.test.ts) run the pixman
 * renderer, so this spec is the only gate on that path for sway.
 *
 * Gates:
 *   1. The machine runs sway, and sway's GL context owns the canvas: the
 *      Modeset chip reports the `webgl2-gl` renderer.
 *   2. swaybar redraws its status line: the upstream status_command prints
 *      the time every second, so it changes with no input.
 *   3. The config's `exec $term` starts foot, whose window fills the
 *      output. Once its prompt holds still, a keystroke reaches it: the
 *      shell's echo changes it.
 *   4. Super+2 shows an empty workspace, where swaybg's wallpaper is
 *      visible, and Super+1 brings foot back.
 *   5. Ctrl+Return opens a second foot, and sway tiles the two: the new
 *      window's focused border runs down the middle of the output.
 *   6. Ctrl+Shift+E starts swaynag, and its "Yes, exit sway" button runs
 *      `swaymsg exit`: sway exits with status 0 to the machine's shell.
 *   7. A sway started next on the pixman renderer reaches the canvas that
 *      the GLES2 session gave up: the vblank pump presents its CPU frames,
 *      so swaybar's clock moves again.
 */
test("Kandelo sway tiles foot terminals under swaybar with wlroots' GLES2 renderer", async ({ page }) => {
  test.setTimeout(420_000);

  await gotoMachine(page, "sway");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running .*\/usr\/local\/bin\/sway/);
  expect(await syslogText(page)).not.toMatch(/configured command failed/);

  // Gate 1.
  await openSurface(page, "Demo");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => chipText(page), { timeout: 120_000 })
    .toMatch(/webgl2-gl/i);
  await expect.poll(() => displayOwner(page), { timeout: 120_000 }).toBeGreaterThan(0);
  const glesOwner = await displayOwner(page);
  let out = await output(page);

  // Gate 2.
  await expect
    .poll(
      async () => {
        const before = await statusLine(out);
        await page.waitForTimeout(1_500);
        return (await statusLine(out)).equals(before);
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBe(false);

  // Gate 3. foot is lazy and large, so its first frame can take a while.
  await expect
    .poll(async () => isFoot(await meanColor(page, await middle(out))), { timeout: 180_000, intervals: [2_000] })
    .toBe(true);
  // The Demo button keeps the keyboard focus, and keys reach the machine
  // only while the page body or the demo surface has it.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
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
  await page.keyboard.type("echo sway-gles2-ok\n", { delay: 40 });
  await expect
    .poll(async () => (await prompt()).equals(idle), { timeout: 60_000, intervals: [500, 1_000] })
    .toBe(false);

  // Gate 4.
  await page.keyboard.press("Meta+2");
  await expect
    .poll(async () => isBlue(await meanColor(page, await middle(out))), { timeout: 120_000, intervals: [2_000] })
    .toBe(true);
  await page.keyboard.press("Meta+1");
  await expect
    .poll(async () => isFoot(await meanColor(page, await middle(out))), { timeout: 30_000, intervals: [1_000] })
    .toBe(true);

  // Gate 5.
  const tiled = async () => (await lineColors(page, await seam(out), "column")).some(isBlue);
  expect(await tiled()).toBe(false);
  await page.keyboard.press("Control+Enter");
  await expect.poll(tiled, { timeout: 180_000, intervals: [2_000] }).toBe(true);

  // Gate 6. swaynag lays its buttons out from the right edge: the dismiss
  // button, a gap, then "Yes, exit sway", which spans about 56-155 pixels
  // left of the edge.
  await page.keyboard.press("Control+Shift+E");
  const top = 120;
  let band: number[] = [];
  await expect
    .poll(async () => {
      const rows = await lineColors(page, await outputShot(out, 0, 0, out.width, top), "row");
      band = rows.flatMap((row, y) => (isWarning(row) ? [(y * top) / rows.length] : []));
      return band.length;
    }, { timeout: 120_000, intervals: [1_000] })
    .toBeGreaterThan(0);
  await clickOutput(out, out.width - 105, (band[0] + band[band.length - 1]) / 2);
  // Display release must hand the visible view back to the launching
  // terminal automatically. Do not select it manually or count prompts:
  // disconnected foot clients can interleave stderr within a shell prompt.
  // A real command below proves the parent shell resumed and records the
  // foreground job's status without relying on that prompt's presentation.
  await expect.poll(() => displayOwner(page), { timeout: 60_000 }).toBe(0);
  await expect(page.getByLabel("Computer views")
    .getByRole("button", { name: "Terminal", exact: true }))
    .toHaveAttribute("aria-current", "true", { timeout: 60_000 });
  await page.locator(".xterm").first().click();
  await page.keyboard.type("echo sway-exit=$?\n", { delay: 40 });
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toMatch(/sway-exit=0/);

  // Gate 7.
  await page.keyboard.type(
    "WLR_RENDERER=pixman LIBSEAT_BACKEND=noop XDG_RUNTIME_DIR=/tmp XDG_CONFIG_HOME=/usr/share/kandelo"
      + " FONTCONFIG_FILE=/usr/share/kandelo/fonts/fonts.conf /usr/local/bin/sway\n",
  );
  await openSurface(page, "Demo");
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
  await expect
    .poll(
      async () => {
        const before = await statusLine(out);
        await page.waitForTimeout(1_500);
        return (await statusLine(out)).equals(before);
      },
      { timeout: 180_000, intervals: [1_000] },
    )
    .toBe(false);
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
      expect(member("sway/config")).toContain("bindsym Ctrl+Return exec $term");
      expect(member("sway/foot.ini")).toContain("font=monospace:size=14");
      expect(member("sway/foot.ini")).toContain("dpi-aware=no");

      await gotoMachine(page, "sway");
      await openSurface(page, "Demo");
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
      expect(cssBarHeight, "12pt Sway UI remains readable in CSS pixels").toBeGreaterThanOrEqual(18);
      expect(cssBarHeight).toBeLessThan(32);

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
