const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const intrinsicMathMin = Math.min;

/**
 * Resolve the complete append window before an OPFS access handle can write.
 *
 * `null` means even the largest valid result is not exactly representable by
 * the number-only OPFS API. The caller must reject it before mutation.
 */
export function opfsAppendWritableLength(
  writeAt: number,
  length: number,
  limit: number | null,
): number | null {
  if (
    !intrinsicNumberIsSafeInteger(writeAt)
    || writeAt < 0
    || !intrinsicNumberIsSafeInteger(length)
    || length < 0
  ) {
    return null;
  }
  const writableLength = limit === null || writeAt < limit
    ? limit === null ? length : intrinsicMathMin(length, limit - writeAt)
    : 0;
  return intrinsicNumberIsSafeInteger(writeAt + writableLength)
    ? writableLength
    : null;
}
