import type { Page } from "@playwright/test";

/** Compare rendered pixels, independently of a PNG encoder's metadata or
 * compression. Retain dimensions and changed bounds for a failed idle gate. */
export async function screenshotPixelDelta(page: Page, before: Buffer, after: Buffer) {
  return page.evaluate(async ([a, b]) => {
    const decode = async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      try {
        const context = new OffscreenCanvas(image.width, image.height).getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height);
      } finally { image.close(); }
    };
    const [x, y] = await Promise.all([decode(a), decode(b)]);
    const dimensions = { before: { width: x.width, height: x.height }, after: { width: y.width, height: y.height } };
    if (x.width !== y.width || x.height !== y.height)
      return { same: false, dimensions, changed: null, bounds: null };
    let changed = 0, x0 = x.width, y0 = x.height, x1 = -1, y1 = -1;
    for (let i = 0; i < x.data.length; i += 4) {
      if (x.data[i] === y.data[i] && x.data[i + 1] === y.data[i + 1] &&
          x.data[i + 2] === y.data[i + 2] && x.data[i + 3] === y.data[i + 3]) continue;
      changed++;
      const px = (i / 4) % x.width, py = Math.floor(i / 4 / x.width);
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    return { same: changed === 0, dimensions, changed, bounds: changed ? { x0, y0, x1, y1 } : null };
  }, [before.toString("base64"), after.toString("base64")]);
}
