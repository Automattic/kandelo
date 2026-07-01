import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { FB_SPECS, pourHomebrewFbVfs, type FbSmokeResult } from "../../../scripts/homebrew-fb-vfs";

/**
 * CI regression gate for the Homebrew framebuffer/device browser certification
 * (modeset + fbdoom). Matches the kandelo-modeset.spec pattern: it drives the
 * headless (new-headless `chromium` channel) browser and fails if the packages
 * lose in-browser rendering -- exactly the silent-breakage class behind the
 * #810 near-miss.
 *
 * It pours the Homebrew VFS from a configured tap + bottle cache (+ DOOM
 * shareware IWAD for fbdoom) and SKIPS when those inputs are not present, so it
 * is a no-op in browser jobs that do not provide Homebrew bottles and a hard
 * gate in the Homebrew smoke/publish job that does. Provide inputs via:
 *   KANDELO_HB_FB_TAP_ROOT     (tap dir with Kandelo/metadata.json)
 *   KANDELO_HB_FB_BOTTLE_CACHE (dir of <sha256>.tar.gz bottles; optional if the
 *                               tap urls are https and fetchable)
 *   KANDELO_HB_FB_WAD          (doom1.wad path; required for fbdoom)
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const browserDemoDir = resolve(__dirname, "..");
const runId = "kd-jg94-spec";
const publicDir = join(browserDemoDir, "public", "__kandelo-homebrew-fb-smoke", runId);
const publicUrlBase = `/__kandelo-homebrew-fb-smoke/${runId}`;

const tapRoot = process.env.KANDELO_HB_FB_TAP_ROOT;
const bottleCache = process.env.KANDELO_HB_FB_BOTTLE_CACHE || (tapRoot ? join(tapRoot, "..", "bottle-cache") : "");
const wadFile = process.env.KANDELO_HB_FB_WAD;
const observeMs = Number(process.env.KANDELO_HB_FB_OBSERVE_MS ?? 16_000);

const inputsPresent = Boolean(tapRoot && existsSync(join(tapRoot, "Kandelo", "metadata.json")));

async function runSmoke(page: Page, formula: string): Promise<FbSmokeResult> {
  const spec = FB_SPECS[formula];
  await page.goto("/pages/homebrew-fb-smoke/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __homebrewFbSmokeReady?: boolean }).__homebrewFbSmokeReady === true, undefined, { timeout: 60_000 });
  return (await page.evaluate(
    async ({ vfsUrl, argv, mode, ms }) =>
      (window as unknown as { __runHomebrewFbSmoke: (r: unknown) => Promise<FbSmokeResult> }).__runHomebrewFbSmoke({ vfsUrl, argv, mode, crtcId: 1, observeMs: ms }),
    { vfsUrl: `${publicUrlBase}/${formula}-wasm32-homebrew.vfs.zst`, argv: spec.argv, mode: spec.mode, ms: observeMs },
  )) as FbSmokeResult;
}

test.describe("Homebrew framebuffer/device browser certification (modeset + fbdoom)", () => {
  test.skip(!inputsPresent, "Homebrew framebuffer inputs not provided (set KANDELO_HB_FB_TAP_ROOT/BOTTLE_CACHE/WAD)");
  // modeset drives WebGL2 on a transferred OffscreenCanvas inside a Web Worker,
  // which only the new-headless `chromium` channel supports.
  test.skip(({ browserName }) => browserName !== "chromium", "framebuffer smoke requires the chromium channel (WebGL2-in-worker)");
  test.setTimeout(180_000);

  test.beforeAll(async () => {
    mkdirSync(publicDir, { recursive: true });
    for (const formula of ["fbdoom", "modeset"]) {
      await pourHomebrewFbVfs({
        tapRoot: tapRoot!,
        formula,
        arch: "wasm32",
        bottleCache,
        wadFile,
        outImagePath: join(publicDir, `${formula}-wasm32-homebrew.vfs.zst`),
        createdBy: "apps/browser-demos/test/homebrew-framebuffer.spec.ts",
      });
    }
  });

  test.afterAll(() => {
    rmSync(publicDir, { recursive: true, force: true });
  });

  test("fbdoom renders DOOM to /dev/fb0", async ({ page }) => {
    const r = await runSmoke(page, "fbdoom");
    // Bound the framebuffer, pushed pixel-write frames, and painted a non-blank canvas.
    expect(r.binds, `fbdoom should bind /dev/fb0 (result=${JSON.stringify(r)})`).toBeGreaterThanOrEqual(1);
    expect(r.writes, "fbdoom should push framebuffer writes").toBeGreaterThanOrEqual(1);
    expect(r.canvasNonBlankPixels, "fbdoom canvas should render non-blank pixels").toBeGreaterThan(0);
  });

  test("modeset commits page-flips through /dev/dri/card0", async ({ page }) => {
    const r = await runSmoke(page, "modeset");
    // Committed KMS page-flips through the CRTC with a live scanout resolution.
    expect(r.kmsCommits, `modeset should commit CRTC page-flips (result=${JSON.stringify(r)})`).toBeGreaterThanOrEqual(1);
    expect(r.width, "modeset should publish a scanout width").toBeGreaterThan(0);
    expect(r.height, "modeset should publish a scanout height").toBeGreaterThan(0);
  });
});
