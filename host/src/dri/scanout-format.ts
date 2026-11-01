/** Linux DRM fourcc describes byte order in little-endian buffer memory.
 * Both presenters consume the same bounded snapshot; a 2D canvas needs RGBA,
 * while WebGL can decode RGB565 and swap BGR in its shader. */
export interface ScanoutGeometry {
  width: number;
  height: number;
  pitch: number;
  pixel_format: number;
}
export interface ScanoutFormat {
  bytesPerPixel: 1 | 2 | 4;
  /** DRM XRGB/ARGB8888 bytes are B,G,R,A: the presenter swaps red and blue. */
  bgr: boolean;
  /** RGB565 words, which expand to 8 bits per channel by bit replication. */
  rgb565: boolean;
  /** The WebGL texture the scanout presenter uploads the bytes to. */
  gl: { internalFormat: number; format: number; type: number };
}

const RGBA8_UPLOAD = { internalFormat: 0x8058, format: 0x1908, type: 0x1401 };

export function scanoutFormat(fourcc: number): ScanoutFormat {
  switch (fourcc) {
    case 0x34325258: // XRGB8888: B,G,R,X
    case 0x34325241: // ARGB8888: B,G,R,A
      return { bytesPerPixel: 4, bgr: true, rgb565: false, gl: RGBA8_UPLOAD };
    case 0x34324258: // XBGR8888: R,G,B,X
    case 0x34324241: // ABGR8888: R,G,B,A
      return { bytesPerPixel: 4, bgr: false, rgb565: false, gl: RGBA8_UPLOAD };
    case 0x36314752: // RGB565, little-endian packed words
      return { bytesPerPixel: 2, bgr: false, rgb565: true, gl: { internalFormat: 0x8d62, format: 0x1907, type: 0x8363 } };
    case 0x20203852: // R8: red only; green and blue are zero
      return { bytesPerPixel: 1, bgr: false, rgb565: false, gl: { internalFormat: 0x8229, format: 0x1903, type: 0x1401 } };
    case 0x38385247: // GR88: R then G; blue is zero
      return { bytesPerPixel: 2, bgr: false, rgb565: false, gl: { internalFormat: 0x822b, format: 0x8227, type: 0x1401 } };
    default:
      throw new RangeError(`Unsupported KMS scanout format ${fourcc}`);
  }
}

/** Copy only complete visible rows while the kernel entry owns the source.
 * Padding is not a pixel, and no view into guest memory may reach a presenter. */
export function snapshotScanout(fb: ScanoutGeometry, source: Uint8Array): Uint8Array<ArrayBuffer> {
  const { bytesPerPixel } = scanoutFormat(fb.pixel_format);
  const { width, height, pitch } = fb;
  const rowBytes = width * bytesPerPixel;
  const length = rowBytes * height;
  const sourceLength = pitch * (height - 1) + rowBytes;
  if (![width, height, pitch, rowBytes, length, sourceLength].every(Number.isSafeInteger)
      || width <= 0 || height <= 0 || pitch < rowBytes || sourceLength > source.byteLength) {
    throw new RangeError(`Invalid KMS scanout geometry ${width}x${height} pitch=${pitch}`);
  }
  const packed = new Uint8Array(length);
  for (let y = 0; y < height; y++) {
    packed.set(source.subarray(y * pitch, y * pitch + rowBytes), y * rowBytes);
  }
  return packed;
}

/** Legacy primary scanout is opaque; alpha belongs to the separate cursor.
 * RGB565 expands each endpoint exactly to the corresponding 8-bit endpoint;
 * R8 and GR88 show their channels with the channels they lack zero. */
export function scanoutRgba(fourcc: number, packed: Uint8Array): Uint8Array<ArrayBuffer> {
  const { bytesPerPixel, bgr, rgb565 } = scanoutFormat(fourcc);
  if (packed.byteLength % bytesPerPixel) throw new RangeError("Incomplete KMS scanout pixel");
  const rgba = new Uint8Array(packed.byteLength / bytesPerPixel * 4);
  for (let source = 0, target = 0; source < packed.byteLength; source += bytesPerPixel, target += 4) {
    if (bytesPerPixel === 1) {
      rgba[target] = packed[source];
    } else if (!rgb565 && bytesPerPixel === 2) {
      rgba[target] = packed[source];
      rgba[target + 1] = packed[source + 1];
    } else if (rgb565) {
      const word = packed[source] | (packed[source + 1] << 8);
      const r = word >>> 11, g = (word >>> 5) & 63, b = word & 31;
      rgba[target] = (r << 3) | (r >>> 2);
      rgba[target + 1] = (g << 2) | (g >>> 4);
      rgba[target + 2] = (b << 3) | (b >>> 2);
    } else {
      rgba[target] = packed[source + (bgr ? 2 : 0)];
      rgba[target + 1] = packed[source + 1];
      rgba[target + 2] = packed[source + (bgr ? 0 : 2)];
    }
    rgba[target + 3] = 255;
  }
  return rgba;
}
