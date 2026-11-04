import assert from 'node:assert/strict';
import type { WindowRaster } from './pixel-template.js';

export interface ViewportMarker { x: number; y: number; rgb: number[] }
export function viewportMarkers(width: number, height: number): ViewportMarker[] {
  assert(width >= 200 && height >= 200);
  return [
    { x: 24, y: 24, rgb: [223, 31, 171] },
    { x: width - 24, y: 24, rgb: [31, 223, 171] },
    { x: 24, y: height - 24, rgb: [171, 223, 31] },
    { x: width - 24, y: height - 24, rgb: [171, 31, 223] },
  ];
}
export function calibrateViewport(raster: WindowRaster, markers: ViewportMarker[]) {
  assert(Number.isInteger(raster.width) && raster.width > 0 && raster.width <= 2048);
  assert(Number.isInteger(raster.height) && raster.height > 0 && raster.height <= 2048);
  assert(Number.isInteger(raster.stride) && raster.stride >= raster.width * 4 && raster.stride <= 12288);
  assert.equal(raster.bgra.length, raster.stride * raster.height);
  assert.equal(markers.length, 4);
  const found = markers.map(marker => {
    assert([marker.x, marker.y, ...marker.rgb].every(Number.isFinite) && marker.rgb.length === 3);
    let count = 0, sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const i = y * raster.stride + x * 4;
        if (Math.abs(raster.bgra[i + 2] - marker.rgb[0]) <= 12 &&
            Math.abs(raster.bgra[i + 1] - marker.rgb[1]) <= 12 &&
            Math.abs(raster.bgra[i] - marker.rgb[2]) <= 12) {
          count++; sx += x + .5; sy += y + .5;
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
    }
    assert(count >= 9 && x1 - x0 < 64 && y1 - y0 < 64 &&
      count / ((x1 - x0 + 1) * (y1 - y0 + 1)) >= .6,
    'Missing or ambiguous viewport marker');
    return { source: marker, x: sx / count, y: sy / count, count, bounds: { x0, y0, x1, y1 } };
  });
  const fit = (axis: 'x' | 'y') => {
    const sourceMean = found.reduce((s, p) => s + p.source[axis], 0) / 4;
    const targetMean = found.reduce((s, p) => s + p[axis], 0) / 4;
    const variance = found.reduce((s, p) => s + (p.source[axis] - sourceMean) ** 2, 0);
    assert(variance >= 100, 'Degenerate viewport marker geometry');
    const scale = found.reduce((s, p) => s + (p.source[axis] - sourceMean) * (p[axis] - targetMean), 0) / variance;
    assert(scale >= .1 && scale <= 4, 'Invalid viewport scale');
    return { scale, offset: targetMean - scale * sourceMean };
  };
  const x = fit('x'), y = fit('y');
  assert(Math.abs(x.scale / y.scale - 1) <= .03, 'Viewport mapping is distorted');
  const maxResidual = Math.max(...found.map(p => Math.hypot(
    p.x - (x.offset + x.scale * p.source.x), p.y - (y.offset + y.scale * p.source.y))));
  assert(maxResidual <= 1.5, 'Viewport markers do not fit a single mapping');
  return { x, y, maxResidual, found };
}
export type ViewportMapping = ReturnType<typeof calibrateViewport>;
export function mapViewportPoint(mapping: ViewportMapping, point: { x: number; y: number }) {
  assert([point.x, point.y].every(Number.isFinite));
  return { x: Math.round(mapping.x.offset + mapping.x.scale * point.x),
    y: Math.round(mapping.y.offset + mapping.y.scale * point.y) };
}
