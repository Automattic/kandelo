/** A copy of `len` bytes at byte `at` of `v`, in the typed array WebGL2
 *  requires for pixel data of `type` (a `Uint8Array` is accepted only for
 *  byte types). WebGL also refuses views of shared memory, and TLV data can
 *  be unaligned, so the data is always copied. */
export function pixelsAt(v: DataView, at: number, len: number, type: number): ArrayBufferView {
  const Ctor = pixelArrayType(type);
  const n = Math.floor(len / Ctor.BYTES_PER_ELEMENT);
  const out = new Ctor(n);
  new Uint8Array(out.buffer).set(new Uint8Array(v.buffer, v.byteOffset + at, n * Ctor.BYTES_PER_ELEMENT));
  return out;
}

interface PixelArrayType {
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): ArrayBufferView;
  new (length: number): ArrayBufferView;
  readonly BYTES_PER_ELEMENT: number;
}

export function pixelArrayType(type: number): PixelArrayType {
  switch (type) {
    case 0x1400: return Int8Array;                    // GL_BYTE
    case 0x1402: return Int16Array;                   // GL_SHORT
    case 0x1403:                                      // GL_UNSIGNED_SHORT
    case 0x140B:                                      // GL_HALF_FLOAT
    case 0x8D61:                                      // GL_HALF_FLOAT_OES
    case 0x8363:                                      // GL_UNSIGNED_SHORT_5_6_5
    case 0x8033:                                      // GL_UNSIGNED_SHORT_4_4_4_4
    case 0x8034: return Uint16Array;                  // GL_UNSIGNED_SHORT_5_5_5_1
    case 0x1404: return Int32Array;                   // GL_INT
    case 0x1405:                                      // GL_UNSIGNED_INT
    case 0x84FA:                                      // GL_UNSIGNED_INT_24_8
    case 0x8368:                                      // GL_UNSIGNED_INT_2_10_10_10_REV
    case 0x8C3B:                                      // GL_UNSIGNED_INT_10F_11F_11F_REV
    case 0x8C3E: return Uint32Array;                  // GL_UNSIGNED_INT_5_9_9_9_REV
    case 0x1406: return Float32Array;                 // GL_FLOAT
    default: return Uint8Array;
  }
}
