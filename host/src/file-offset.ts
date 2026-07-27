import type { HostFileOffset } from "./types";

// WHY: PlatformIO implementations are host callbacks. Capture the numeric
// operations used to validate their results before any callback can replace a
// writable global and make an inexact offset appear safe.
const intrinsicBigInt = BigInt;
const intrinsicNumber = Number;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;
const MIN_SAFE_INTEGER = intrinsicBigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER = intrinsicBigInt(Number.MAX_SAFE_INTEGER);

function offsetError(
  code: "EINVAL" | "EOVERFLOW",
  message: string,
): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function exactI64(value: HostFileOffset): bigint {
  if (typeof value === "number") {
    if (!intrinsicNumberIsSafeInteger(value)) {
      throw offsetError(
        "EOVERFLOW",
        "file offset is not exactly representable",
      );
    }
    return intrinsicBigInt(value);
  }
  if (value < MIN_I64 || value > MAX_I64) {
    throw offsetError("EOVERFLOW", "file offset is outside signed i64");
  }
  return value;
}

/** Validate a host-visible signed i64 file offset without narrowing it. */
export function checkedHostFileOffset(
  value: HostFileOffset,
): HostFileOffset {
  exactI64(value);
  return value;
}

/** Validate a positioned-I/O offset, which must name a non-negative byte. */
export function checkedHostFilePosition(
  value: HostFileOffset,
): HostFileOffset {
  const exact = exactI64(value);
  if (exact < 0n) {
    throw offsetError("EINVAL", "negative positioned I/O offset");
  }
  return value;
}

/**
 * Node's synchronous read API supports bigint positions but rejects the
 * signed-i64 maximum even though the native pread operation can address it.
 */
export function hostFilePositionForNodeRead(
  value: HostFileOffset,
  length: number,
): HostFileOffset {
  const checked = checkedHostFilePosition(value);
  if (
    length > 0
    && typeof checked === "bigint"
    && checked === MAX_I64
  ) {
    throw offsetError(
      "EOVERFLOW",
      "Node read API cannot represent the file offset",
    );
  }
  return checked;
}

/**
 * Narrow an offset only for a backend API whose position contract is a
 * JavaScript safe integer.
 */
export function hostFileOffsetToSafeNumber(
  value: HostFileOffset,
): number {
  const exact = exactI64(value);
  if (exact < MIN_SAFE_INTEGER || exact > MAX_SAFE_INTEGER) {
    throw offsetError(
      "EOVERFLOW",
      "backend cannot represent the file offset exactly",
    );
  }
  return intrinsicNumber(exact);
}

/** Narrow a non-negative positioned-I/O offset for a number-only backend. */
export function hostFilePositionToSafeNumber(
  value: HostFileOffset,
): number {
  const checked = checkedHostFilePosition(value);
  return hostFileOffsetToSafeNumber(checked);
}

/**
 * Adapt an optional file-size ceiling for a backend whose complete position
 * domain is the JavaScript safe-integer range.
 *
 * A larger positive ceiling is indistinguishable from no ceiling to such a
 * backend. Negative and otherwise invalid values remain errors.
 */
export function hostFileLimitForNumberBackend(
  value: HostFileOffset | null,
): number | null {
  if (value === null) return null;
  const exact = exactI64(value);
  if (exact < 0n) {
    throw offsetError("EINVAL", "negative file-size limit");
  }
  return exact > MAX_SAFE_INTEGER ? null : intrinsicNumber(exact);
}

/**
 * Add a seek delta without losing precision. Existing number-only callers
 * keep their prior overflow behavior; a bigint operand opts into exact i64
 * arithmetic and a bigint result.
 */
export function checkedSeekPosition(
  base: HostFileOffset,
  offset: HostFileOffset,
): HostFileOffset {
  const exactBase = exactI64(base);
  const exactOffset = exactI64(offset);
  const position = exactBase + exactOffset;
  if (position < 0n) {
    throw offsetError("EINVAL", "negative seek offset");
  }
  if (position > MAX_I64) {
    throw offsetError("EOVERFLOW", "seek result is outside signed i64");
  }
  if (typeof base === "number" && typeof offset === "number") {
    if (position > MAX_SAFE_INTEGER) {
      throw offsetError(
        "EOVERFLOW",
        "seek result is not exactly representable",
      );
    }
    return intrinsicNumber(position);
  }
  return position;
}

/** Advance a stored position, widening to bigint when a read crosses 2^53. */
export function advanceHostFilePosition(
  position: HostFileOffset,
  bytes: number,
): HostFileOffset {
  const exactPosition = exactI64(position);
  if (!intrinsicNumberIsSafeInteger(bytes) || bytes < 0) {
    throw offsetError("EOVERFLOW", "I/O byte count is not exactly representable");
  }
  const result = exactPosition + intrinsicBigInt(bytes);
  if (result > MAX_I64) {
    throw offsetError("EOVERFLOW", "file position is outside signed i64");
  }
  if (typeof position === "number" && result <= MAX_SAFE_INTEGER) {
    return intrinsicNumber(result);
  }
  return result;
}

/** Keep ordinary native file sizes numeric while preserving large exact sizes. */
export function hostFileOffsetFromBigInt(value: bigint): HostFileOffset {
  exactI64(value);
  if (value >= MIN_SAFE_INTEGER && value <= MAX_SAFE_INTEGER) {
    return intrinsicNumber(value);
  }
  return value;
}
