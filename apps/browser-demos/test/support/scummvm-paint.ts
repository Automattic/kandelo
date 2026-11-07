import type { Page } from "@playwright/test";
const canvas = (page: Page) => page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

export type Rect = { x: number; y: number; width: number; height: number; pixels: number };
export type Paint = {
  width: number; height: number; orange: Rect; orangePixels: number;
  pale: Rect[]; buttons: Rect[]; greenPixels: number; footPixels: number;
};

/** Inspect a real screenshot, not a DOM canvas backing store (the KMS canvas
 * is transferred to its renderer). Palette values come from the packaged
 * ScummVM 2026.3 Remastered theme, remastered_gfx.stx. Its mainmenu_bg is
 * orange, widget_default is pale cream, buttons are dark red, and logo.svg
 * is green. Terminal glyphs or a cursor cannot satisfy this spatial layout.
 * A future default-theme change should update this explicit paint contract.
 */
export async function painted(page: Page): Promise<Paint> {
  const png = await canvas(page).screenshot({ animations: "disabled" });
  return page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    const masks = [new Uint8Array(width * height), new Uint8Array(width * height), new Uint8Array(width * height)];
    let orangePixels = 0, greenPixels = 0, footPixels = 0;
    let left = width, top = height, right = -1, bottom = -1;
    for (let i = 0; i < width * height; i++) {
      const r = data[4 * i], g = data[4 * i + 1], b = data[4 * i + 2];
      if (Math.abs(r - 204) <= 5 && Math.abs(g - 102) <= 5 && b <= 5) {
        masks[0][i] = 1; orangePixels++;
        left = Math.min(left, i % width); right = Math.max(right, i % width);
        top = Math.min(top, Math.floor(i / width)); bottom = Math.max(bottom, Math.floor(i / width));
      }
      // Both widget_default's cream and default_bg's pale gradient.
      if (r >= 225 && r <= 255 && g >= 215 && g <= 250 && b >= 180 && b <= 215) masks[1][i] = 1;
      if (r >= 120 && r <= 195 && g >= 20 && g <= 45 && b <= 18) masks[2][i] = 1;
      if (r < 25 && g > 90 && g > b * 2 && b < 80) greenPixels++;
      if (r > 20 && r < 60 && Math.abs(r - g) < 8 && Math.abs(r - b) < 8) footPixels++;
    }
    function components(mask: Uint8Array) {
      const result: Rect[] = [], queue = new Int32Array(width * height);
      for (let seed = 0; seed < mask.length; seed++) {
        if (!mask[seed]) continue;
        let head = 0, tail = 1, minX = width, minY = height, maxX = 0, maxY = 0;
        queue[0] = seed; mask[seed] = 0;
        while (head < tail) {
          const i = queue[head++], x = i % width, y = Math.floor(i / width);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          const visit = (next: number) => { if (mask[next]) { mask[next] = 0; queue[tail++] = next; } };
          if (x) visit(i - 1); if (x + 1 < width) visit(i + 1);
          if (y) visit(i - width); if (y + 1 < height) visit(i + width);
        }
        const w = maxX - minX + 1, h = maxY - minY + 1;
        if (w >= 30 && h >= 10 && tail / (w * h) > 0.45)
          result.push({ x: minX, y: minY, width: w, height: h, pixels: tail });
      }
      return result;
    }
    return { width, height, orange: { x: left, y: top, width: right - left + 1, height: bottom - top + 1, pixels: orangePixels },
      orangePixels, pale: components(masks[1]), buttons: components(masks[2]), greenPixels, footPixels };
  }, png.toString("base64"));
}

export function isLauncher(paint: Paint): boolean {
  const app = paint.orange;
  const inside = (r: Rect) => r.x >= app.x && r.y >= app.y
    && r.x + r.width <= app.x + app.width + 2 && r.y + r.height <= app.y + app.height + 2;
  return app.width >= 300 && app.height >= 200 && paint.orangePixels > app.width * app.height * 0.06
    && paint.pale.some(r => inside(r) && r.width >= 120 && r.height >= 70)
    && paint.buttons.filter(r => inside(r) && r.width >= 40 && r.height <= 65).length >= 3
    && paint.greenPixels >= 100;
}

