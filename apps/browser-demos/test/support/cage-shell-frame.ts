import type { Page } from "@playwright/test";

/** Observe shell output in the actual captured cage canvas, not its backing
 * OffscreenCanvas. Foot process creation precedes the shell's first PTY output. */
export async function cageShellTextColumns(
  page: Page,
  png: Buffer,
  output: { width: number; height: number },
): Promise<number> {
  return page.evaluate(async ({ encoded, output }) => {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    try {
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = surface.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const sx = bitmap.width / output.width;
      const sy = bitmap.height / output.height;
      // Full-screen Foot has no compositor titlebar. Sample the first text
      // row in its configured 14pt font, excluding the first cursor cell.
      // Scale output coordinates to the screenshot, as the Sway gate does.
      const { data, width, height } = context.getImageData(
        Math.round(12 * sx), 0,
        Math.round(160 * sx), Math.round(32 * sy),
      );
      let columns = 0;
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
          const pixel = (y * width + x) * 4;
          if (data[pixel] > 100 && data[pixel + 1] > 100 && data[pixel + 2] > 100) {
            columns++;
            break;
          }
        }
      }
      return columns / sx;
    } finally {
      bitmap.close();
    }
  }, { encoded: png.toString("base64"), output });
}
