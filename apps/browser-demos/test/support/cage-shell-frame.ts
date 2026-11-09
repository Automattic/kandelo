import type { Page } from "@playwright/test";

/** Observe shell output in the actual captured cage canvas, not its backing
 * OffscreenCanvas. WLTERM_READY precedes the shell's first PTY output. */
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
      // libkwl's client-side titlebar is 28 output pixels; wlterm renders
      // 16px Inconsolata below it, with an 8px cell advance. Exclude the
      // first cell: the empty grid already has an underline cursor there.
      // Scale output coordinates to the screenshot, as the sway gate does.
      const { data, width, height } = context.getImageData(
        Math.round(8 * sx), Math.round(28 * sy),
        Math.round(120 * sx), Math.round(16 * sy),
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
