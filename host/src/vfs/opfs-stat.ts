import type { StatResult } from "../types";

const IDENTITY_FIELD_COUNT = 2;
const NUMERIC_FIELD_COUNT = 8;
const U64_MAX = (1n << 64n) - 1n;

function exactU64(value: number | bigint, field: string): bigint {
  const exact = typeof value === "bigint"
    ? value
    : Number.isSafeInteger(value)
      ? BigInt(value)
      : null;
  if (exact === null || exact < 0n || exact > U64_MAX) {
    throw new RangeError(`${field} is not an exact unsigned 64-bit value`);
  }
  return exact;
}

/** Serialize OPFS stat data without routing dev/ino through float64. */
export function writeOpfsStatResult(
  buffer: SharedArrayBuffer,
  offset: number,
  stat: StatResult,
): void {
  const identity = new BigUint64Array(
    buffer,
    offset,
    IDENTITY_FIELD_COUNT,
  );
  identity[0] = exactU64(stat.dev, "st_dev");
  identity[1] = exactU64(stat.ino, "st_ino");

  const numeric = new Float64Array(
    buffer,
    offset + IDENTITY_FIELD_COUNT * BigUint64Array.BYTES_PER_ELEMENT,
    NUMERIC_FIELD_COUNT,
  );
  numeric[0] = stat.mode;
  numeric[1] = stat.nlink;
  numeric[2] = stat.uid;
  numeric[3] = stat.gid;
  numeric[4] = stat.size;
  numeric[5] = stat.atimeMs;
  numeric[6] = stat.mtimeMs;
  numeric[7] = stat.ctimeMs;
}

/** Deserialize the exact OPFS stat identity and numeric metadata. */
export function readOpfsStatResult(
  buffer: SharedArrayBuffer,
  offset: number,
): StatResult {
  const identity = new BigUint64Array(
    buffer,
    offset,
    IDENTITY_FIELD_COUNT,
  );
  const numeric = new Float64Array(
    buffer,
    offset + IDENTITY_FIELD_COUNT * BigUint64Array.BYTES_PER_ELEMENT,
    NUMERIC_FIELD_COUNT,
  );
  return {
    dev: identity[0],
    ino: identity[1],
    mode: numeric[0],
    nlink: numeric[1],
    uid: numeric[2],
    gid: numeric[3],
    size: numeric[4],
    atimeMs: numeric[5],
    mtimeMs: numeric[6],
    ctimeMs: numeric[7],
  };
}
