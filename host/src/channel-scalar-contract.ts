import {
  CHANNEL_RESULT_CONTRACTS,
  CHANNEL_RESULT_DEFAULT_KIND,
  CHANNEL_SCALAR_DEFAULT_SLOT_KIND,
  CHANNEL_SCALAR_SLOT_CONTRACTS,
  type ChannelArgumentIndex,
  type ChannelResultKind,
  type ChannelScalarSlotKind,
} from "./generated/abi";

export {
  CHANNEL_RESULT_CONTRACTS,
  CHANNEL_SCALAR_SLOT_CONTRACTS,
};
export type {
  ChannelResultKind,
  ChannelScalarSlotKind,
};
export type ChannelScalarValue = number | bigint;
export type ChannelScalarTuple = [
  ChannelScalarValue,
  ChannelScalarValue,
  ChannelScalarValue,
  ChannelScalarValue,
  ChannelScalarValue,
  ChannelScalarValue,
];

/**
 * Remove only the canonical extension that carried a guest-width unsigned
 * value through the physical i64 channel slot.
 *
 * wasm32 libc may zero-extend typed arguments or sign-extend values that pass
 * through `long`. Both encodings preserve the same low u32. Any other high
 * word would be a lossy alias and is rejected.
 */
export function canonicalGuestUnsignedScalar(
  raw: bigint,
  pointerWidth: 4 | 8,
  field: string,
): bigint {
  const physical = BigInt.asUintN(64, raw);
  if (pointerWidth === 8) return physical;
  if (pointerWidth !== 4) {
    throw new RangeError(`${field} has an unsupported guest width`);
  }
  const low = BigInt.asUintN(32, physical);
  const signExtended = BigInt.asUintN(64, BigInt.asIntN(32, low));
  if (physical !== low && physical !== signExtended) {
    throw new RangeError(`${field} is not canonically extended from wasm32`);
  }
  return low;
}

/**
 * Scalar channel-word interpretation for values whose Rust consumers do not
 * use the dispatcher's default signed-i32 view.
 *
 * WHY: every channel word is physically i64. Converting all six words to
 * JavaScript Number before interpreting the syscall loses integer bits above
 * 2^53, while delaying i32/u32 normalization can discard a significant low
 * word after that rounding. Generated process-address slots preserve their
 * complete physical bits here; kernel-worker then validates those bits against
 * the active guest width before any descriptor replaces a process pointer with
 * a capacity-checked kernel address.
 */

export function normalizeChannelScalar(
  raw: bigint,
  kind: ChannelScalarSlotKind | undefined,
): ChannelScalarValue {
  switch (kind) {
    case "i32":
      return Number(BigInt.asIntN(32, raw));
    case "u32":
      return Number(BigInt.asUintN(32, raw));
    case "exact-u32":
      return BigInt.asUintN(64, raw);
    case "process-size":
      // WHY: getBigInt64 exposes a wasm64 size_t with bit 63 set as negative.
      // Preserve all physical channel bits; the typed Rust consumer rejects
      // values that do not fit the active kernel/guest pointer width.
      return BigInt.asUintN(64, raw);
    case "process-address":
      return BigInt.asUintN(64, raw);
    case "split-i64-low-u32":
      return Number(BigInt.asUintN(32, raw));
    case "split-i64-high-i32":
      return Number(BigInt.asIntN(32, raw));
    case "i64":
      return raw;
    default:
      return Number(BigInt.asIntN(32, raw));
  }
}

/**
 * Initialize the values that will be written to kernel scratch.
 *
 * The returned array owns only primitive values. No process or kernel pointer
 * authority is retained here; pointer descriptors replace their slots later.
 */
export function normalizeChannelScalarArguments(
  syscallNr: number,
  rawArgs: readonly bigint[],
): ChannelScalarValue[] {
  const contract = CHANNEL_SCALAR_SLOT_CONTRACTS[syscallNr];
  return rawArgs.map((raw, index) =>
    normalizeChannelScalar(
      raw,
      contract?.[index as ChannelArgumentIndex]
        ?? CHANNEL_SCALAR_DEFAULT_SLOT_KIND,
    )
  );
}

export function channelDiagnosticArguments(
  controlArgs: readonly number[],
  normalizedArgs: readonly ChannelScalarValue[],
): ChannelScalarTuple {
  if (controlArgs.length !== 6 || normalizedArgs.length !== 6) {
    throw new RangeError("channel diagnostics require exactly six arguments");
  }
  return controlArgs.map((value, index) =>
    typeof normalizedArgs[index] === "bigint"
      ? normalizedArgs[index]
      : value
  ) as ChannelScalarTuple;
}

export function channelResultKind(syscallNr: number): ChannelResultKind {
  return CHANNEL_RESULT_CONTRACTS[syscallNr]
    ?? CHANNEL_RESULT_DEFAULT_KIND;
}

export function checkedChannelScalarNumber(
  value: ChannelScalarValue,
  field: string,
): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${field} is not a safe integer`);
    }
    return value;
  }
  const narrowed = Number(value);
  if (!Number.isSafeInteger(narrowed) || BigInt(narrowed) !== value) {
    throw new RangeError(`${field} cannot be represented exactly`);
  }
  return narrowed;
}
