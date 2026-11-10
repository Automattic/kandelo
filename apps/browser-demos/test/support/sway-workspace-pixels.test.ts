import assert from "node:assert/strict";
import test from "node:test";
import { workspaceButtonPixels } from "./sway-workspace-pixels.ts";

type RgbaImage = { width: number; height: number; data: Uint8Array };
type Color = readonly [number, number, number];
const BLUE: Color = [40, 85, 119];
const WHITE: Color = [255, 255, 255];

// Deliberately synthetic raster, not a captured engine/native-font fixture.
// Colored antialias samples form coherent ink without four near-white pixels.
const GLYPH = [
  ".###", "####", "#.##", "..##", "..##", "..##",
  "..##", "..##", "..##", "..##", "..##", "..##",
];
function pixel(image: RgbaImage, x: number, y: number, color: Color) {
  image.data.set([...color, 255], (y * image.width + x) * 4);
}
function block(image: RgbaImage, x: number, y: number, density: number, color: Color) {
  for (let dy = 0; dy < density; dy++) for (let dx = 0; dx < density; dx++) {
    pixel(image, x * density + dx, y * density + dy, color);
  }
}
function button(density: number): RgbaImage {
  const image = { width: 64 * density, height: 32 * density,
    data: new Uint8Array(64 * 32 * density * density * 4) };
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    const color: Color = x <= 21 ? [76, 120, 153] : [50, 50, 50];
    block(image, x, y, density, color);
  }
  for (let y = 1; y <= 30; y++) for (let x = 1; x <= 20; x++) block(image, x, y, density, BLUE);
  return image;
}
function glyph(image: RgbaImage, density: number) {
  let white = 0;
  for (let y = 0; y < GLYPH.length; y++) for (let x = 0; x < GLYPH[y].length; x++) {
    if (GLYPH[y][x] === "#") {
      const color: Color = white++ < 3 ? WHITE : [160, 180, 200];
      block(image, 8 + x, 10 + y, density, color);
    }
  }
  // Low-contrast fringe is present but must not inflate the glyph bounds.
  block(image, 7, 10, density, [65, 108, 139]);
}

for (const density of [1, 2]) {
  test(`synthetic antialiased glyph retains painted button geometry at density ${density}`, () => {
    const image = button(density); glyph(image, density);
    assert.deepEqual(workspaceButtonPixels(image), {
      x: density, y: density, width: 20 * density, height: 30 * density,
      glyph: { x: 8 * density, y: 10 * density, width: 4 * density,
        height: 12 * density, area: 28 * density * density },
    });
    if (density === 1) {
      let white = 0;
      for (let y = 1; y <= 30; y++) for (let x = 1; x <= 20; x++) {
        const at = (y * image.width + x) * 4;
        if (Math.min(image.data[at], image.data[at + 1], image.data[at + 2]) > 180) white++;
      }
      assert.equal(white, 3, "a coherent glyph cannot require four near-white samples");
    }
  });
  test(`blank focused-blue button rejects at density ${density}`, () => {
    assert.equal(workspaceButtonPixels(button(density)), null);
  });
  test(`bright border alone is not glyph ink at density ${density}`, () => {
    const image = button(density);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 22; x++) {
      if (x === 0 || x === 21 || y === 0 || y === 31) block(image, x, y, density, WHITE);
    }
    assert.equal(workspaceButtonPixels(image), null);
  });
  test(`unrelated external bar text cannot satisfy blank button at density ${density}`, () => {
    const image = button(density);
    for (let y = 10; y < 24; y++) for (let x = 40; x < 60; x++) {
      if ((x + y) % 3 !== 0) block(image, x, y, density, WHITE);
    }
    assert.equal(workspaceButtonPixels(image), null);
  });
  test(`compact cursor-like speck rejects at density ${density}`, () => {
    const image = button(density);
    for (let y = 14; y < 17; y++) for (let x = 9; x < 11; x++) block(image, x, y, density, WHITE);
    assert.equal(workspaceButtonPixels(image), null);
  });
  test(`28 disconnected samples cannot replace a glyph at density ${density}`, () => {
    const image = button(density); let count = 0;
    for (let y = 4; y <= 25 && count < 28; y += 3) for (let x = 3; x <= 18 && count < 28; x += 3) {
      block(image, x, y, density, WHITE); count++;
    }
    assert.equal(count, 28);
    assert.equal(workspaceButtonPixels(image), null);
  });
  test(`thin scratch cannot replace a glyph at density ${density}`, () => {
    const image = button(density);
    for (let y = 10; y <= 23; y++) block(image, 10, y, density, WHITE);
    assert.equal(workspaceButtonPixels(image), null);
  });
}

test("malformed RGBA input refuses instead of inventing pixels", () => {
  assert.throws(() => workspaceButtonPixels({ width: 2, height: 2, data: new Uint8Array(3) }), /invalid RGBA/);
});
