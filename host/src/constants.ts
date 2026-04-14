/** WebAssembly page size (64 KiB) */
export const WASM_PAGE_SIZE = 65536;

/** Channel header size in bytes (6 x i64 args = 48B, i64 return = 8B, i32 errno + pad = 8B) */
export const CH_HEADER_SIZE = 72;

/** Channel data buffer size */
export const CH_DATA_SIZE = 65536;

/** Total channel size: header + data */
export const CH_TOTAL_SIZE = CH_HEADER_SIZE + CH_DATA_SIZE;

/** Default max pages for WebAssembly.Memory */
export const DEFAULT_MAX_PAGES = 16384;

/**
 * Pages allocated per thread: 2 for channel (65,608 bytes spills past one
 * 64 KiB page), 1 gap page, 1 for TLS.
 */
export const PAGES_PER_THREAD = 4;

/**
 * Detect whether a wasm binary is wasm32 or wasm64 by parsing the import
 * section for a memory import with the memory64 flag (bit 2 of flags byte).
 * Returns 4 for wasm32, 8 for wasm64.
 */
export function detectPtrWidth(programBytes: ArrayBuffer): 4 | 8 {
  const src = new Uint8Array(programBytes);
  if (src.length < 8) return 4;

  function readLEB128(buf: Uint8Array, off: number): [number, number] {
    let result = 0, shift = 0, pos = off;
    for (;;) {
      const byte = buf[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return [result, pos - off];
  }

  // Skip magic + version (8 bytes)
  let offset = 8;
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readLEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;

    if (sectionId === 2) {
      // Import section — look for memory imports
      let pos = contentOffset;
      const [importCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        const [modLen, modLenBytes] = readLEB128(src, pos); pos += modLenBytes + modLen;
        const [fieldLen, fieldLenBytes] = readLEB128(src, pos); pos += fieldLenBytes + fieldLen;
        const kind = src[pos++];
        if (kind === 2) {
          // Memory import: flags byte, then limits
          const flags = src[pos];
          if (flags & 0x04) return 8; // memory64 bit set
          return 4;
        }
        // Skip non-memory imports
        if (kind === 0) { const [, n] = readLEB128(src, pos); pos += n; }
        else if (kind === 1) {
          pos++; // ref type
          const f = src[pos++];
          const [, n] = readLEB128(src, pos); pos += n;
          if (f & 1) { const [, n2] = readLEB128(src, pos); pos += n2; }
        }
        else if (kind === 3) { pos += 2; } // global: type + mutability
      }
      break;
    }

    offset = contentOffset + sectionSize;
  }

  return 4; // default wasm32
}
