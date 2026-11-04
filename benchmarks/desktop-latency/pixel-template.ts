import assert from 'node:assert/strict';

export interface WindowRaster { width: number; height: number; stride: number; bgra: Uint8Array }
export interface TemplateRect { x: number; y: number; width: number; height: number }
export interface PixelTemplate {
  width: number;
  height: number;
  points: { x: number; y: number; rgb: number[] }[];
}

function validateRaster(raster: WindowRaster) {
  assert(Number.isInteger(raster.width) && raster.width > 0 && raster.width <= 2048);
  assert(Number.isInteger(raster.height) && raster.height > 0 && raster.height <= 2048);
  assert(Number.isInteger(raster.stride) && raster.stride >= raster.width * 4 && raster.stride <= 12288);
  assert.equal(raster.bgra.length, raster.stride * raster.height, 'Truncated or oversized window raster');
}

// Learn only from a measured change at this rectangle: e.g. the actual guest
// cursor present here in one calibration frame and elsewhere in the other.
// The caller must independently validate the learned template at another pose.
export function learnPixelTemplate(background: WindowRaster, foreground: WindowRaster,
  rect: TemplateRect, minimumContrast = 48): PixelTemplate {
  validateRaster(background);
  validateRaster(foreground);
  assert.equal(background.width, foreground.width);
  assert.equal(background.height, foreground.height);
  assert(Object.values(rect).every(Number.isInteger));
  assert(rect.width > 0 && rect.width <= 64 && rect.height > 0 && rect.height <= 64);
  assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= foreground.width && rect.y + rect.height <= foreground.height);
  assert(Number.isInteger(minimumContrast) && minimumContrast >= 32 && minimumContrast <= 255);
  const changed: PixelTemplate['points'] = [];
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const a = (rect.y + y) * background.stride + (rect.x + x) * 4;
      const b = (rect.y + y) * foreground.stride + (rect.x + x) * 4;
      const delta = [0, 1, 2].map(k => Math.abs(foreground.bgra[b + k] - background.bgra[a + k]));
      if (Math.max(...delta) >= minimumContrast)
        changed.push({ x, y, rgb: [foreground.bgra[b + 2], foreground.bgra[b + 1], foreground.bgra[b]] });
    }
  }
  assert(changed.length >= 6, 'Calibration has insufficient changed pixels; refusing a background template');
  // Deterministic spatial coverage; no per-frame template construction.
  const points = changed.length <= 256 ? changed : Array.from({ length: 256 }, (_, i) => changed[Math.floor(i * changed.length / 256)]);
  return { width: rect.width, height: rect.height, points };
}
