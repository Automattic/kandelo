/**
 * Kandelo desktop framebuffer smoke test.
 *
 * Exercises the real guest path used by the `desktop-jwm` gallery entry:
 * fbseat-probe validates `/dev/fb0` + `/dev/input/*`, then the demo starts the
 * real Xfbdev port, JWM, and multiple libX11 clients on DISPLAY=:0.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const REQUIRED_ARTIFACTS = [
  "local-binaries/kernel.wasm",
  "host/wasm/rootfs.vfs",
  "local-binaries/programs/wasm32/fbseat-probe.wasm",
  "local-binaries/programs/wasm32/Xfbdev.wasm",
  "local-binaries/programs/wasm32/jwm.wasm",
  "local-binaries/programs/wasm32/xvfs-browser.wasm",
  "local-binaries/programs/wasm32/xclock.wasm",
  "local-binaries/programs/wasm32/xeyes.wasm",
  "local-binaries/programs/wasm32/kdesktop.wasm",
].map((p) => join(REPO_ROOT, p));

const missingArtifacts = REQUIRED_ARTIFACTS.filter((p) => !existsSync(p));

test.describe("kandelo desktop", () => {
  test.skip(
    missingArtifacts.length > 0,
    `missing desktop artifacts: ${missingArtifacts.map((p) => p.replace(REPO_ROOT + "/", "")).join(", ")}`,
  );

  test("renders a real Xfbdev VFS browser client", async ({ page }) => {
    const errors = recordPageErrors(page);
    const canvasBox = await bootDesktop(page);

    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await expect(page.getByTestId("framebuffer-host-cursor")).toBeVisible();

    await expect.poll(() => activeSidebarPlace(page), { timeout: 10_000 }).toBe("home");

    await clickFramebuffer(page, canvasBox, 94, 226);
    await expect.poll(() => activeSidebarPlace(page), { timeout: 10_000 }).toBe("usrbin");

    await clickFramebuffer(page, canvasBox, 94, 154);
    await expect.poll(() => activeSidebarPlace(page), { timeout: 10_000 }).toBe("root");

    await clickFramebuffer(page, canvasBox, 94, 190);
    await expect.poll(() => activeSidebarPlace(page), { timeout: 10_000 }).toBe("home");

    await openWindowMenu(page, canvasBox);
    await clickWindowMenuItem(page, canvasBox, 118);
    await expect.poll(() => browserClientHidden(page), { timeout: 10_000 }).toBe(true);
    await clickFramebuffer(page, canvasBox, 100, 468);
    await expect.poll(() => activeSidebarPlace(page), { timeout: 10_000 }).toBe("home");
    await page.waitForTimeout(500);

    await openWindowMenu(page, canvasBox);
    await clickWindowMenuItem(page, canvasBox, 204);
    await expect.poll(() => browserClientHidden(page), { timeout: 10_000 }).toBe(true);

    await page.getByRole("button", { name: "Internals" }).first().click();
    await expect(page.getByText(/FBIOPUT_VSCREENINFO 800x600x32/)).toBeVisible();
    await expect(page.getByText(/FBIOPUT_VSCREENINFO 640x480x32/)).toBeVisible();
    await expect(page.getByText(/fbseat-probe: PASS \(\d+ checks\)/)).toBeVisible();
    await expect(page.getByText("fbseat-probe exited with code 0")).toBeVisible();
    await expect(page.getByText("spawning jwm...")).toBeVisible();
    await expect(page.getByText(/Xfbdev stayed up after startup window; leaving JWM and X VFS browser attached/)).toBeVisible();
    await expect(page.getByText(/jwm failed|jwm exited with code/)).toHaveCount(0);
    await expect(page.getByText("spawning xvfs-browser...")).toBeVisible();
    await expect(page.getByText(/xvfs-browser: XOpenDisplay succeeded/)).toBeVisible();
    await expect(page.getByText("spawning xclock...")).toBeVisible();
    await expect(page.getByText(/xclock: mapped window and entering event loop/)).toBeVisible();
    await expect(page.getByText("spawning xeyes...")).toBeVisible();
    await expect(page.getByText(/xeyes: mapped window and entering event loop/)).toBeVisible();
    await expect(page.getByText(/xclock exited with code|xeyes exited with code/)).toHaveCount(0);
    await expect(page.getByText(/Fatal server error/)).toHaveCount(0);
    await expect(page.getByText(/xvfs-browser: WM_DELETE_WINDOW received/)).toBeVisible();
    await expect(page.getByText("xvfs-browser exited with code 0")).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("runs the JWM window menu kill command", async ({ page }) => {
    const errors = recordPageErrors(page);
    const canvasBox = await bootDesktop(page);

    await openWindowMenu(page, canvasBox);
    await clickWindowMenuItem(page, canvasBox, 184);
    await expect.poll(() => browserClientHidden(page), { timeout: 10_000 }).toBe(true);

    await page.getByRole("button", { name: "Internals" }).first().click();
    await expect(page.getByText(/xvfs-browser: X connection closed/)).toBeVisible();
    await expect(page.getByText("xvfs-browser exited with code 0")).toBeVisible();
    await expect(page.getByText(/jwm failed|jwm exited with code/)).toHaveCount(0);
    await expect(page.getByText(/Fatal server error/)).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});

function recordPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function bootDesktop(
  page: Page,
): Promise<NonNullable<Awaited<ReturnType<ReturnType<Page["locator"]>["boundingBox"]>>>> {
  await gotoOrSkip(page, "/pages/kandelo/?demo=desktop-jwm");
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector("canvas");
      return c instanceof HTMLCanvasElement && c.width === 640 && c.height === 480;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => /FRAMEBUFFER · \/DEV\/FB0 · pid \d+/.test(document.body.textContent ?? ""),
    undefined,
    { timeout: 30_000 },
  );
  await expect.poll(() => nonBlackPixels(page), { timeout: 45_000 }).toBeGreaterThan(10000);
  await expect.poll(() => sampledColorCount(page), { timeout: 45_000 }).toBeGreaterThan(3);
  await expect.poll(() => jwmTrayPainted(page), { timeout: 45_000 }).toBe(true);
  await expect.poll(() => xclockPainted(page), { timeout: 45_000 }).toBe(true);
  await expect.poll(() => xeyesPainted(page), { timeout: 45_000 }).toBe(true);
  await expect(canvas).toHaveCSS("cursor", "none");
  await page.waitForTimeout(2500);

  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  return canvasBox!;
}

async function gotoOrSkip(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForTimeout(2000);
  const hasErrorOverlay = await page.evaluate(() => !!document.querySelector("vite-error-overlay"));
  if (hasErrorOverlay) test.skip(true, "Required binary not built - Vite import error");
}

async function nonBlackPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d", { willReadFrequently: true });
    if (!c || !ctx) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] || data[i + 1] || data[i + 2]) n++;
    }
    return n;
  });
}

async function sampledColorCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d", { willReadFrequently: true });
    if (!c || !ctx) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set<string>();
    for (let y = 0; y < c.height; y += 8) {
      for (let x = 0; x < c.width; x += 8) {
        const i = (y * c.width + x) * 4;
        colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
    }
    return colors.size;
  });
}

async function jwmTrayPainted(page: Page): Promise<boolean> {
  const samples = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d", { willReadFrequently: true });
    if (!c || !ctx) return null;
    const points = {
      button: [8, 468],
      task: [320, 468],
      tray: [600, 468],
    } as const;
    const out: Record<keyof typeof points, [number, number, number]> = {
      button: [0, 0, 0],
      task: [0, 0, 0],
      tray: [0, 0, 0],
    };
    for (const key of Object.keys(points) as Array<keyof typeof points>) {
      const [x, y] = points[key];
      const data = ctx.getImageData(x, y, 1, 1).data;
      out[key] = [data[0], data[1], data[2]];
    }
    return out;
  });
  if (!samples) return false;

  const expected = {
    button: [66, 83, 90],
    task: [59, 75, 82],
    tray: [47, 124, 143],
  } as const;
  let matches = 0;
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    const rgb = samples[key];
    const target = expected[key];
    const distance =
      Math.abs(rgb[0] - target[0]) +
      Math.abs(rgb[1] - target[1]) +
      Math.abs(rgb[2] - target[2]);
    if (distance <= 18) matches++;
  }
  return matches >= 2;
}

async function xclockPainted(page: Page): Promise<boolean> {
  return regionHasColors(page, { x: 446, y: 58, w: 172, h: 122 }, [
    [251, 247, 237],
    [216, 95, 43],
    [36, 25, 15],
  ]);
}

async function xeyesPainted(page: Page): Promise<boolean> {
  return regionHasColors(page, { x: 446, y: 248, w: 172, h: 96 }, [
    [251, 247, 237],
    [47, 124, 143],
    [36, 25, 15],
  ]);
}

async function regionHasColors(
  page: Page,
  rect: { x: number; y: number; w: number; h: number },
  targets: Array<readonly [number, number, number]>,
): Promise<boolean> {
  const matches = await page.evaluate(({ rect, targets }) => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d", { willReadFrequently: true });
    if (!c || !ctx) return [];
    const found = new Array(targets.length).fill(0);
    for (let y = rect.y; y < rect.y + rect.h; y += 4) {
      for (let x = rect.x; x < rect.x + rect.w; x += 4) {
        const data = ctx.getImageData(x, y, 1, 1).data;
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i];
          const distance =
            Math.abs(data[0] - target[0]) +
            Math.abs(data[1] - target[1]) +
            Math.abs(data[2] - target[2]);
          if (distance <= 24) found[i]++;
        }
      }
    }
    return found;
  }, { rect, targets });
  return matches.every((count) => count >= 2);
}

function framebufferPoint(
  canvasBox: NonNullable<Awaited<ReturnType<ReturnType<Page["locator"]>["boundingBox"]>>>,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: canvasBox.x + canvasBox.width * (x / 640),
    y: canvasBox.y + canvasBox.height * (y / 480),
  };
}

async function clickFramebuffer(
  page: Page,
  canvasBox: NonNullable<Awaited<ReturnType<ReturnType<Page["locator"]>["boundingBox"]>>>,
  x: number,
  y: number,
): Promise<void> {
  const point = framebufferPoint(canvasBox, x, y);
  await page.mouse.click(point.x, point.y);
}

async function moveFramebuffer(
  page: Page,
  canvasBox: NonNullable<Awaited<ReturnType<ReturnType<Page["locator"]>["boundingBox"]>>>,
  x: number,
  y: number,
): Promise<void> {
  const point = framebufferPoint(canvasBox, x, y);
  await page.mouse.move(point.x, point.y);
}

async function openWindowMenu(
  page: Page,
  canvasBox: NonNullable<Awaited<ReturnType<ReturnType<Page["locator"]>["boundingBox"]>>>,
): Promise<void> {
  await clickFramebuffer(page, canvasBox, 10, 12);
  await expect.poll(() => windowMenuPainted(page), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(250);
}

async function clickWindowMenuItem(
  page: Page,
  canvasBox: NonNullable<Awaited<ReturnType<ReturnType<Page["locator"]>["boundingBox"]>>>,
  y: number,
): Promise<void> {
  await moveFramebuffer(page, canvasBox, 35, y);
  await page.waitForTimeout(150);
  await clickFramebuffer(page, canvasBox, 35, y);
}

async function browserClientHidden(page: Page): Promise<boolean> {
  const rgb = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d", { willReadFrequently: true });
    if (!c || !ctx) return null;
    const data = ctx.getImageData(100, 190, 1, 1).data;
    return [data[0], data[1], data[2]] as const;
  });
  if (!rgb) return false;
  const background = [24, 32, 38] as const;
  const distance =
    Math.abs(rgb[0] - background[0]) +
    Math.abs(rgb[1] - background[1]) +
    Math.abs(rgb[2] - background[2]);
  return distance <= 18;
}

async function windowMenuPainted(page: Page): Promise<boolean> {
  const samples = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d", { willReadFrequently: true });
    if (!c || !ctx) return null;
    const points = [
      [35, 176],
      [35, 204],
    ] as const;
    return points.map(([x, y]) => {
      const data = ctx.getImageData(x, y, 1, 1).data;
      return [data[0], data[1], data[2]] as const;
    });
  });
  if (!samples) return false;
  const menuBackground = [38, 50, 56] as const;
  return samples.every((rgb) => {
    const distance =
      Math.abs(rgb[0] - menuBackground[0]) +
      Math.abs(rgb[1] - menuBackground[1]) +
      Math.abs(rgb[2] - menuBackground[2]);
    return distance <= 18;
  });
}

async function activeSidebarPlace(page: Page): Promise<"root" | "home" | "usrbin" | "unknown"> {
  const samples = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d", { willReadFrequently: true });
    if (!c || !ctx) return null;
    const points = {
      root: [150, 154],
      home: [150, 190],
      usrbin: [150, 226],
    } as const;
    const out: Record<"root" | "home" | "usrbin", [number, number, number]> = {
      root: [0, 0, 0],
      home: [0, 0, 0],
      usrbin: [0, 0, 0],
    };
    for (const key of Object.keys(points) as Array<keyof typeof points>) {
      const [x, y] = points[key];
      const data = ctx.getImageData(x, y, 1, 1).data;
      out[key] = [data[0], data[1], data[2]];
    }
    return out;
  });
  if (!samples) return "unknown";

  const selected = [255, 220, 168] as const;
  let best: keyof typeof samples | "unknown" = "unknown";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of Object.keys(samples) as Array<keyof typeof samples>) {
    const rgb = samples[key];
    const distance =
      Math.abs(rgb[0] - selected[0]) +
      Math.abs(rgb[1] - selected[1]) +
      Math.abs(rgb[2] - selected[2]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  return bestDistance <= 12 ? best : "unknown";
}
