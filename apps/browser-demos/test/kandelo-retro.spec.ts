// The retro machine: three libretro cores behind one launcher, on /dev/fb0.
//
// What these specs have to prove, beyond "a canvas has colours":
//
// - Each core actually runs. A static frontend supplies the libretro-common
//   code a core normally gets from RetroArch, and a symbol nobody supplies is
//   a wasm import that traps on first call. So every core is booted on a real
//   ROM and must paint.
// - The launcher picks the core from the ROM's bytes. An upload always lands
//   at one fixed path and its filename never reaches the restart command, so
//   the extension cannot be what decides. The SNES ROM is therefore uploaded
//   under a Mega Drive-looking name and must still start the SNES core.
// - Input reaches the core: the starter ROMs are static test-suite menus, so
//   a frame that changes after a key press changed because of the key.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

const ROM_DIR = join(
  findRepoRoot(),
  "local-binaries/source-only-v1/programs/wasm32/kandelo-retro/share/kandelo-retro/roms",
);
const MD_ROM = join(ROM_DIR, "240pSuite-md-1.21.bin");
const SNES_ROM = join(ROM_DIR, "240pSuite-snes-1.03.sfc");

function requireStarterRoms(): void {
  const missing = [MD_ROM, SNES_ROM].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `kandelo-retro starter ROM(s) not built: ${missing.join(", ")}. `
        + "Run: ./run.sh local-build",
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

/** The pid that owns /dev/fb0, or null when nothing does (the pane is gone). */
async function boundPid(page: Page): Promise<number | null> {
  const titles = await page
    .locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })
    .allTextContents();
  const m = /pid (\d+)/i.exec(titles[0] ?? "");
  return m ? Number(m[1]) : null;
}

async function awaitRender(canvas: Locator): Promise<void> {
  await expect.poll(async () => (await frameSummary(canvas)).colors, {
    timeout: 120_000,
    intervals: [1_000, 2_000, 3_000],
  }).toBeGreaterThan(4);
}

async function bootRetro(page: Page): Promise<Locator> {
  await gotoMachineOrSkip(page, "retro");
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  await awaitRender(canvas);
  return canvas;
}

/**
 * The emulator's command line, read from the inspector's process table. Only
 * one emulator can exist at a time (it owns /dev/fb0), so the single row
 * naming a kandelo-retro program is the framebuffer's owner.
 */
async function emulatorCommand(page: Page): Promise<string> {
  const internals = page.getByRole("button", { name: "Internals" });
  if ((await internals.getAttribute("aria-pressed")) !== "true") await internals.click();
  await page.getByRole("tab", { name: "Procs", exact: true }).click();
  const cells = page.locator(".ktable tbody tr td:last-child", {
    hasText: "/usr/bin/kandelo-retro",
  });
  const commands = await cells.allTextContents();
  await internals.click();
  return commands.length === 1 ? commands[0].trim() : `${commands.length} emulator processes`;
}

async function loadRom(
  page: Page,
  canvas: Locator,
  file: string | { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const pidBefore = await boundPid(page);
  await page.getByTestId("fb-ingest-input").setInputFiles(file);
  await page.getByTestId("fb-ingest-busy")
    .waitFor({ state: "detached", timeout: 90_000 })
    .catch(() => { /* the handoff may finish before we look */ });
  await expect.poll(() => boundPid(page), { timeout: 90_000 })
    .not.toBe(pidBefore);
  await awaitRender(canvas);
  await expect(page.getByTestId("fb-ingest-error")).toHaveCount(0);
}

test("the retro machine boots the NES starter ROM and the core takes input", async ({ page }) => {
  test.setTimeout(420_000);
  const canvas = await bootRetro(page);

  await expect.poll(() => emulatorCommand(page), { timeout: 30_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro \/tmp\/kandelo-retro\/rom\.nes/);

  // The suite opens on a static two-page credits screen: the frame settles,
  // and then only input moves it. Give the canvas focus, turn the page with
  // Right, and the frame must change.
  await canvas.click();
  let settled = await frameSummary(canvas);
  await expect.poll(async () => {
    const next = await frameSummary(canvas);
    const same = next.digest === settled.digest;
    settled = next;
    return same;
  }, { timeout: 60_000, intervals: [1_500] }).toBe(true);

  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await frameSummary(canvas)).digest, {
    timeout: 30_000,
  }).not.toBe(settled.digest);
});

test("Load ROM picks the core from the ROM's contents, not its name", async ({ page }) => {
  test.setTimeout(600_000);
  requireStarterRoms();
  const canvas = await bootRetro(page);
  await expect(page.getByTestId("fb-ingest-button")).toHaveText(/from file/i);

  // A real Mega Drive ROM under its own extension.
  await loadRom(page, canvas, MD_ROM);
  await expect.poll(() => emulatorCommand(page), { timeout: 30_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro-genesis \/tmp\/kandelo-retro\/rom\.md/);

  // The SNES ROM, named as if it were a Mega Drive dump. Only its header can
  // say what it is.
  await loadRom(page, canvas, {
    name: "mislabeled.md",
    mimeType: "application/octet-stream",
    buffer: readFileSync(SNES_ROM),
  });
  await expect.poll(() => emulatorCommand(page), { timeout: 30_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro-snes \/tmp\/kandelo-retro\/rom\.sfc/);
});

test("a file that is not a ROM it knows starts no core at all", async ({ page }) => {
  test.setTimeout(420_000);
  await bootRetro(page);
  expect(await boundPid(page)).not.toBeNull();

  // Accepted by extension and size, so it is written and the launcher runs.
  // The launcher then finds no signature it recognises and must refuse,
  // rather than hand 64 KiB of noise to whichever core is the default.
  const noise = Buffer.alloc(64 * 1024);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 131 + 89) & 0xff;
  await page.getByTestId("fb-ingest-input").setInputFiles({
    name: "not-a-rom.bin",
    mimeType: "application/octet-stream",
    buffer: noise,
  });

  // The old emulator is stopped and nothing takes /dev/fb0. The display
  // stays (this machine restarts its program in place) and says the start
  // failed; the launcher says why on the machine's terminal.
  await expect.poll(() => boundPid(page), { timeout: 90_000 }).toBeNull();
  await expect(page.getByTestId("fb-ingest-error"))
    .toContainText(/nothing took \/dev\/fb0 .* the terminal shows its output/, { timeout: 30_000 });
  await page.getByLabel("Computer views").getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(
    page.getByText(/retro-run: .* is not a recognised NES, SNES, Mega Drive/).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => emulatorCommand(page), { timeout: 30_000 })
    .toBe("0 emulator processes");
});

/**
 * One hash per pixel row of the frame, for comparing frames across tabs.
 * A row changes if any pixel in it does, so thin text still registers.
 */
function frameRows(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return [];
    const { data, width, height } = ctx.getImageData(0, 0, el.width, el.height);
    const rows: number[] = [];
    for (let y = 0; y < height; y++) {
      let hash = 0;
      for (let i = y * width * 4; i < (y + 1) * width * 4; i += 4) {
        hash = (Math.imul(hash, 31) + ((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])) | 0;
      }
      rows.push(hash);
    }
    return rows;
  });
}

function differingFraction(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 1;
  let differing = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
  return differing / a.length;
}

async function settledDigest(canvas: Locator): Promise<number> {
  let last = await frameSummary(canvas);
  await expect.poll(async () => {
    const next = await frameSummary(canvas);
    const same = next.digest === last.digest;
    last = next;
    return same;
  }, { timeout: 60_000, intervals: [1_500] }).toBe(true);
  return last.digest;
}

/**
 * Poll until the frame differs from `base` in more than `atLeast` of its
 * rows (or, with `atMost`, in no more than that many). The test suite's page
 * arrows blink, which alone changes a few percent of rows; turning a page
 * changes far more, so the thresholds sit an order of magnitude apart.
 */
async function waitForRows(
  canvas: Locator,
  base: number[],
  bound: { atLeast: number } | { atMost: number },
): Promise<number[]> {
  let rows: number[] = [];
  await expect.poll(async () => {
    rows = await frameRows(canvas);
    const fraction = differingFraction(base, rows);
    return "atLeast" in bound ? fraction > bound.atLeast : fraction <= bound.atMost;
  }, { timeout: 30_000, intervals: [500, 1_000] }).toBe(true);
  return rows;
}

const PAGE_TURN = { atLeast: 0.2 } as const;
const SAME_PAGE = { atMost: 0.05 } as const;

test("a share link with a save state reopens the game where it was", async ({ page, context }) => {
  test.setTimeout(600_000);
  const canvas = await bootRetro(page);
  await canvas.click();
  await settledDigest(canvas);
  const firstRows = await frameRows(canvas);

  // Move off the opening screen, so "where it was" differs from a fresh boot.
  await page.keyboard.press("ArrowRight");
  await waitForRows(canvas, firstRows, PAGE_TURN);

  // Clicking the display captured the mouse. Release it the way the
  // browser's own Esc does (Playwright's key presses do not reach the
  // browser's pointer-lock handling), so the dock can be clicked.
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.getByText(/MOUSE LOCKED/i)).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByTestId("share-checkpoint-toggle").check();
  await expect(page.getByTestId("share-checkpoint-status"))
    .toContainText("Checkpoint taken", { timeout: 60_000 });
  await expect(page.getByTestId("share-checkpoint-error")).toHaveCount(0);
  const shareUrl = page.locator(".kshare-url");
  await expect(shareUrl).toHaveAttribute("data-share-url", /#k1=/, { timeout: 30_000 });
  const url = (await shareUrl.getAttribute("data-share-url"))!;

  // A second visitor opens the link in a fresh tab.
  const opener = await context.newPage();
  await opener.goto(url, { waitUntil: "domcontentloaded" });
  const reopened = opener.locator("canvas.kframebuffer-canvas").first();
  await expect(reopened).toBeVisible({ timeout: 180_000 });
  await awaitRender(reopened);

  // The restored machine is on the second page. Frames are compared within
  // the opener's own tab, because two tabs need not scale the display alike:
  // Left must turn back a page, and Right must return to the restored frame.
  await reopened.click();
  await settledDigest(reopened);
  const restoredRows = await frameRows(reopened);
  await opener.keyboard.press("ArrowLeft");
  await waitForRows(reopened, restoredRows, PAGE_TURN);
  await opener.keyboard.press("ArrowRight");
  await waitForRows(reopened, restoredRows, SAME_PAGE);
  // And Right on the restored frame goes nowhere: it was the last page.
  await opener.keyboard.press("ArrowRight");
  await opener.waitForTimeout(1_500);
  expect(differingFraction(restoredRows, await frameRows(reopened))).toBeLessThanOrEqual(0.05);

  await opener.evaluate(() => document.exitPointerLock());
  await expect.poll(() => emulatorCommand(opener), { timeout: 30_000 })
    .toMatch(/--state \/run\/kandelo\/inputs\/state\/retro\.state$/);
});

async function archiveReachable(): Promise<boolean> {
  try {
    const res = await fetch("https://archive.org/metadata/carpetshark", { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

async function openLibrary(page: Page): Promise<void> {
  if (await page.evaluate(() => document.pointerLockElement !== null)) {
    await page.evaluate(() => document.exitPointerLock());
  }
  await page.getByTestId("fb-library-button").click();
  await expect(page.getByRole("dialog", { name: "Library" })).toBeVisible();
}

async function releasePointer(page: Page): Promise<void> {
  // Clicking the display captured the mouse. Release it the way the
  // browser's own Esc does (Playwright's key presses do not reach the
  // browser's pointer-lock handling), so the dock can be clicked.
  if (await page.evaluate(() => document.pointerLockElement !== null)) {
    await page.evaluate(() => document.exitPointerLock());
  }
  await expect(page.getByText(/MOUSE LOCKED/i)).toHaveCount(0, { timeout: 10_000 });
}

test("the library loads a ROM the image already carries, and keeps its place when closed", async ({ page }) => {
  test.setTimeout(420_000);
  const canvas = await bootRetro(page);
  await expect(page.getByTestId("fb-current-content")).toContainText("240p Test Suite");
  await expect(page.getByTestId("fb-group-NES")).toHaveAttribute("aria-pressed", "true");

  // The drawer is hidden, not torn down: what the visitor chose is still
  // there when it opens again.
  await openLibrary(page);
  await expect(page.getByTestId("library-group-NES")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("library-group-SNES").click();
  await page.getByTestId("library-query").fill("test suite");
  await page.getByRole("button", { name: "Close library" }).click();
  await expect(page.getByRole("dialog", { name: "Library" })).toHaveCount(0);
  await openLibrary(page);
  await expect(page.getByTestId("library-group-SNES")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("library-query")).toHaveValue("test suite");

  await page.getByTestId("library-bundled")
    .getByRole("button", { name: "Play 240p Test Suite" }).click();
  await expect(page.getByRole("dialog", { name: "Library" })).toHaveCount(0, { timeout: 90_000 });
  await expect.poll(() => emulatorCommand(page), { timeout: 90_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro-snes \/tmp\/kandelo-retro\/rom\.sfc/);
  await awaitRender(canvas);
  await expect(page.getByTestId("fb-group-SNES")).toHaveAttribute("aria-pressed", "true");
});

test("the dock switches consoles, resets, and powers the machine off and on", async ({ page }) => {
  test.setTimeout(600_000);
  const canvas = await bootRetro(page);

  // The console switcher loads that console's included ROM.
  await page.getByTestId("fb-group-Mega Drive").click();
  await expect.poll(() => emulatorCommand(page), { timeout: 90_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro-genesis \/tmp\/kandelo-retro\/rom\.md/);
  await awaitRender(canvas);
  await expect(page.getByTestId("fb-group-Mega Drive")).toHaveAttribute("aria-pressed", "true");

  // Reset is a new emulator process on the same ROM.
  const before = await boundPid(page);
  await page.getByTestId("fb-reset").click();
  await expect.poll(async () => {
    const pid = await boundPid(page);
    return pid !== null && pid !== before;
  }, { timeout: 90_000 }).toBe(true);
  await expect.poll(() => emulatorCommand(page), { timeout: 30_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro-genesis \/tmp\/kandelo-retro\/rom\.md$/);

  // Power off stops the emulator and leaves nothing on /dev/fb0.
  await page.getByTestId("fb-power").click();
  await expect.poll(() => boundPid(page), { timeout: 90_000 }).toBeNull();
  await expect(page.getByTestId("fb-power")).toHaveText("Power on");
  await expect(page.locator(".kdemo-surface-badge")).toHaveText(/powered off/i);
  await expect.poll(() => emulatorCommand(page), { timeout: 30_000 })
    .toBe("0 emulator processes");

  // Power on starts it again on the same ROM.
  await page.getByTestId("fb-power").click();
  await expect.poll(() => boundPid(page), { timeout: 90_000 }).not.toBeNull();
  await awaitRender(canvas);
  await expect.poll(() => emulatorCommand(page), { timeout: 30_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro-genesis /);
});

test("Save state puts the game in the address bar, and reloading restores it", async ({ page }) => {
  test.setTimeout(600_000);
  const canvas = await bootRetro(page);
  await canvas.click();
  await settledDigest(canvas);
  const firstRows = await frameRows(canvas);
  await page.keyboard.press("ArrowRight");
  await waitForRows(canvas, firstRows, PAGE_TURN);

  await releasePointer(page);
  expect(new URL(page.url()).hash).toBe("");
  await page.getByTestId("fb-save-state").click();
  await expect(page.locator(".kdemo-surface-badge")).toHaveText(/state saved/i, { timeout: 60_000 });
  await expect(page.getByTestId("fb-ingest-error")).toHaveCount(0);
  expect(new URL(page.url()).hash).toMatch(/^#k1=/);

  // Reload: the machine comes back on the page it was saved on, so Left
  // turns back a page and Right returns to the restored frame.
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloaded = page.locator("canvas.kframebuffer-canvas").first();
  await expect(reloaded).toBeVisible({ timeout: 180_000 });
  await awaitRender(reloaded);
  await expect.poll(() => emulatorCommand(page), { timeout: 30_000 })
    .toMatch(/--state \/run\/kandelo\/inputs\/state\/retro\.state$/);
  await reloaded.click();
  await settledDigest(reloaded);
  const restoredRows = await frameRows(reloaded);
  await page.keyboard.press("ArrowLeft");
  await waitForRows(reloaded, restoredRows, PAGE_TURN);

  // The saved state is where the link starts, not a property of the ROM:
  // Reset starts the same ROM from its beginning.
  await releasePointer(page);
  await page.getByTestId("fb-reset").click();
  await expect.poll(() => emulatorCommand(page), { timeout: 90_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro \/tmp\/kandelo-retro\/rom\.nes$/);
  expect(new URL(page.url()).hash).toMatch(/^#k1=/);

  // Loading another ROM leaves the saved game behind, so the address no
  // longer claims to restore this machine.
  await page.getByTestId("fb-group-SNES").click();
  await expect.poll(() => emulatorCommand(page), { timeout: 90_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro-snes /);
  expect(new URL(page.url()).hash).toBe("");
});

test("Save state refuses a ROM that came from the visitor's own device", async ({ page }) => {
  test.setTimeout(420_000);
  requireStarterRoms();
  const canvas = await bootRetro(page);
  await loadRom(page, canvas, MD_ROM);
  await expect(page.getByTestId("fb-current-content")).toContainText("240pSuite-md-1.21.bin");
  await page.getByTestId("fb-save-state").click();
  await expect(page.getByTestId("fb-ingest-error")).toContainText(/came from this device/);
  expect(new URL(page.url()).hash).toBe("");
});

test("the library plays an Internet Archive ROM, and a checkpoint link fetches it again", async ({ page, context }) => {
  test.setTimeout(600_000);
  test.skip(!(await archiveReachable()), "archive.org unreachable (offline)");
  const canvas = await bootRetro(page);

  await openLibrary(page);
  await page.getByTestId("library-featured").getByRole("button", { name: "Open Carpet Shark" }).click();
  await page.getByTestId("library-files")
    .getByRole("button", { name: /^Play .*CarpetShark\.nes$/ }).click();
  await expect(page.getByRole("dialog", { name: "Library" })).toHaveCount(0, { timeout: 120_000 });
  await expect.poll(() => emulatorCommand(page), { timeout: 90_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro \/tmp\/kandelo-retro\/rom\.nes/);
  await awaitRender(canvas);
  await settledDigest(canvas);

  await page.getByRole("button", { name: "Share" }).click();
  await page.getByTestId("share-checkpoint-toggle").check();
  await expect(page.getByTestId("share-checkpoint-status"))
    .toContainText("Checkpoint taken", { timeout: 60_000 });
  const shareUrl = page.locator(".kshare-url");
  await expect(shareUrl).toHaveAttribute("data-share-url", /#k1=/, { timeout: 30_000 });
  const url = (await shareUrl.getAttribute("data-share-url"))!;

  // The opener's machine fetches the ROM from the Archive itself, checks it
  // against the link's sha256, and restores the state onto it.
  const opener = await context.newPage();
  await opener.goto(url, { waitUntil: "domcontentloaded" });
  const reopened = opener.locator("canvas.kframebuffer-canvas").first();
  await expect(reopened).toBeVisible({ timeout: 180_000 });
  await awaitRender(reopened);
  await expect.poll(() => emulatorCommand(opener), { timeout: 60_000 }).toMatch(
    /\/tmp\/kandelo-retro\/rom\.nes --state \/run\/kandelo\/inputs\/state\/retro\.state$/,
  );
});

test("the library extracts one ROM from an Internet Archive ZIP", async ({ page }) => {
  test.setTimeout(600_000);
  test.skip(!(await archiveReachable()), "archive.org unreachable (offline)");
  const canvas = await bootRetro(page);
  await openLibrary(page);
  await page.getByTestId("library-group-Mega Drive").click();
  await page.getByTestId("library-featured").getByRole("button", { name: "Open Capoeira Boy" }).click();
  // The item's only loadable file is a ZIP, so it opens by itself.
  const members = page.getByTestId("library-members");
  await expect(members.getByRole("button", { name: /^Play / }).first()).toBeVisible({ timeout: 120_000 });
  // The filter narrows the members by name; nothing matches nonsense.
  await page.getByTestId("library-member-filter").fill("no such rom zzz");
  await expect(members.getByRole("button", { name: /^Play / })).toHaveCount(0);
  await expect(members).toContainText("No entry names match the filter.");
  await page.getByTestId("library-member-filter").fill("");
  await members.getByRole("button", { name: /^Play / }).first().click();
  await expect(page.getByRole("dialog", { name: "Library" })).toHaveCount(0, { timeout: 120_000 });
  await expect.poll(() => emulatorCommand(page), { timeout: 90_000 })
    .toMatch(/\/usr\/bin\/kandelo-retro-genesis /);
  await awaitRender(canvas);
});
