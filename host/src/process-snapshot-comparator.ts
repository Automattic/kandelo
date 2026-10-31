import { SNAPSHOT_COMPARATOR_BYTES } from "./generated/process-snapshot-comparator-bytes";

// Only compiled Modules and immutable scalar metadata are retained here.
// Instances/functions and kernel/process Memory references never enter caches.
const intrinsicApply = Reflect.apply;
const IntrinsicModule = WebAssembly.Module;
const intrinsicValidate = WebAssembly.validate;
const wasmNamespace = WebAssembly;
const IntrinsicUint8Array = Uint8Array;
const IntrinsicTypeError = TypeError;
const intrinsicFreeze = Object.freeze;
const intrinsicDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicIsFrozen = Object.isFrozen;
const intrinsicIsArray = Array.isArray;
const intrinsicIsSafeInteger = Number.isSafeInteger;
const intrinsicIsInteger = Number.isInteger;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapSet = WeakMap.prototype.set;
const intrinsicWeakSetHas = WeakSet.prototype.has;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicMapGet = Map.prototype.get;
const intrinsicMapSet = Map.prototype.set;
const intrinsicMemoryBuffer = Object.getOwnPropertyDescriptor(
  WebAssembly.Memory.prototype, "buffer",
)!.get!;
const intrinsicArrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "byteLength",
)!.get!;
const intrinsicSharedBufferByteLength = typeof SharedArrayBuffer === "undefined"
  ? null
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get!;

export interface ComparisonMemoryShape {
  readonly addressWidth: 4 | 8;
  readonly shared: boolean;
  readonly maximumPages: number;
}

const memoryShapes = new WeakMap<WebAssembly.Memory, ComparisonMemoryShape>();
const admittedShapes = new WeakSet<ComparisonMemoryShape>();
// Exactly 32 possible keys. Neither these keys nor compiled modules name a
// particular Memory or instance, so exited process generations are not owned.
const modules = new Map<string, WebAssembly.Module | null>();

function currentBufferShape(memory: WebAssembly.Memory): { shared: boolean; byteLength: number } {
  // The captured native getter authenticates Memory; no public .buffer getter
  // or instanceof/prototype assertion stands in for that brand check.
  const buffer = intrinsicApply(intrinsicMemoryBuffer, memory, []) as ArrayBufferLike;
  try {
    const byteLength = intrinsicApply(intrinsicArrayBufferByteLength, buffer, []) as number;
    return { shared: false, byteLength };
  } catch {
    if (intrinsicSharedBufferByteLength === null)
      throw new IntrinsicTypeError("Comparison Memory has no authenticated buffer shape");
    const byteLength = intrinsicApply(intrinsicSharedBufferByteLength, buffer, []) as number;
    return { shared: true, byteLength };
  }
}

/** Trusted constructor/admission grant, never descriptor inference.
 * Call only with the actual self-contained Memory constructor's arguments.
 * A generic externally injected factory's request is not proof of its output.
 * Unknown descriptor metadata deliberately retains the owned-copy fallback. */
export function recordComparisonMemoryShape(
  memory: WebAssembly.Memory,
  addressWidth: 4 | 8,
  shared: boolean,
  maximumPages: number,
): void {
  const actual = currentBufferShape(memory);
  if ((addressWidth !== 4 && addressWidth !== 8) || typeof shared !== "boolean"
      || !intrinsicIsSafeInteger(maximumPages) || maximumPages < 0
      || shared !== actual.shared || actual.byteLength / 65536 > maximumPages)
    throw new IntrinsicTypeError("Invalid actual comparison Memory descriptor metadata");
  const existing = intrinsicApply(intrinsicWeakMapGet, memoryShapes, [memory]) as ComparisonMemoryShape | undefined;
  if (existing) {
    if (existing.addressWidth !== addressWidth || existing.shared !== shared || existing.maximumPages !== maximumPages)
      throw new IntrinsicTypeError("Comparison Memory descriptor metadata cannot change");
    return;
  }
  const shape = intrinsicFreeze({ addressWidth, shared, maximumPages });
  intrinsicApply(intrinsicWeakMapSet, memoryShapes, [memory, shape]);
  intrinsicApply(intrinsicWeakSetAdd, admittedShapes, [shape]);
}

/** Returns only the frozen scalar record, never Memory or its buffer. */
export function lookupComparisonMemoryShape(memory: WebAssembly.Memory): ComparisonMemoryShape | undefined {
  return intrinsicApply(intrinsicWeakMapGet, memoryShapes, [memory]) as ComparisonMemoryShape | undefined;
}

function eligible(shape: ComparisonMemoryShape | undefined): shape is ComparisonMemoryShape {
  // Check provenance before touching properties, so a caller-supplied object
  // cannot run getters while the kernel holds a synchronous read borrow.
  if (shape === undefined || !intrinsicApply(intrinsicWeakSetHas, admittedShapes, [shape])) return false;
  return shape.maximumPages <= 65536;
}

function moduleForKey(key: string): WebAssembly.Module | undefined {
  const cached = intrinsicApply(intrinsicMapGet, modules, [key]) as WebAssembly.Module | null | undefined;
  if (cached !== undefined) return cached ?? undefined;
  const item = intrinsicDescriptor(SNAPSHOT_COMPARATOR_BYTES, key);
  if (!item || !("value" in item)) throw new IntrinsicTypeError("Missing generated comparator variant");
  const dense = item.value as readonly number[];
  if (!intrinsicIsArray(dense) || !intrinsicIsFrozen(dense))
    throw new IntrinsicTypeError("Comparator bytes must be an owned frozen dense array");
  const length = intrinsicDescriptor(dense, "length")!.value as number;
  if (!intrinsicIsSafeInteger(length) || length < 1 || length > 4096)
    throw new IntrinsicTypeError("Generated comparator size is invalid");
  const bytes = new IntrinsicUint8Array(length);
  // Do not consult Array's iterator, species or overridable copy methods.
  for (let i = 0; i < length; i++) {
    const element = intrinsicDescriptor(dense, i);
    if (!element || !("value" in element) || !intrinsicIsInteger(element.value)
        || element.value < 0 || element.value > 255)
      throw new IntrinsicTypeError("Generated comparator bytes are not dense u8 values");
    bytes[i] = element.value;
  }
  if (!intrinsicApply(intrinsicValidate, wasmNamespace, [bytes])) {
    intrinsicApply(intrinsicMapSet, modules, [key, null]);
    return undefined;
  }
  // A constructor failure after successful validation is not silently
  // reclassified as unavailable. The kernel owner retains truthful failures.
  const module = new IntrinsicModule(bytes);
  intrinsicApply(intrinsicMapSet, modules, [key, module]);
  return module;
}

/** A compiled read-only helper, or explicit unavailable optimization.
 * Accepts only records produced by lookupComparisonMemoryShape. Modules are
 * fixed by the shape pair; actual instance construction/invocation belongs
 * to the kernel's validated private borrow and may never be cached here. */
export function getSnapshotComparatorModule(
  kernelShape: ComparisonMemoryShape | undefined,
  processShape: ComparisonMemoryShape | undefined,
): WebAssembly.Module | undefined {
  if (!eligible(kernelShape) || !eligible(processShape)) return undefined;
  const pair = `k${kernelShape.addressWidth * 8}${kernelShape.shared ? "s" : "u"}-p${processShape.addressWidth * 8}${processShape.shared ? "s" : "u"}`;
  return moduleForKey(pair + "-simd") ?? moduleForKey(pair + "-scalar");
}
