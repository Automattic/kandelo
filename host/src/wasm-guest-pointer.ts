export type WasmGuestPointer = number | bigint;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SIGNED_WASM32 = -0x8000_0000;
const MAX_UNSIGNED_WASM32 = 0xffff_ffff;
const MIN_SIGNED_WASM64 = -(1n << 63n);
const MAX_UNSIGNED_WASM64 = (1n << 64n) - 1n;

/**
 * Convert the JavaScript representation of a guest pointer-sized value into
 * the exact non-negative offset used by host memory APIs.
 *
 * WHY: WebAssembly exposes i32 imports as signed JavaScript numbers, so an
 * ordinary memory32 pointer with its high bit set arrives as a negative value.
 * Reinterpreting its bits as unsigned restores the address the guest supplied.
 * Memory64 i64 values must remain BigInt; accepting Number there would silently
 * permit precision loss before this boundary can validate it.
 */
export function checkedWasmGuestPointerOffset(
  value: WasmGuestPointer,
  ptrWidth: 4 | 8,
  context: string,
): number {
  let unsigned: bigint;
  if (ptrWidth === 4) {
    if (
      typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value < MIN_SIGNED_WASM32
      || value > MAX_UNSIGNED_WASM32
    ) {
      throw new TypeError(`${context}: expected an exact memory32 pointer`);
    }
    unsigned = BigInt(value >>> 0);
  } else {
    if (
      typeof value !== "bigint"
      || value < MIN_SIGNED_WASM64
      || value > MAX_UNSIGNED_WASM64
    ) {
      throw new TypeError(`${context}: expected an exact memory64 pointer`);
    }
    unsigned = BigInt.asUintN(64, value);
  }

  if (unsigned > MAX_SAFE_BIGINT) {
    throw new RangeError(`${context}: pointer exceeds JavaScript's exact address range`);
  }
  return Number(unsigned);
}
