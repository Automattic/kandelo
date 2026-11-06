// A ROM dropped on a shell machine plays: Kandelo exchange hands it to the
// machine's agent (kxchgd), whose retro rule keeps it in ~/roms and starts the
// emulator on it in the background (images/vfs/scripts/
// build-source-rootfs-shell-image.ts, RETRO_LOAD_ROM_HANDLER).
//
// What this has to prove, beyond "a canvas has colours":
//
// - The emulator a handler starts has no terminal, so its keys must arrive
//   through the machine keyboard device (/dev/input/event0), which the
//   framebuffer canvas feeds while focused. The starter ROMs are static
//   test-suite menus, so a frame that changes after a key press changed
//   because of the key, and Esc, which quits, must end the emulator.
// - ROMs are recognised by their bytes, not their names, because collections
//   name them .rom or nothing at all: the SNES ROM is dropped as Suite.rom
//   and still runs on Snes9x, and a ROM with no extension plays.
// - A second drop replaces the running game: the display changes owner.
// - A file that is not a ROM, even one whose name could be (.md), is saved
//   to ~/Downloads as any other drop would be.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

const ROM_DIR = join(
  findRepoRoot(),
  "local-binaries/source-only-v1/programs/wasm32/retro-emulators/share/retro-emulators/roms",
);
const NES_ROM = join(ROM_DIR, "240pee.nes");
const SNES_ROM = join(ROM_DIR, "240pSuite-snes-1.03.sfc");

function requireStarterRoms(): void {
  const missing = [NES_ROM, SNES_ROM].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `retro-emulators starter ROM(s) not built: ${missing.join(", ")}. Run: ./run.sh local-build`,
    );
  }
}

/** A cheap digest of the visible frame, plus how many colours it has. */
function frameSummary(canvas: Locator): Promise<{ digest: number; colors: number }> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return { digest: 0, colors: 0 };
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const seen = new Set<number>();
    let digest = 0;
    for (let i = 0; i < data.length; i += 4) {
      const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      if (seen.size <= 64) seen.add(rgb);
      digest = (Math.imul(digest, 31) + rgb) | 0;
    }
    return { digest, colors: seen.size };
  });
}

async function awaitRender(canvas: Locator): Promise<void> {
  await expect.poll(async () => (await frameSummary(canvas)).colors, {
    timeout: 120_000,
    intervals: [1_000, 2_000, 3_000],
  }).toBeGreaterThan(4);
}

/** The pid that owns /dev/fb0, or null when nothing does. */
async function boundPid(page: Page): Promise<number | null> {
  const titles = await page
    .locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })
    .allTextContents();
  const m = /pid (\d+)/i.exec(titles[0] ?? "");
  return m ? Number(m[1]) : null;
}

/** The newest batch toast's status text. */
function batchStatus(page: Page): Promise<string> {
  return page.getByTestId("exchange-batch-status").last().textContent().then((text) => text ?? "");
}

/** Drop one file on `surface`, as a person dragging it from their desktop. */
async function dropFile(page: Page, surface: Locator, name: string, bytes: Buffer): Promise<void> {
  // Base64, because the app's service worker intercepts in-page fetch() and
  // a multi-MB numeric array is too heavy for evaluate.
  const dataTransfer = await page.evaluateHandle(({ b64, fileName }) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([data], fileName, { type: "application/octet-stream" }));
    return dt;
  }, { b64: bytes.toString("base64"), fileName: name });
  await surface.dispatchEvent("dragover", { dataTransfer });
  await surface.dispatchEvent("drop", { dataTransfer });
}

/** Wait until the frame stops changing; the starter ROMs idle on a menu. */
async function settledFrame(canvas: Locator): Promise<number> {
  let last = await frameSummary(canvas);
  await expect.poll(async () => {
    const next = await frameSummary(canvas);
    const same = next.digest === last.digest;
    last = next;
    return same;
  }, { timeout: 60_000, intervals: [1_500] }).toBe(true);
  return last.digest;
}

test("a ROM dropped on the shell plays, takes keys without a terminal, and Esc quits", async ({ page }) => {
  test.setTimeout(600_000);
  requireStarterRoms();
  await gotoMachineOrSkip(page, "shell");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 180_000 });
  await expect.poll(
    () => page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? ""),
    { timeout: 180_000 },
  ).toMatch(/maker@[^:\s]+:[^\r\n]*\$ ?/);

  // Dropped on the terminal. The view switches to the display by itself
  // once the emulator binds /dev/fb0.
  await dropFile(page, page.locator(".kshell-surface").first(), "Test Suite (U).nes", readFileSync(NES_ROM));
  await expect.poll(() => batchStatus(page), { timeout: 180_000 }).toBe("playing Test Suite (U).nes");
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await awaitRender(canvas);
  const nesPid = await boundPid(page);
  expect(nesPid).not.toBeNull();

  // Keys reach it only through /dev/input/event0: it has no terminal. The
  // suite opens on a static credits screen that Right pages through.
  await canvas.focus();
  const settled = await settledFrame(canvas);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await frameSummary(canvas)).digest, { timeout: 30_000 })
    .not.toBe(settled);

  // A second drop replaces the game. The SNES ROM is named .rom, as ROM
  // collections often do; the launcher reads its header to pick Snes9x.
  await dropFile(page, page.locator(".kframebuffer-surface").first(), "Suite.rom", readFileSync(SNES_ROM));
  await expect.poll(() => batchStatus(page), { timeout: 240_000 }).toBe("playing Suite.rom");
  await expect.poll(() => boundPid(page), { timeout: 60_000 }).not.toBe(nesPid);
  expect(await boundPid(page)).not.toBeNull();
  await awaitRender(canvas);

  // Esc quits: the display loses its owner.
  await canvas.focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => boundPid(page), { timeout: 30_000 }).toBeNull();

  // A ROM with no extension at all plays: it is recognised by its bytes.
  const surface = page.locator(".kshell-surface, .kframebuffer-surface").first();
  await dropFile(page, surface, "testsuite", readFileSync(NES_ROM));
  await expect.poll(() => batchStatus(page), { timeout: 120_000 }).toBe("playing testsuite");
  await expect.poll(() => boundPid(page), { timeout: 30_000 }).not.toBeNull();
  await canvas.focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => boundPid(page), { timeout: 30_000 }).toBeNull();

  // A file whose name could be a ROM but whose bytes are not is saved, as
  // any other drop is.
  await dropFile(page, surface, "notes.md", Buffer.from("# not a game\n"));
  await expect.poll(() => batchStatus(page), { timeout: 60_000 })
    .toBe("saved to ~/Downloads/notes.md");
});
