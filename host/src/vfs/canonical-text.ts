/** Reject JavaScript strings that cannot be represented as Unicode scalars. */
export function assertUnicodeScalarText(
  value: string,
  label = "Canonical text",
): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (
      unit <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      index += 1;
      continue;
    }
    throw new Error(`${label} must contain only Unicode scalar values`);
  }
}

/**
 * Compare strings by Unicode scalar value, matching Python's string order.
 *
 * JavaScript relational operators compare UTF-16 code units, which reverse
 * U+E000 and U+10000. Wire producers use scalar ordering so every host must do
 * the same before accepting or generating canonical metadata.
 */
export function compareUnicodeScalarText(
  left: string,
  right: string,
): number {
  assertUnicodeScalarText(left);
  assertUnicodeScalarText(right);
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftScalar = left.codePointAt(leftOffset)!;
    const rightScalar = right.codePointAt(rightOffset)!;
    if (leftScalar !== rightScalar) return leftScalar < rightScalar ? -1 : 1;
    leftOffset += leftScalar > 0xffff ? 2 : 1;
    rightOffset += rightScalar > 0xffff ? 2 : 1;
  }
  return leftOffset < left.length ? 1 : rightOffset < right.length ? -1 : 0;
}
