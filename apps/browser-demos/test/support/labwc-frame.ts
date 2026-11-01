import type { Page } from "@playwright/test";

const canvas = (page: Page) => page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

export interface Rect { x: number; y: number; width: number; height: number }
export interface Frame { width: number; height: number; foot: Rect | null; ink: number; red: number }

/** Find the connected neutral dark background of the real foot client.
 * Root background and SSD titlebars are lighter; text creates small holes.
 * This reads the rendered screenshot, never a guest-memory or mock surface.
 */
export async function footFrame(page: Page): Promise<Frame> {
  const png = await canvas(page).screenshot();
  return page.evaluate(async base64 => {
    const png = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { width, height, data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    const seen = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    const dark = (pixel: number) => {
      const at = pixel * 4, r = data[at], g = data[at + 1], b = data[at + 2];
      return r > 20 && r < 60 && Math.abs(r - g) < 8 && Math.abs(r - b) < 8;
    };
    let foot: Rect | null = null;
    let largest = 0;
    for (let pixel = 0; pixel < seen.length; pixel++) {
      if (seen[pixel] || !dark(pixel)) continue;
      seen[pixel] = 1;
      queue[0] = pixel;
      let tail = 1, left = width, top = height, right = 0, bottom = 0;
      for (let head = 0; head < tail; head++) {
        const current = queue[head], x = current % width, y = Math.floor(current / width);
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (const next of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1,
          y > 0 ? current - width : -1, y + 1 < height ? current + width : -1]) {
          if (next < 0 || seen[next] || !dark(next)) continue;
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
      if (right - left > 150 && bottom - top > 80 && tail > largest) {
        largest = tail;
        foot = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
      }
    }
    let ink = 0, red = 0;
    if (foot) for (let y = foot.y; y < foot.y + foot.height; y++) {
      for (let x = foot.x; x < foot.x + foot.width; x++) {
        const p = (y * width + x) * 4;
        if (data[p] > 150 && data[p + 1] > 150 && data[p + 2] > 150) ink++;
        if (data[p] > 100 && data[p + 1] < 80 && data[p + 2] < 80) red++;
      }
    }
    return { width, height, foot, ink, red };
  }, png.toString("base64"));
}

/** A newly painted menu must contain a large connected changed rectangle.
 * A cursor or blinking terminal cell cannot satisfy this area/fill gate.
 * Baseline and current captures use the same pointer position.
 */
export async function menuChange(page: Page, before: Buffer): Promise<Rect | null> {
  const after = await canvas(page).screenshot();
  return page.evaluate(async ([before, after]) => {
    const decode = async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = surface.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      return image;
    };
    const a = await decode(before), b = await decode(after);
    if (a.width !== b.width || a.height !== b.height) throw new Error("canvas resized during root-menu check");
    const { width, height } = a;
    const changed = new Uint8Array(width * height);
    for (let p = 0; p < changed.length; p++) {
      const at = p * 4;
      changed[p] = Math.max(...[0, 1, 2].map(c => Math.abs(a.data[at + c] - b.data[at + c]))) > 35 ? 1 : 0;
    }
    const queue = new Int32Array(changed.length);
    for (let p = 0; p < changed.length; p++) {
      if (!changed[p]) continue;
      changed[p] = 0; queue[0] = p;
      let tail = 1, left = width, top = height, right = 0, bottom = 0;
      for (let head = 0; head < tail; head++) {
        const current = queue[head], x = current % width, y = Math.floor(current / width);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (const next of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1,
          y > 0 ? current - width : -1, y + 1 < height ? current + width : -1]) {
          if (next < 0 || !changed[next]) continue;
          changed[next] = 0; queue[tail++] = next;
        }
      }
      const rect = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
      if (rect.width > 80 && rect.height > 50 && tail > 2_000 && tail / (rect.width * rect.height) > 0.65) return rect;
    }
    return null;
  }, [before.toString("base64"), after.toString("base64")] as const);
}
