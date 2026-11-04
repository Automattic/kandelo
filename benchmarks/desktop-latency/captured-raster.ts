import type { WindowRaster } from './pixel-template.js';
import type { ViewportMapping } from './viewport-calibration.js';

export async function screenshotRaster(page: any, path?: string,
  projection?: { width: number; height: number; mapping: ViewportMapping }): Promise<WindowRaster> {
  const png = await page.screenshot({ ...(path ? { path } : {}), scale: 'css' });
  const data = await page.evaluate(async ({ bytes, projection }: any) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = projection?.width ?? image.width; canvas.height = projection?.height ?? image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgb(10,10,10)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (projection) {
      const m = projection.mapping;
      ctx.drawImage(image, m.x.offset, m.y.offset, image.width * m.x.scale, image.height * m.y.scale);
    } else ctx.drawImage(image, 0, 0);
    image.close();
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < rgba.length; i += 4) { const r = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = r; }
    // Transfer packed bytes across the browser boundary. Serializing millions
    // of individual pixel numbers overwhelms a headless replay's Node realm.
    let binary = '';
    for (let i = 0; i < rgba.length; i += 16384)
      binary += String.fromCharCode(...rgba.subarray(i, i + 16384));
    return { width: canvas.width, height: canvas.height, stride: canvas.width * 4, bgra: btoa(binary) };
  }, { bytes: Array.from(png), projection });
  return { ...data, bgra: new Uint8Array(Buffer.from(data.bgra, 'base64')) };
}
export function snapshotRaster(row: any): WindowRaster {
  return { width: row.width, height: row.height, stride: row.stride, bgra: new Uint8Array(Buffer.from(row.bgra, 'base64')) };
}
