/**
 * OES_texture_float and OES_texture_half_float define LUMINANCE, ALPHA and
 * LUMINANCE_ALPHA textures of type FLOAT and HALF_FLOAT_OES. WebGL 2 accepts
 * those unsized formats only with UNSIGNED_BYTE (ES 3.0 table 3.3) and has no
 * texture swizzle, so the host stores such a level as RGBA32F or RGBA16F and
 * expands every uploaded texel the way GLES 2 table 3.9 samples it:
 * L -> (L,L,L,1), A -> (0,0,0,A), LA -> (L,L,L,A). Sampling, filtering and
 * mipmap generation of the RGBA stand-in equal those of the logical level.
 *
 * The guest's logical (format, type) and the expansion flag live on the
 * level record in texture-levels.ts. GLES 2 performs no format conversion,
 * so a later TexSubImage2D must name the same format and type, and the level
 * is never color-renderable (section 4.4.5).
 */

const L = 0x1909, A = 0x1906, LA = 0x190a, RGBA = 0x1908;
const FLOAT = 0x1406, HALF_FLOAT = 0x140b;

/** `type` is the WebGL type (HALF_FLOAT_OES already normalized). */
export function expandedFloatFormat(format: number, type: number): boolean {
  return (format === L || format === A || format === LA) && (type === FLOAT || type === HALF_FLOAT);
}

/** Native WebGL 2 triple used for an expanded level. */
export function expandedNative(type: number): { internal: number; format: number } {
  return { internal: type === FLOAT ? 0x8814 /* RGBA32F */ : 0x881a /* RGBA16F */, format: RGBA };
}

/**
 * Expand `rows` rows of `width` logical pixels, read at `stride` bytes per
 * row (the guest's UNPACK_ALIGNMENT stride), into tightly packed RGBA rows.
 * Each output row is a multiple of 8 bytes, so every GLES unpack alignment
 * reads it without padding. Returns null when `bytes` is too short.
 */
export function expandRows(format: number, type: number, bytes: Uint8Array, width: number, rows: number,
                           stride: number): Float32Array | Uint16Array | null {
  const scalar = type === FLOAT ? 4 : 2, channels = format === LA ? 2 : 1;
  if (rows > 0 && width > 0 && bytes.byteLength < (rows - 1) * stride + width * channels * scalar) return null;
  const out = new Uint8Array(width * rows * 4 * scalar);
  const one = type === FLOAT ? [0x00, 0x00, 0x80, 0x3f] : [0x00, 0x3c];
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < width; x++) {
      const s = r * stride + x * channels * scalar, d = (r * width + x) * 4 * scalar;
      if (format === A) {
        out.set(bytes.subarray(s, s + scalar), d + 3 * scalar);
        continue;
      }
      const value = bytes.subarray(s, s + scalar);
      out.set(value, d); out.set(value, d + scalar); out.set(value, d + 2 * scalar);
      if (format === LA) out.set(bytes.subarray(s + scalar, s + 2 * scalar), d + 3 * scalar);
      else out.set(one, d + 3 * scalar);
    }
  }
  return type === FLOAT ? new Float32Array(out.buffer) : new Uint16Array(out.buffer);
}

/** Bytes per logical pixel of an expanded format. */
export function expandedSourceBytes(format: number, type: number): number {
  return (format === LA ? 2 : 1) * (type === FLOAT ? 4 : 2);
}
