const MIN_SAFE_I64 = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_I64 = BigInt(Number.MAX_SAFE_INTEGER);

/** Split an exactly representable JavaScript integer into signed i64 words. */
export function splitSafeI64(value: number): [low: number, high: number] {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("i64 value is not exactly representable");
  }

  const wide = BigInt(value);
  return [
    Number(BigInt.asIntN(32, wide)),
    Number(BigInt.asIntN(32, wide >> 32n)),
  ];
}

/** Join signed i64 words when the result is exactly representable in JavaScript. */
export function joinSafeI64(low: number, high: number): number {
  const wide = (BigInt(high) << 32n) | BigInt(low >>> 0);
  if (wide < MIN_SAFE_I64 || wide > MAX_SAFE_I64) {
    throw new RangeError("i64 value is not exactly representable");
  }
  return Number(wide);
}
