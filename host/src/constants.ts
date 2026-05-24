/** WebAssembly page size (64 KiB) */
export const WASM_PAGE_SIZE = 65536;

export { CH_DATA_SIZE, CH_HEADER_SIZE, CH_TOTAL_SIZE } from "./generated/abi";

/** Default max pages for WebAssembly.Memory */
export const DEFAULT_MAX_PAGES = 16384;

/**
 * Pages allocated per thread: 2 for channel (65,608 bytes spills past one
 * 64 KiB page), 1 gap page, 1 for TLS.
 */
export const PAGES_PER_THREAD = 4;

/**
 * Read an unsigned LEB128 starting at `off`.
 * Returns [value, bytesConsumed].
 */
function readULEB128(buf: Uint8Array, off: number): [number, number] {
  let result = 0, shift = 0, pos = off;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos - off];
}

/**
 * Read a signed LEB128 (i32 const init expression). Returns [value, bytesConsumed].
 * Used for `i32.const` immediates in wasm globals. For our purposes, the value
 * is always a positive address < 2^31, but we sign-extend correctly anyway.
 */
function readSLEB128_i32(buf: Uint8Array, off: number): [number, number] {
  let result = 0, shift = 0, pos = off;
  let byte = 0;
  for (;;) {
    byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  // Sign-extend if the sign bit (0x40) of the last byte is set
  if (shift < 32 && (byte & 0x40) !== 0) {
    result |= ~0 << shift;
  }
  return [result, pos - off];
}

/**
 * Read a signed LEB128 (i64 const init expression). Returns [value, bytesConsumed].
 * Returns a bigint to avoid precision loss for wasm64 addresses.
 */
function readSLEB128_i64(buf: Uint8Array, off: number): [bigint, number] {
  let result = 0n, shift = 0n, pos = off;
  let byte = 0;
  for (;;) {
    byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) break;
  }
  if (shift < 64n && (byte & 0x40) !== 0) {
    result |= (~0n) << shift;
  }
  return [result, pos - off];
}

function skipWasmBlockType(buf: Uint8Array, off: number): number {
  const first = buf[off];
  if (
    first === 0x40 || // empty
    first === 0x7f || // i32
    first === 0x7e || // i64
    first === 0x7d || // f32
    first === 0x7c || // f64
    first === 0x7b || // v128
    first === 0x70 || // funcref
    first === 0x6f    // externref
  ) {
    return off + 1;
  }
  const [, bytes] = readSLEB128_i32(buf, off);
  return off + bytes;
}

function skipVectorMemarg(buf: Uint8Array, off: number): number {
  const [, alignBytes] = readULEB128(buf, off);
  off += alignBytes;
  const [, offsetBytes] = readULEB128(buf, off);
  return off + offsetBytes;
}

function skipPrefixedInstructionImmediate(prefix: number, buf: Uint8Array, off: number): number | null {
  const [subop, subopBytes] = readULEB128(buf, off);
  off += subopBytes;

  if (prefix === 0xfc) {
    switch (subop) {
      // saturating conversions
      case 0:
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
      case 7:
        return off;
      case 8: { // memory.init dataidx memidx
        const [, dataBytes] = readULEB128(buf, off);
        off += dataBytes;
        const [, memBytes] = readULEB128(buf, off);
        return off + memBytes;
      }
      case 9: { // data.drop dataidx
        const [, dataBytes] = readULEB128(buf, off);
        return off + dataBytes;
      }
      case 10: { // memory.copy dstmem srcmem
        const [, dstBytes] = readULEB128(buf, off);
        off += dstBytes;
        const [, srcBytes] = readULEB128(buf, off);
        return off + srcBytes;
      }
      case 11: { // memory.fill memidx
        const [, memBytes] = readULEB128(buf, off);
        return off + memBytes;
      }
      case 12: { // table.init elemidx tableidx
        const [, elemBytes] = readULEB128(buf, off);
        off += elemBytes;
        const [, tableBytes] = readULEB128(buf, off);
        return off + tableBytes;
      }
      case 13: { // elem.drop elemidx
        const [, elemBytes] = readULEB128(buf, off);
        return off + elemBytes;
      }
      case 14: { // table.copy dst src
        const [, dstBytes] = readULEB128(buf, off);
        off += dstBytes;
        const [, srcBytes] = readULEB128(buf, off);
        return off + srcBytes;
      }
      case 15:
      case 16:
      case 17: {
        // table.grow/table.size/table.fill tableidx
        const [, tableBytes] = readULEB128(buf, off);
        return off + tableBytes;
      }
      default:
        return null;
    }
  }

  if (prefix === 0xfd) {
    if (subop === 12 || subop === 13) return off + 16; // v128.const
    if (subop >= 21 && subop <= 34) return skipVectorMemarg(buf, off); // vector memory ops
    if (subop === 84) return off + 1; // i8x16.shuffle
    if (subop >= 92 && subop <= 99) return off + 1; // lane extraction/replacement
    if (subop >= 112 && subop <= 123) return off + 1;
    if (subop >= 124 && subop <= 131) return off + 1;
    if (subop >= 156 && subop <= 159) return off + 1;
    return off;
  }

  if (prefix === 0xfe) {
    if (subop === 0 || subop === 1) return skipVectorMemarg(buf, off); // memory.atomic.notify/wait32
    if (subop === 2) return skipVectorMemarg(buf, off); // memory.atomic.wait64
    if (subop === 3) return off; // atomic.fence
    if (subop >= 16 && subop <= 79) return skipVectorMemarg(buf, off);
    return null;
  }

  return null;
}

/**
 * Skip an import-section entry's payload at `pos`, returning the new position.
 * `numFuncImports` and `numGlobalImports` are incremented by reference if the
 * entry is a function or global import respectively (caller passes a holder).
 */
function skipImportEntry(
  src: Uint8Array,
  pos: number,
  counts: { funcImports: number; globalImports: number },
): number {
  // module name
  const [modLen, modLenBytes] = readULEB128(src, pos); pos += modLenBytes + modLen;
  // field name
  const [fieldLen, fieldLenBytes] = readULEB128(src, pos); pos += fieldLenBytes + fieldLen;
  const kind = src[pos++];
  if (kind === 0) {
    // function: type index
    counts.funcImports++;
    const [, n] = readULEB128(src, pos); pos += n;
  } else if (kind === 1) {
    // table: reftype + limits
    pos++; // reftype
    const f = src[pos++];
    const [, n] = readULEB128(src, pos); pos += n;
    if (f & 1) { const [, n2] = readULEB128(src, pos); pos += n2; }
  } else if (kind === 2) {
    // memory: limits
    const f = src[pos++];
    const [, n] = readULEB128(src, pos); pos += n;
    if (f & 1) { const [, n2] = readULEB128(src, pos); pos += n2; }
  } else if (kind === 3) {
    // global: valtype + mutability
    counts.globalImports++;
    pos += 2;
  }
  return pos;
}

/**
 * Read a global's init expression. Returns the address value as bigint
 * (to handle both wasm32 i32 and wasm64 i64 uniformly), or null if the
 * init expression isn't a simple `i32.const`/`i64.const`.
 */
function readGlobalInitAddr(src: Uint8Array, pos: number): bigint | null {
  // valtype + mut + init expr (terminated by 0x0B)
  pos++; // valtype
  pos++; // mut
  const opcode = src[pos++];
  if (opcode === 0x41) {
    // i32.const
    const [val] = readSLEB128_i32(src, pos);
    return BigInt.asUintN(32, BigInt(val));
  } else if (opcode === 0x42) {
    // i64.const
    const [val] = readSLEB128_i64(src, pos);
    return BigInt.asUintN(64, val);
  }
  // Other init expressions (global.get, ref.func, etc.) are not used
  // for __heap_base by current LLD output.
  return null;
}

/**
 * Skip past a global's payload (valtype + mut + init expression). The init
 * expression ends at the first 0x0B (end) opcode.
 */
function skipGlobalEntry(src: Uint8Array, pos: number): number {
  pos += 2; // valtype + mut
  while (src[pos] !== 0x0B) pos++;
  return pos + 1; // skip the end opcode
}

/**
 * Extract the `__heap_base` export's value from a wasm binary by parsing
 * the Import + Export + Global sections. Returns the address (as bigint
 * to handle wasm64), or null if `__heap_base` is not exported or its
 * init expression isn't a plain const.
 *
 * Used by the host to call `kernel_set_brk_base` before a new program's
 * `_start` runs, so `brk(0)` returns a value above the program's data
 * and stack region (avoids heap/shadow-stack overlap for programs with
 * large data sections like mariadbd).
 */
export function extractHeapBase(programBytes: ArrayBuffer): bigint | null {
  const src = new Uint8Array(programBytes);
  if (src.length < 8) return null;

  let globalImports = 0;
  let funcImports = 0;
  let heapBaseGlobalIndex: number | null = null;
  let globalSectionContent: { offset: number; size: number } | null = null;

  let offset = 8; // skip magic + version
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;

    if (sectionId === 2) {
      // Import section — count global imports
      const counts = { funcImports, globalImports };
      let pos = contentOffset;
      const [importCount, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        pos = skipImportEntry(src, pos, counts);
      }
      funcImports = counts.funcImports;
      globalImports = counts.globalImports;
    } else if (sectionId === 6) {
      // Global section — defer until we know the global index
      globalSectionContent = { offset: contentOffset, size: sectionSize };
    } else if (sectionId === 7) {
      // Export section — find __heap_base
      let pos = contentOffset;
      const [exportCount, countBytes] = readULEB128(src, pos); pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readULEB128(src, pos); pos += nameLenBytes;
        const name = new TextDecoder().decode(src.subarray(pos, pos + nameLen)); pos += nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readULEB128(src, pos); pos += idxBytes;
        if (kind === 3 && name === "__heap_base") {
          heapBaseGlobalIndex = idx;
          break;
        }
      }
      if (heapBaseGlobalIndex === null) return null;
      if (globalSectionContent === null) {
        // Sections appear in canonical order, so Global (id=6) comes
        // before Export (id=7). Reaching here means the binary is
        // malformed or the global is imported (not defined locally).
        return null;
      }
      break;
    }

    offset = contentOffset + sectionSize;
  }

  if (heapBaseGlobalIndex === null || globalSectionContent === null) return null;

  // The export's global index counts both imports and defined globals.
  // Defined globals start at index `globalImports`.
  const definedIndex = heapBaseGlobalIndex - globalImports;
  if (definedIndex < 0) return null; // imported global, can't read its init here

  let pos = globalSectionContent.offset;
  const [globalCount, countBytes] = readULEB128(src, pos); pos += countBytes;
  if (definedIndex >= globalCount) return null;

  for (let i = 0; i < definedIndex; i++) {
    pos = skipGlobalEntry(src, pos);
  }
  return readGlobalInitAddr(src, pos);
}

/**
 * Extract the constant value returned by a program's `__abi_version`
 * export, if present. The glue (`libc/glue/channel_syscall.c`) defines this
 * function as a single `i32.const N; end` (often with the standard
 * export-wrapper `call __wasm_call_ctors` prefix). Fork instrumentation can
 * inject its own constants before that return path, so parse the body and only
 * accept an `i32.const` that is returned directly.
 *
 * Used by tests to skip cleanly when cached binaries were built against
 * a different `ABI_VERSION` than the running kernel.
 */
export function extractAbiVersion(programBytes: ArrayBuffer): number | null {
  const src = new Uint8Array(programBytes);
  if (src.length < 8) return null;

  let funcImports = 0;
  let abiFuncIndex: number | null = null;
  let codeSectionContent: { offset: number; size: number } | null = null;

  let offset = 8;
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;

    if (sectionId === 2) {
      const counts = { funcImports, globalImports: 0 };
      let pos = contentOffset;
      const [importCount, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        pos = skipImportEntry(src, pos, counts);
      }
      funcImports = counts.funcImports;
    } else if (sectionId === 7) {
      let pos = contentOffset;
      const [exportCount, countBytes] = readULEB128(src, pos); pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readULEB128(src, pos); pos += nameLenBytes;
        const name = new TextDecoder().decode(src.subarray(pos, pos + nameLen)); pos += nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readULEB128(src, pos); pos += idxBytes;
        if (kind === 0 && name === "__abi_version") {
          abiFuncIndex = idx;
          break;
        }
      }
    } else if (sectionId === 10) {
      codeSectionContent = { offset: contentOffset, size: sectionSize };
    }

    offset = contentOffset + sectionSize;
  }

  if (abiFuncIndex === null || codeSectionContent === null) return null;

  // Code section indexes only defined functions; skip imports.
  const definedIndex = abiFuncIndex - funcImports;
  if (definedIndex < 0) return null;

  let pos = codeSectionContent.offset;
  const [funcCount, funcCountBytes] = readULEB128(src, pos); pos += funcCountBytes;
  if (definedIndex >= funcCount) return null;

  // Skip to the target function body
  for (let i = 0; i < definedIndex; i++) {
    const [bodySize, bodySizeBytes] = readULEB128(src, pos);
    pos += bodySizeBytes + bodySize;
  }
  const [bodySize, bodySizeBytes] = readULEB128(src, pos);
  pos += bodySizeBytes;
  const bodyEnd = pos + bodySize;

  // Skip local declarations (count + count*(num + valtype))
  const [localGroups, localGroupsBytes] = readULEB128(src, pos);
  pos += localGroupsBytes;
  for (let i = 0; i < localGroups; i++) {
    const [, n] = readULEB128(src, pos); pos += n; // count
    pos++; // valtype
  }

  // Walk instructions and find the constant directly returned by this trivial
  // marker export. Instrumentation may insert unrelated constants before it.
  while (pos < bodyEnd) {
    const op = src[pos++];
    if (op === 0x0b) {
      if (pos === bodyEnd) return null;
      continue;
    }
    if (op === 0x41) {
      const [val] = readSLEB128_i32(src, pos);
      const [, n] = readSLEB128_i32(src, pos);
      const next = pos + n;
      if (src[next] === 0x0f || (src[next] === 0x0b && next + 1 === bodyEnd)) {
        return val;
      }
      pos = next;
    } else if (op === 0x10 || op === 0x0c || op === 0x0d || op === 0x12 || op === 0xd2) {
      const [, n] = readULEB128(src, pos);
      pos += n;
    } else if (op === 0x02 || op === 0x03 || op === 0x04) {
      pos = skipWasmBlockType(src, pos);
    } else if (op === 0x0e) {
      const [targetCount, targetCountBytes] = readULEB128(src, pos);
      pos += targetCountBytes;
      for (let i = 0; i <= targetCount; i++) {
        const [, n] = readULEB128(src, pos);
        pos += n;
      }
    } else if (op === 0x11) {
      const [, typeBytes] = readULEB128(src, pos);
      pos += typeBytes;
      const [, tableBytes] = readULEB128(src, pos);
      pos += tableBytes;
    } else if (op === 0x1c) {
      const [typeCount, typeCountBytes] = readULEB128(src, pos);
      pos += typeCountBytes;
      for (let i = 0; i < typeCount; i++) {
        const [, n] = readULEB128(src, pos);
        pos += n;
      }
    } else if ((op >= 0x20 && op <= 0x26) || op === 0xd0) {
      const [, n] = readULEB128(src, pos);
      pos += n;
    } else if (op >= 0x28 && op <= 0x3e) {
      pos = skipVectorMemarg(src, pos);
    } else if (op === 0x3f || op === 0x40) {
      pos++;
    } else if (op === 0x42) {
      const [, n] = readSLEB128_i64(src, pos);
      pos += n;
    } else if (op === 0x43) {
      pos += 4;
    } else if (op === 0x44) {
      pos += 8;
    } else if (op === 0xfc || op === 0xfd || op === 0xfe) {
      const next = skipPrefixedInstructionImmediate(op, src, pos);
      if (next === null) return null;
      pos = next;
    } else {
      // Most scalar numeric/control/parametric instructions have no immediates.
    }
  }
  return null;
}

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
