/** Test-only, pure RGBA oracle; coordinates are image pixels. */
export interface WorkspaceButtonImage { width: number; height: number; data: ArrayLike<number>; }
export function workspaceButtonPixels({ width, height, data }: WorkspaceButtonImage) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height * 4)
      || data.length !== width * height * 4) throw new Error("invalid RGBA image");
  const blue = [40, 85, 119];
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    if (blue.every((value, channel) => Math.abs(data[at + channel] - value) <= 2)) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right - left < 8 || bottom - top < 8) return null;
  const buttonWidth = right - left + 1, buttonHeight = bottom - top + 1;
  // A configured frame is not glyph ink. Scale its exclusion with the
  // measured button, so a density increase does not turn the border into ink.
  const inset = Math.max(1, Math.floor(buttonHeight / 30));
  const x0 = left + inset, x1 = right - inset, y0 = top + inset, y1 = bottom - inset;
  const mask = new Uint8Array(width * height);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const at = (y * width + x) * 4;
    // Byte-space brightness is an explicit contrast discriminator, not
    // physical luminance. Antialiased colored edges need not be near-white.
    const contrast = (2126 * (data[at] - blue[0]) + 7152 * (data[at + 1] - blue[1])
      + 722 * (data[at + 2] - blue[2])) / 10000;
    if (contrast >= 40) mask[y * width + x] = 1;
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const first = y * width + x;
    if (!mask[first]) continue;
    mask[first] = 0;
    const pending = [first];
    let area = 0, gx0 = x, gx1 = x, gy0 = y, gy1 = y;
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const at = pending[cursor], px = at % width, py = Math.floor(at / width);
      area++; gx0 = Math.min(gx0, px); gx1 = Math.max(gx1, px);
      gy0 = Math.min(gy0, py); gy1 = Math.max(gy1, py);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const next = ny * width + nx;
        if (mask[next]) { mask[next] = 0; pending.push(next); }
      }
    }
    const gw = gx1 - gx0 + 1, gh = gy1 - gy0 + 1;
    // Real text forms a coherent interior stroke. Counting bright pixels
    // alone also accepts a cursor speck, disconnected noise or a border.
    if (gx0 > x0 && gx1 < x1 && gy0 > y0 && gy1 < y1
        && gh >= buttonHeight * .25 && gw >= buttonWidth * .10
        && gw <= buttonWidth * .80 && area >= buttonWidth * buttonHeight * .02) {
      return { x: left, y: top, width: buttonWidth, height: buttonHeight,
        glyph: { x: gx0, y: gy0, width: gw, height: gh, area } };
    }
  }
  return null;
}
