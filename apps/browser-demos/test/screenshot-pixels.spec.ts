import { expect, test } from "@playwright/test";
import { screenshotPixelDelta } from "./support/screenshot-pixels";

test("screenshot equality observes pixels rather than PNG encoding", async ({ page }) => {
  const images = await page.evaluate(async () => {
    const png = async (width: number, changed: boolean) => {
      const canvas = new OffscreenCanvas(width, 12), context = canvas.getContext("2d")!;
      context.fillStyle = "#123456"; context.fillRect(0, 0, width, 12);
      if (changed) { context.fillStyle = "#fedcba"; context.fillRect(7, 5, 1, 1); }
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    };
    return { original: await png(16, false), changed: await png(16, true), resized: await png(17, false) };
  });
  const original = Buffer.from(images.original, "base64");
  expect(original.subarray(-8, -4).toString()).toBe("IEND");
  // Valid PNG tEXt chunk (Comment\0encoding control), including its CRC.
  // It changes the file bytes without changing even one decoded pixel.
  const text = Buffer.from("AAAAGHRFWHRDb21tZW50AGVuY29kaW5nIGNvbnRyb2z+pS6X", "base64");
  const metadata = Buffer.concat([original.subarray(0, -12), text, original.subarray(-12)]);
  expect(metadata.equals(original), "the previous byte-equality gate rejects this same image").toBe(false);
  expect(await screenshotPixelDelta(page, original, metadata)).toMatchObject({ same: true, changed: 0, bounds: null });
  expect(await screenshotPixelDelta(page, original, Buffer.from(images.changed, "base64")))
    .toMatchObject({ same: false, changed: 1, bounds: { x0: 7, y0: 5, x1: 7, y1: 5 } });
  expect(await screenshotPixelDelta(page, original, Buffer.from(images.resized, "base64")))
    .toMatchObject({ same: false, changed: null, dimensions: { before: { width: 16, height: 12 }, after: { width: 17, height: 12 } } });
  await expect(screenshotPixelDelta(page, original, Buffer.from("invalid PNG"))).rejects.toThrow();
});
