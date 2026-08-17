import { expect, test, type Page } from "@playwright/test";
import { inflateSync } from "node:zlib";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

/** One composited pixel. `locator.screenshot()` returns a stale
 *  rasterization of the canvas, and a `readPixels` inside the worker
 *  reads the drawing buffer — which is exactly what disagrees with the
 *  page when an upload is rejected. Only a page capture answers the
 *  question this spec asks. */
async function pixelAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({
    clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 },
    type: "png",
  });
  const idat: Buffer[] = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    if (png.toString("ascii", off + 4, off + 8) === "IDAT") {
      idat.push(png.subarray(off + 8, off + 8 + len));
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

const near = (got: [number, number, number], want: [number, number, number]) =>
  got.every((c, i) => Math.abs(c - want[i]) <= 24);

async function step(page: Page, name: string) {
  await page.evaluate((s) => (window as unknown as { __kmsStep: (s: string) => void }).__kmsStep(s), name);
  await page.waitForFunction(
    (s) => (window as unknown as { __kmsPhase?: { step?: string } }).__kmsPhase?.step === s,
    name,
    { timeout: 30_000 },
  );
  return await page.evaluate(() => (window as unknown as { __kmsPhase: unknown }).__kmsPhase);
}

/**
 * A GPU compositor that degrades hands its canvas back to the vblank pump
 * (`markKmsCanvasGlReleased`), and the pump rebuilds its presenter on the
 * WebGL2 context the dead session was driving — `getContext` returns the
 * existing one. Pixel-store state survives that handover, and a leftover
 * `UNPACK_ROW_LENGTH`, skip count or bound `PIXEL_UNPACK_BUFFER` makes
 * every scanout upload `GL_INVALID_OPERATION` without raising a JS
 * exception: the pump reports presents while the canvas stays black. A
 * leftover flip or premultiply uploads cleanly and corrupts the image.
 *
 * The vitest suite (host/test/dri-kms-stats-sab.test.ts) pins the reset
 * calls against a fake GL. It cannot see a rejected upload, which is the
 * whole failure mode — hence this spec, on a real context.
 */
test("the KMS presenter repaints after a GL session leaves pixel-store state behind", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto(appUrl("/test/fixtures/kms-presenter.html"), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (window as unknown as { __kmsPhase?: unknown }).__kmsPhase !== undefined,
    undefined,
    { timeout: 30_000 },
  );

  const init = await page.evaluate(() => (window as unknown as { __kmsPhase: { presenter?: number; error?: string } }).__kmsPhase);
  expect(init.error, "fixture worker failed to start").toBeUndefined();
  // Slot 7 = 2: the pump's webgl2-scanout presenter painted. A host
  // without worker-side WebGL2 leaves it at 0 and the spec would be
  // asserting against a canvas nobody drew.
  expect(init.presenter, "webgl2-scanout presenter did not paint").toBe(2);

  const box = (await page.locator("#scanout").boundingBox())!;
  const top = [box.x + box.width / 2, box.y + box.height * 0.25] as const;
  const bottom = [box.x + box.width / 2, box.y + box.height * 0.75] as const;

  // The first scanout is red over green. Both halves prove the swizzle and
  // the row order before anything is polluted.
  expect(near(await pixelAt(page, ...top), [255, 0, 0]), "baseline top half").toBe(true);
  expect(near(await pixelAt(page, ...bottom), [0, 255, 0]), "baseline bottom half").toBe(true);

  await step(page, "pollute");
  await step(page, "release");

  // The rebuilt presenter uploads a blue-over-yellow scanout. A rejected
  // upload leaves both halves black; a leftover flip swaps them; a
  // leftover premultiply zeroes the colour, because the scanout is
  // XRGB8888 with X = 0.
  expect(near(await pixelAt(page, ...top), [0, 0, 255]), "rebuilt top half").toBe(true);
  expect(near(await pixelAt(page, ...bottom), [255, 255, 0]), "rebuilt bottom half").toBe(true);
});
