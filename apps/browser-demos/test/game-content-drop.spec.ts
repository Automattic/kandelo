import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { expect, type Page } from "../playwright-test";
import { test } from "./support/persistent-page";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { gotoMachineOrSkip } from "./support/kandelo-machine";
import { dosVgaExecutable } from "./support/dos-program";
import { quitDosAndCheck } from "./support/dos-exit";
import { runTerminalCommand } from "./support/terminal-command";

const text = (value: string) => new TextEncoder().encode(value);
const terminal = (page: Page) => page.locator(".kshell-terminal-slot:not([hidden]) .xterm-rows").first();
const batchStatus = (page: Page) => page.getByTestId("exchange-batch-status").last().textContent();

async function boot(page: Page) {
  await gotoMachineOrSkip(page, "shell");
  await expect(terminal(page)).toContainText(/maker@[^:\s]+:[^\r\n]*\$ ?/, { timeout: 180_000 });
}

async function drop(page: Page, name: string, bytes: Uint8Array) {
  const transfer = await page.evaluateHandle(({ name, base64 }) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type: "application/octet-stream" }));
    return transfer;
  }, { name, base64: Buffer.from(bytes).toString("base64") });
  const surface = page.locator(".kshell-surface, .kframebuffer-surface").first();
  await surface.dispatchEvent("dragover", { dataTransfer: transfer });
  await surface.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
}

async function redScreen(page: Page) {
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => {
    const pixel = c.getContext("2d")!.getImageData(c.width / 2, c.height / 2, 1, 1).data;
    return pixel[0] > 100 && pixel[1] < 20 && pixel[2] < 20;
  }), { timeout: 60_000 }).toBe(true);
  return canvas;
}

test("a ZIP is unpacked and a DOS executable is launched by its contents @slow", async ({ page }) => {
  test.setTimeout(600_000);
  await boot(page);
  const pe = dosVgaExecutable();
  // A valid PE marker in an MZ header must not become a second DOS choice.
  const windows = new Uint8Array(128);
  windows.set(pe.subarray(0, 32));
  const header = new DataView(windows.buffer);
  header.setUint16(2, 128, true); header.setUint16(8, 2, true);
  header.setUint32(60, 64, true); windows.set([80, 69, 0, 0], 64);
  await drop(page, "collection's data", zipSync({
    "nested/PLAY.BIN": pe,
    "nested/WINDOWS.EXE": windows,
    "nested/LICENSE.txt": text("Authored test fixture; freely reusable.\n"),
  }));
  await expect.poll(() => batchStatus(page), { timeout: 240_000 }).toMatch(/^opened a terminal: dos-play /);
  await redScreen(page);
  await quitDosAndCheck(page, "DOS_ZIP");
  await expect(terminal(page)).toContainText("dos-play ");
  await expect(terminal(page)).toContainText(/maker@[^:\s]+:[^\r\n]*\$\s*$/, { timeout: 60_000 });
});

test("zipped ROMs are identified after unpacking, and a mixed archive offers a visible choice @slow", async ({ page }) => {
  test.setTimeout(600_000);
  const rom = new Uint8Array(readFileSync(resolveBinary("programs/retro-emulators/share/retro-emulators/roms/240pee.nes")));
  await boot(page);
  await drop(page, "roms.zip", zipSync({ "console/no-extension": rom, "NOTICE.txt": text("Test-suite ROM; original notices remain in the installed package.") }));
  await expect.poll(() => batchStatus(page), { timeout: 240_000 }).toMatch(/^opened a terminal: retro-run /);
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await canvas.focus(); await page.keyboard.press("Control+c");
  await expect(terminal(page)).toBeVisible({ timeout: 60_000 });
  await drop(page, "mixed.zip", zipSync({ "A-DOS.EXE": dosVgaExecutable(), "B-ROM": rom }));
  await expect.poll(() => batchStatus(page), { timeout: 240_000 }).toMatch(/^opened a terminal: game-play /);
  await expect(terminal(page)).toBeVisible();
  await expect(terminal(page)).toContainText("Choose a game or runtime", { timeout: 120_000 });
  await expect(terminal(page)).toContainText(/DOS: .*A-DOS\.EXE/);
  await expect(terminal(page)).toContainText(/ROM \(nes\): .*B-ROM/);
  await page.locator(".kshell-terminal-slot:not([hidden]) .xterm-screen").first().click();
  await page.keyboard.type("1\n");
  await redScreen(page);
  await quitDosAndCheck(page, "DOS_PICKED");
});

test("unknown ZIPs stay ordinary downloads and unsafe members are refused @slow", async ({ page }) => {
  test.setTimeout(360_000);
  await boot(page);
  const notes = zipSync({ "notes.txt": text("not a game\n") });
  await drop(page, "notes.zip", notes);
  await expect.poll(() => batchStatus(page), { timeout: 240_000 }).toBe("saved to ~/Downloads/notes.zip");
  await runTerminalCommand(page, 'sha256sum "$HOME/Downloads/notes.zip"', createHash("sha256").update(notes).digest("hex"));
  const unsafe = zipSync({ "../ESCAPE.EXE": dosVgaExecutable() });
  await drop(page, "unsafe.zip", unsafe);
  await expect.poll(() => batchStatus(page), { timeout: 60_000 }).toMatch(/^failed: game import: .*unsafe.*saved original/);
  await runTerminalCommand(page, 'sha256sum "$HOME/Downloads/unsafe.zip"', createHash("sha256").update(unsafe).digest("hex"));
  await runTerminalCommand(page, 'test -z "$(find "$HOME/.local/share/kandelo/game-imports" -name ESCAPE.EXE -print)" && printf ARCHIVE_PATHS_SAFE', 'ARCHIVE_PATHS_SAFE');
  await expect(terminal(page)).toBeVisible();
  await expect(page.locator("canvas.kframebuffer-canvas")).not.toBeVisible();
});

test("ScummVM identifies a ZIP using its own detection database @slow", async ({ page, request }) => {
  test.setTimeout(600_000);
  const response = await request.get("https://downloads.scummvm.org/frs/extras/Mystery%20House/MYSTHOUS.zip");
  expect(response.ok()).toBe(true);
  const archive = await response.body();
  expect(archive.length).toBe(59353);
  expect(createHash("sha256").update(archive).digest("hex")).toBe("ada412228a149394489b28c6c7f9ebab0722b52e04732fd0aa22949673cfa3a0");
  await boot(page);
  await drop(page, "mystery.zip", archive);
  await expect.poll(() => batchStatus(page), { timeout: 240_000 }).toMatch(/^opened a terminal: scummvm /);
  await expect(page.locator(".kmodeset-surface canvas").first()).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => {
    const badge = await page.locator(".kdemo-surface-badge").first().innerText();
    return Number(/(\d+) flips/i.exec(badge)?.[1] ?? 0);
  }, { timeout: 120_000 }).toBeGreaterThan(1);
});
