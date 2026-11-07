// A ROM dropped on a shell machine plays: Kandelo exchange hands it to the
// machine's agent (kxchgd), whose retro rule keeps it in ~/roms and asks the
// page, through kandelo-terminal, for a terminal with `retro-run ROM` typed at
// its prompt (images/vfs/scripts/build-source-rootfs-shell-image.ts,
// RETRO_LOAD_ROM_HANDLER; web-libs/kandelo-session/src/terminal-request.ts).
//
// What this has to prove, beyond "a canvas has colours":
//
// - The game is an ordinary command in an ordinary terminal: the terminal
//   shows the command, and after Ctrl+C, Up and Enter run it again.
// - Keys reach it: the starter ROMs are static test-suite menus, so a frame
//   that changes after a key press changed because of the key. Ctrl+C, which
//   quits, must end the emulator; Esc alone must not.
// - ROMs are recognised by their bytes, not their names, because collections
//   name them .rom or nothing at all: the SNES ROM is dropped as Suite.rom
//   and still runs on Snes9x, and a ROM with no extension plays.
// - A second drop replaces the running game: the display changes owner.
// - A file that is not a ROM, even one whose name could be (.md), is saved
//   to ~/Downloads as any other drop would be.

import { expect, test, type Locator, type Page } from "../playwright-test";
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

/** The visible terminal's text. */
function activeTerminalText(page: Page): Promise<string> {
  return page.locator(".kshell-terminal-slot:not([hidden]) .xterm-rows").first()
    .evaluate((node) => node.textContent ?? "");
}

test("a dropped ROM runs as a command in its own terminal, which can run it again", async ({ page }) => {
  test.setTimeout(600_000);
  requireStarterRoms();
  await gotoMachineOrSkip(page, "shell");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 180_000 });
  await expect.poll(
    () => page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? ""),
    { timeout: 180_000 },
  ).toMatch(/maker@[^:\s]+:[^\r\n]*\$ ?/);

  // Dropped on the terminal: the handler asks the page for a terminal of its
  // own with the command typed at the prompt, and the view switches to the
  // display the game draws on.
  await dropFile(page, page.locator(".kshell-surface").first(), "Test Suite (U).nes", readFileSync(NES_ROM));
  await expect.poll(() => batchStatus(page), { timeout: 180_000 })
    .toBe("opened a terminal: retro-run ~/roms/Test Suite (U).nes");
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await awaitRender(canvas);
  const nesPid = await boundPid(page);
  expect(nesPid).not.toBeNull();

  // Keys reach it through its terminal. The suite opens on a static credits
  // screen that Right pages through.
  await canvas.focus();
  const settled = await settledFrame(canvas);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await frameSummary(canvas)).digest, { timeout: 30_000 })
    .not.toBe(settled);

  // F2 saves this game's state; Esc alone does nothing: the game keeps the
  // display.
  await page.keyboard.press("F2");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2_000);
  expect(await boundPid(page)).toBe(nesPid);

  // Ctrl+C quits, back to the terminal's prompt.
  await page.keyboard.press("Control+c");
  await expect.poll(() => boundPid(page), { timeout: 30_000 }).toBeNull();

  // That terminal shows the command, the key list the emulator printed,
  // and a prompt; Up and Enter run the game again.
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect.poll(() => activeTerminalText(page), { timeout: 30_000 })
    .toContain("retro-run ~/roms/'Test Suite (U).nes'");
  const shown = await activeTerminalText(page);
  expect(shown).toContain("Keys for FCEUmm:");
  expect(shown).toMatch(/F2 +save state/);
  expect(shown).toMatch(/F4 +load state/);
  expect(shown).toContain("[retro] saved state: /home/maker/.local/share/retro-emulators/states/Test Suite (U).state");
  await expect.poll(() => activeTerminalText(page), { timeout: 30_000 })
    .toMatch(/maker@[^:\s]+:[^\r\n]*\$\s*$/);
  await page.locator(".kshell-terminal-slot:not([hidden]) .xterm-screen").click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(async () => {
    const pid = await boundPid(page);
    return pid !== null && pid !== nesPid;
  }, { timeout: 60_000 }).toBe(true);
  await canvas.focus();
  await page.keyboard.press("Control+c");
  await expect.poll(() => boundPid(page), { timeout: 30_000 }).toBeNull();

  // ROMs are recognised by their bytes: a SNES ROM named .rom starts Snes9x.
  const surface = page.locator(".kshell-surface, .kframebuffer-surface").first();
  await dropFile(page, surface, "Suite.rom", readFileSync(SNES_ROM));
  await expect.poll(() => batchStatus(page), { timeout: 240_000 })
    .toBe("opened a terminal: retro-run ~/roms/Suite.rom");
  await expect.poll(() => boundPid(page), { timeout: 120_000 }).not.toBeNull();
  await awaitRender(canvas);

  // A second drop replaces the game that is playing; a ROM with no
  // extension plays too.
  const snesPid = await boundPid(page);
  await dropFile(page, surface, "testsuite", readFileSync(NES_ROM));
  await expect.poll(() => batchStatus(page), { timeout: 120_000 })
    .toBe("opened a terminal: retro-run ~/roms/testsuite");
  // The old game stops first (no owner for a moment), then the new one binds.
  await expect.poll(async () => {
    const pid = await boundPid(page);
    return pid !== null && pid !== snesPid;
  }, { timeout: 60_000 }).toBe(true);
  await canvas.focus();
  await page.keyboard.press("Control+c");
  await expect.poll(() => boundPid(page), { timeout: 30_000 }).toBeNull();

  // A file whose name could be a ROM but whose bytes are not is saved, as
  // any other drop is.
  await dropFile(page, surface, "notes.md", Buffer.from("# not a game\n"));
  await expect.poll(() => batchStatus(page), { timeout: 60_000 })
    .toBe("saved to ~/Downloads/notes.md");
});
