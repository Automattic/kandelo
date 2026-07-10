// "Bring your own WAD" ingest for the fbDOOM demo — the on-main consumer that
// exercises the reusable file-ingest capability end to end.
//
// The gate that matters is the /dev/fb0 handoff. fb0 is single-owner (EBUSY on
// a second open), so a successful reload requires the running fbdoom to exit
// and release the binding before the replacement can start. We prove that by
// watching the bound pid change AND fbDOOM re-render — the new process was
// launched by the author's restart command (`fbdoom -iwad /user.wad`), so a
// fresh pid painting DOOM is evidence the upload landed and was loaded.
//
// The demo boots by fetching the shareware doom1.wad; this spec uploads a WAD
// obtained the same way. If that fetch is unavailable the whole demo can't run,
// so the suite skips rather than reporting a false failure.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOOM_WAD_URL = "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

let wadPath = "";

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-doom-ingest-"));
  wadPath = join(dir, "doom1.wad");
  try {
    const res = await fetch(DOOM_WAD_URL);
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    // A valid IWAD begins with the ASCII magic "IWAD".
    if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "IWAD") return;
    writeFileSync(wadPath, buf);
  } catch {
    // Left unwritten → tests skip below.
  }
});

async function bootDoomOrSkip(page: Page): Promise<Locator> {
  test.skip(!existsSync(wadPath), "doom1.wad unavailable (offline) — demo can't run");
  await page.goto(appUrl("/?demo=doom"), { waitUntil: "domcontentloaded" });
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  // Wait until fbDOOM has fetched its IWAD and painted the title screen.
  await expect.poll(() => distinctColors(canvas), {
    timeout: 120_000,
    intervals: [1_000, 2_000, 3_000],
  }).toBeGreaterThan(4);
  return canvas;
}

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

async function boundPid(page: Page): Promise<number | null> {
  const title = (await page.locator(".kdemo-surface-title").first().textContent()) ?? "";
  const m = /pid (\d+)/i.exec(title);
  return m ? Number(m[1]) : null;
}

async function awaitHandoffAndRender(page: Page, canvas: Locator): Promise<void> {
  await page.getByTestId("fb-ingest-busy")
    .waitFor({ state: "detached", timeout: 90_000 })
    .catch(() => { /* handoff may finish before we look */ });
  await expect.poll(() => distinctColors(canvas), {
    timeout: 90_000,
    intervals: [1_000, 2_000, 3_000],
  }).toBeGreaterThan(4);
}

test("Load WAD button swaps the running IWAD and hands /dev/fb0 over", async ({ page }) => {
  test.setTimeout(300_000);
  const canvas = await bootDoomOrSkip(page);
  const pidBefore = await boundPid(page);
  expect(pidBefore).not.toBeNull();

  const button = page.getByTestId("fb-ingest-button");
  await expect(button).toBeVisible();
  await expect(button).toHaveText(/load wad/i);

  await page.getByTestId("fb-ingest-input").setInputFiles(wadPath);
  await awaitHandoffAndRender(page, canvas);

  // A new process owns fb0 and is rendering. fbdoom only starts via the restart
  // command (`-iwad /user.wad`), so the old instance must have exited and
  // released fb0 — otherwise the relaunch would have hit EBUSY.
  const pidAfter = await boundPid(page);
  expect(pidAfter).not.toBeNull();
  expect(pidAfter).not.toBe(pidBefore);
  await expect(page.getByTestId("fb-ingest-error")).toHaveCount(0);
});

test("dropping a WAD on the framebuffer loads it", async ({ page }) => {
  test.setTimeout(300_000);
  const canvas = await bootDoomOrSkip(page);
  const pidBefore = await boundPid(page);

  // Hand the bytes to the page as base64: the app's service worker intercepts
  // in-page fetch(), and a multi-MB numeric array is too heavy for evaluate.
  const wadBase64 = readFileSync(wadPath).toString("base64");
  const dataTransfer = await page.evaluateHandle((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "custom.wad", { type: "application/octet-stream" }));
    return dt;
  }, wadBase64);

  const stage = page.locator(".kframebuffer-surface").first();
  await stage.dispatchEvent("dragover", { dataTransfer });
  await expect(page.getByTestId("fb-dropzone")).toBeVisible();

  await stage.dispatchEvent("drop", { dataTransfer });
  await awaitHandoffAndRender(page, canvas);
  expect(await boundPid(page)).not.toBe(pidBefore);
});

test("a rejected file fails visibly and leaves the running WAD alone", async ({ page }) => {
  test.setTimeout(300_000);
  await bootDoomOrSkip(page);
  const pidBefore = await boundPid(page);
  const error = page.getByTestId("fb-ingest-error");

  // Wrong extension — rejected before anything is written.
  await page.getByTestId("fb-ingest-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a wad"),
  });
  await expect(error).toBeVisible();
  await expect(error).toContainText(".wad");

  // Over the 32 MiB cap — rejected before anything is written.
  await page.getByTestId("fb-ingest-input").setInputFiles({
    name: "huge.wad",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(33 * 1024 * 1024, 1),
  });
  await expect(error).toBeVisible();
  await expect(error).toContainText(/exceeds/i);

  // The demo was never signalled: same pid, still up.
  expect(await boundPid(page)).toBe(pidBefore);
});
