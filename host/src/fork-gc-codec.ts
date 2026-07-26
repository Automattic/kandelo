import {
  WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE,
  WPK_FORK_GC_CODEC_HEADER_SIZE,
  WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE,
  WPK_FORK_GC_CODEC_MAGIC,
  WPK_FORK_GC_CODEC_SECTION,
  WPK_FORK_GC_CODEC_VERSION,
  WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE,
  WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT,
  WPK_FORK_REFERENCE_EXPORT_GC_FILL,
  WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF,
  WPK_FORK_REFERENCE_EXPORT_GC_PROBE,
} from "./generated/abi";

export const enum ForkGcLayoutKind {
  Struct = 1,
  Array = 2,
}

export const enum ForkGcConstructorKind {
  Struct = 0,
  ArrayGeneric = 1,
  ArrayNew = 2,
  ArrayDefault = 3,
  ArrayFixed = 4,
  ArrayData = 5,
  ArrayElement = 6,
}

export const FORK_GC_LAYOUT_REQUIRES_PROVENANCE = 1 << 0;
export const FORK_GC_LAYOUT_DEFAULTABLE_SHELL = 1 << 1;
const FORK_GC_LAYOUT_KNOWN_FLAGS =
  FORK_GC_LAYOUT_REQUIRES_PROVENANCE
  | FORK_GC_LAYOUT_DEFAULTABLE_SHELL;

export const FORK_GC_FIELD_MUTABLE = 1 << 0;
export const FORK_GC_FIELD_NULLABLE = 1 << 1;
export const FORK_GC_FIELD_REFERENCE = 1 << 2;
export const FORK_GC_FIELD_ALLOCATION_DEPENDENCY = 1 << 3;
const FORK_GC_FIELD_KNOWN_FLAGS =
  FORK_GC_FIELD_MUTABLE
  | FORK_GC_FIELD_NULLABLE
  | FORK_GC_FIELD_REFERENCE
  | FORK_GC_FIELD_ALLOCATION_DEPENDENCY;

const NO_ORDINAL = 0xffff_ffff;
const MAX_RECIPE_ID = 0x7fff_fffe;

export interface ForkGcFieldDescriptor {
  readonly storage: number;
  readonly flags: number;
  readonly scalarOffset: number | null;
  readonly referenceOrdinal: number | null;
}

export interface ForkGcLayoutDescriptor {
  readonly id: number;
  readonly typeOrdinal: number;
  readonly kind: ForkGcLayoutKind;
  readonly constructor: ForkGcConstructorKind;
  readonly flags: number;
  readonly scalarLengthOrStride: number;
  readonly fields: readonly ForkGcFieldDescriptor[];
  readonly superTypeOrdinal: number | null;
  readonly baseLayoutId: number;
  readonly auxiliary: number;
  readonly provenanceScalarLength: number;
  readonly provenanceReferenceCount: number;
}

export interface ForkGcCodecProvider {
  readonly activationId: number;
  readonly descriptor: ForkGcCodecDescriptor;
  /** Probe the object in a shared transit slot without crossing `anyref`. */
  probe(slot: number): bigint;
  /** Encode the object in a shared transit slot into the active recipe graph. */
  encodeSlot(slot: number): number;
  /** Allocate one routed aggregate/i31 recipe into `recipe + 1`. */
  allocate(recipeId: number): void;
  /** Restore mutable aggregate fields after every shell has been allocated. */
  fill(recipeId: number): void;
  /**
   * Convert one process-owned token inside Wasm and publish it at recipe+1.
   *
   * JavaScript cannot directly create an anyref value for the shared transit
   * table, so this remains an activation-local scalar/externref entry point.
   */
  publishExternref(recipeId: number, value: unknown): void;
}

function assertU31(value: number, context: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 0x7fff_ffff) {
    throw new Error(`${context} is not a nonzero u31`);
  }
}

function assertU32(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${context} is not a u32`);
  }
}

function checkedProduct(left: number, right: number, context: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result > 0xffff_ffff) {
    throw new Error(`${context} exceeds the u32 format`);
  }
  return result;
}

function storageByteLength(storage: number): number {
  switch (storage) {
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
    case 5:
      return 4;
    case 4:
    case 6:
      return 8;
    case 7:
      return 16;
    case 8:
      return 4;
    default:
      throw new Error(`unsupported GC storage code ${storage}`);
  }
}

function requireFunction(
  exports: WebAssembly.Exports,
  name: string,
): CallableFunction {
  const value = exports[name];
  if (typeof value !== "function") {
    throw new Error(`fork GC codec is missing function export ${name}`);
  }
  return value as CallableFunction;
}

function assertSlot(value: number, context: string): void {
  assertU32(value, context);
  if (value > 0x7fff_ffff) {
    throw new RangeError(`${context} is not a routable table slot`);
  }
}

function assertRecipeId(value: number): void {
  assertU31(value, "GC recipe id");
  if (value > MAX_RECIPE_ID) {
    throw new RangeError(`GC recipe id ${value} is reserved`);
  }
}

/**
 * Validated, activation-local structural type evidence.
 *
 * A host callback may select only a constructor record whose `baseLayoutId`
 * points at the exact base record supplied by generated Wasm. This prevents a
 * stale or malicious provenance map from changing the concrete replay helper.
 */
export class ForkGcCodecDescriptor {
  private readonly byId = new Map<number, ForkGcLayoutDescriptor>();
  private readonly baseByType = new Map<number, ForkGcLayoutDescriptor>();

  constructor(readonly layouts: readonly ForkGcLayoutDescriptor[]) {
    layouts.forEach((layout, index) => {
      if (layout.id !== index + 1 || this.byId.has(layout.id)) {
        throw new Error(
          `GC codec layout ${layout.id} is not in canonical id order`,
        );
      }
      this.byId.set(layout.id, layout);
      if (layout.baseLayoutId === layout.id) {
        if (this.baseByType.has(layout.typeOrdinal)) {
          throw new Error(
            `GC type ordinal ${layout.typeOrdinal} has multiple base layouts`,
          );
        }
        this.baseByType.set(layout.typeOrdinal, layout);
      }
    });
    for (const layout of layouts) {
      const base = this.byId.get(layout.baseLayoutId);
      if (
        !base
        || base.baseLayoutId !== base.id
        || base.typeOrdinal !== layout.typeOrdinal
        || base.kind !== layout.kind
        || (
          layout.id !== base.id
          && layout.constructor === ForkGcConstructorKind.ArrayGeneric
        )
      ) {
        throw new Error(
          `GC codec layout ${layout.id} has invalid base layout `
          + `${layout.baseLayoutId}`,
        );
      }
      if (
        layout.kind === ForkGcLayoutKind.Struct
          ? layout.constructor !== ForkGcConstructorKind.Struct
          : layout.fields.length !== 1
            || (
              layout.id === base.id
                ? layout.constructor !== ForkGcConstructorKind.ArrayGeneric
                : layout.constructor === ForkGcConstructorKind.ArrayGeneric
            )
      ) {
        throw new Error(`GC codec layout ${layout.id} has an invalid constructor`);
      }
      if (
        layout.id !== base.id
        && (
          layout.scalarLengthOrStride !== base.scalarLengthOrStride
          || layout.superTypeOrdinal !== base.superTypeOrdinal
          || layout.flags
            !== (
              base.flags
              | FORK_GC_LAYOUT_REQUIRES_PROVENANCE
            )
          || !sameFields(layout.fields, base.fields)
        )
      ) {
        throw new Error(
          `GC constructor layout ${layout.id} does not match base `
          + `${base.id}`,
        );
      }
      if (
        layout.provenanceScalarLength > 16
        || (
          (layout.flags & FORK_GC_LAYOUT_REQUIRES_PROVENANCE) === 0
          && (
            layout.provenanceScalarLength !== 0
            || layout.provenanceReferenceCount !== 0
          )
        )
      ) {
        throw new Error(`GC codec layout ${layout.id} has invalid provenance`);
      }
      validateLayoutPayload(layout);
    }
  }

  require(layoutId: number): ForkGcLayoutDescriptor {
    assertU31(layoutId, "GC layout id");
    const layout = this.byId.get(layoutId);
    if (!layout) throw new Error(`unknown GC layout ${layoutId}`);
    return layout;
  }

  requireCaptureLayout(
    baseLayoutId: number,
    specializedLayoutId: number,
  ): ForkGcLayoutDescriptor {
    const base = this.require(baseLayoutId);
    const selected = this.require(specializedLayoutId);
    if (
      base.baseLayoutId !== base.id
      || selected.baseLayoutId !== base.id
      || selected.typeOrdinal !== base.typeOrdinal
      || selected.kind !== base.kind
      || (
        (base.flags & FORK_GC_LAYOUT_REQUIRES_PROVENANCE) !== 0
        && selected.id === base.id
        && selected.kind === ForkGcLayoutKind.Array
      )
    ) {
      throw new Error(
        `GC constructor layout ${specializedLayoutId} does not belong to `
        + `base layout ${baseLayoutId}`,
      );
    }
    return selected;
  }
}

function sameFields(
  left: readonly ForkGcFieldDescriptor[],
  right: readonly ForkGcFieldDescriptor[],
): boolean {
  return left.length === right.length && left.every((field, index) => {
    const other = right[index]!;
    return field.storage === other.storage
      && field.flags === other.flags
      && field.scalarOffset === other.scalarOffset
      && field.referenceOrdinal === other.referenceOrdinal;
  });
}

function validateLayoutPayload(layout: ForkGcLayoutDescriptor): void {
  let expectedReferenceOrdinal = 0;
  let minimumScalarLength = 0;
  for (const [index, field] of layout.fields.entries()) {
    const isReference = (field.flags & FORK_GC_FIELD_REFERENCE) !== 0;
    const isMutable = (field.flags & FORK_GC_FIELD_MUTABLE) !== 0;
    const isNullable = (field.flags & FORK_GC_FIELD_NULLABLE) !== 0;
    const isDependency =
      (field.flags & FORK_GC_FIELD_ALLOCATION_DEPENDENCY) !== 0;
    if (
      isReference !== (field.storage === 8)
      || (!isReference && (isNullable || isDependency))
      || (isDependency && isMutable)
    ) {
      throw new Error(
        `GC layout ${layout.id} field ${index} has inconsistent flags`,
      );
    }
    if (isReference) {
      if (field.referenceOrdinal !== expectedReferenceOrdinal) {
        throw new Error(
          `GC layout ${layout.id} field ${index} has noncanonical `
          + `reference ordinal`,
        );
      }
      expectedReferenceOrdinal++;
      continue;
    }
    const scalarOffset = field.scalarOffset!;
    const end = scalarOffset + storageByteLength(field.storage);
    if (
      !Number.isSafeInteger(end)
      || end > 0xffff_ffff
      || scalarOffset < minimumScalarLength
    ) {
      throw new Error(
        `GC layout ${layout.id} field ${index} has an invalid scalar offset`,
      );
    }
    minimumScalarLength = end;
  }
  if (
    layout.kind === ForkGcLayoutKind.Struct
    && minimumScalarLength > layout.scalarLengthOrStride
  ) {
    throw new Error(`GC struct layout ${layout.id} scalar fields overflow`);
  }
  if (
    layout.kind === ForkGcLayoutKind.Array
    && layout.fields[0]!.storage !== 8
    && layout.scalarLengthOrStride
      !== storageByteLength(layout.fields[0]!.storage)
  ) {
    throw new Error(`GC array layout ${layout.id} has an invalid stride`);
  }

  switch (layout.constructor) {
    case ForkGcConstructorKind.Struct:
      if (layout.provenanceScalarLength !== 0) {
        throw new Error(
          `GC struct layout ${layout.id} has unexpected scalar provenance`,
        );
      }
      break;
    case ForkGcConstructorKind.ArrayGeneric:
    case ForkGcConstructorKind.ArrayDefault:
      if (
        layout.provenanceScalarLength !== 0
        || layout.provenanceReferenceCount !== 0
      ) {
        throw new Error(
          `GC layout ${layout.id} has unexpected constructor provenance`,
        );
      }
      break;
    case ForkGcConstructorKind.ArrayFixed:
      if (
        layout.provenanceScalarLength !== 0
        || (
          layout.provenanceReferenceCount !== 0
          && layout.provenanceReferenceCount !== layout.auxiliary
        )
      ) {
        throw new Error(
          `GC array.new_fixed layout ${layout.id} is malformed`,
        );
      }
      break;
    case ForkGcConstructorKind.ArrayNew:
      if (
        layout.provenanceReferenceCount > 1
        || (
          layout.provenanceReferenceCount !== 0
          && layout.provenanceScalarLength !== 0
        )
      ) {
        throw new Error(`GC array.new layout ${layout.id} is malformed`);
      }
      break;
    case ForkGcConstructorKind.ArrayData:
      if (
        layout.fields[0]!.storage === 8
        || layout.provenanceScalarLength !== 8
        || layout.provenanceReferenceCount !== 0
      ) {
        throw new Error(`GC array.new_data layout ${layout.id} is malformed`);
      }
      break;
    case ForkGcConstructorKind.ArrayElement:
      if (
        layout.fields[0]!.storage !== 8
        || layout.provenanceScalarLength !== 8
        || layout.provenanceReferenceCount !== 0
      ) {
        throw new Error(`GC array.new_elem layout ${layout.id} is malformed`);
      }
      break;
  }
}

export function decodeForkGcCodecDescriptor(
  bytes: Uint8Array,
): ForkGcCodecDescriptor {
  if (bytes.byteLength < WPK_FORK_GC_CODEC_HEADER_SIZE) {
    throw new Error("GC codec descriptor is truncated");
  }
  if (
    WPK_FORK_GC_CODEC_MAGIC.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new Error("GC codec descriptor has an invalid magic");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint16(4, true) !== WPK_FORK_GC_CODEC_VERSION
    || view.getUint16(6, true) !== WPK_FORK_GC_CODEC_HEADER_SIZE
  ) {
    throw new Error("GC codec descriptor has an unsupported version/header");
  }
  const layoutCount = view.getUint32(8, true);
  const fieldCount = view.getUint32(12, true);
  const layoutsLength = checkedProduct(
    layoutCount,
    WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE,
    "GC layout catalog",
  );
  const fieldsLength = checkedProduct(
    fieldCount,
    WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE,
    "GC field catalog",
  );
  const expectedLength =
    WPK_FORK_GC_CODEC_HEADER_SIZE + layoutsLength + fieldsLength;
  if (expectedLength !== bytes.byteLength) {
    throw new Error(
      `GC codec descriptor has ${bytes.byteLength} bytes; `
      + `expected ${expectedLength}`,
    );
  }

  const rawLayouts: Array<{
    id: number;
    typeOrdinal: number;
    kind: ForkGcLayoutKind;
    constructor: ForkGcConstructorKind;
    flags: number;
    scalarLengthOrStride: number;
    fieldStart: number;
    fieldCount: number;
    superTypeOrdinal: number | null;
    baseLayoutId: number;
    auxiliary: number;
    provenanceScalarLength: number;
    provenanceReferenceCount: number;
  }> = [];
  let expectedFieldStart = 0;
  for (let index = 0; index < layoutCount; index++) {
    const offset =
      WPK_FORK_GC_CODEC_HEADER_SIZE
      + index * WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE;
    const id = view.getUint32(offset, true);
    assertU31(id, `GC layout ${index} id`);
    const kind = view.getUint8(offset + 8);
    const constructor = view.getUint8(offset + 9);
    const flags = view.getUint16(offset + 10, true);
    const fieldStart = view.getUint32(offset + 16, true);
    const layoutFieldCount = view.getUint32(offset + 20, true);
    if (
      (kind !== ForkGcLayoutKind.Struct && kind !== ForkGcLayoutKind.Array)
      || constructor > ForkGcConstructorKind.ArrayElement
      || (flags & ~FORK_GC_LAYOUT_KNOWN_FLAGS) !== 0
      || fieldStart !== expectedFieldStart
      || layoutFieldCount > fieldCount - Math.min(fieldStart, fieldCount)
    ) {
      throw new Error(`GC layout ${id} has unsupported kind/flags`);
    }
    expectedFieldStart += layoutFieldCount;
    rawLayouts.push({
      id,
      typeOrdinal: view.getUint32(offset + 4, true),
      kind,
      constructor,
      flags,
      scalarLengthOrStride: view.getUint32(offset + 12, true),
      fieldStart,
      fieldCount: layoutFieldCount,
      superTypeOrdinal:
        view.getUint32(offset + 24, true) === NO_ORDINAL
          ? null
          : view.getUint32(offset + 24, true),
      baseLayoutId: view.getUint32(offset + 28, true),
      auxiliary: view.getUint32(offset + 32, true),
      provenanceScalarLength: view.getUint32(offset + 36, true),
      provenanceReferenceCount: view.getUint32(offset + 40, true),
    });
  }
  if (expectedFieldStart !== fieldCount) {
    throw new Error("GC codec descriptor has unowned field records");
  }

  const fields: ForkGcFieldDescriptor[] = [];
  const fieldsOffset = WPK_FORK_GC_CODEC_HEADER_SIZE + layoutsLength;
  for (let index = 0; index < fieldCount; index++) {
    const offset = fieldsOffset + index * WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE;
    const storage = view.getUint8(offset);
    const flags = view.getUint8(offset + 1);
    const reserved = view.getUint16(offset + 2, true);
    const scalarOffset = view.getUint32(offset + 4, true);
    const referenceOrdinal = view.getUint32(offset + 8, true);
    if (
      storage < 1
      || storage > 8
      || (flags & ~FORK_GC_FIELD_KNOWN_FLAGS) !== 0
      || reserved !== 0
      || (
        (flags & FORK_GC_FIELD_REFERENCE) !== 0
        && (scalarOffset !== NO_ORDINAL || referenceOrdinal === NO_ORDINAL)
      )
      || (
        (flags & FORK_GC_FIELD_REFERENCE) === 0
        && (scalarOffset === NO_ORDINAL || referenceOrdinal !== NO_ORDINAL)
      )
    ) {
      throw new Error(`GC field ${index} is malformed`);
    }
    fields.push({
      storage,
      flags,
      scalarOffset: scalarOffset === NO_ORDINAL ? null : scalarOffset,
      referenceOrdinal:
        referenceOrdinal === NO_ORDINAL ? null : referenceOrdinal,
    });
  }

  const layouts = rawLayouts.map((layout) => {
    if (
      layout.fieldStart > fieldCount
      || layout.fieldCount > fieldCount - layout.fieldStart
    ) {
      throw new Error(`GC layout ${layout.id} field range is out of bounds`);
    }
    const selectedFields = fields.slice(
      layout.fieldStart,
      layout.fieldStart + layout.fieldCount,
    );
    if (
      (layout.kind === ForkGcLayoutKind.Array && selectedFields.length !== 1)
      || (layout.kind === ForkGcLayoutKind.Struct
        && layout.constructor !== ForkGcConstructorKind.Struct)
    ) {
      throw new Error(`GC layout ${layout.id} has inconsistent shape`);
    }
    return {
      ...layout,
      fields: selectedFields,
    };
  });
  return new ForkGcCodecDescriptor(layouts);
}

export function readForkGcCodecDescriptor(
  module: WebAssembly.Module,
): ForkGcCodecDescriptor {
  const sections = WebAssembly.Module.customSections(
    module,
    WPK_FORK_GC_CODEC_SECTION,
  );
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${WPK_FORK_GC_CODEC_SECTION} section, `
      + `found ${sections.length}`,
    );
  }
  return decodeForkGcCodecDescriptor(new Uint8Array(sections[0]!));
}

/**
 * Bind the four scalar-callable entry points generated for one activation.
 *
 * No method accepts or returns `anyref`; values move only through the
 * process-owned transit table imported by both the parent and fresh child.
 */
export function forkGcCodecProviderFromInstance(
  activationId: number,
  module: WebAssembly.Module,
  instance: WebAssembly.Instance,
): ForkGcCodecProvider {
  assertU32(activationId, "GC codec activation");
  const probe = requireFunction(
    instance.exports,
    WPK_FORK_REFERENCE_EXPORT_GC_PROBE,
  );
  const encodeSlot = requireFunction(
    instance.exports,
    WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT,
  );
  const allocate = requireFunction(
    instance.exports,
    WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE,
  );
  const fill = requireFunction(
    instance.exports,
    WPK_FORK_REFERENCE_EXPORT_GC_FILL,
  );
  const publishExternref = requireFunction(
    instance.exports,
    WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF,
  );
  return {
    activationId,
    descriptor: readForkGcCodecDescriptor(module),
    probe(slot): bigint {
      assertSlot(slot, "GC probe slot");
      const packed = probe(slot);
      if (typeof packed !== "bigint") {
        throw new TypeError("GC probe did not return an i64");
      }
      return BigInt.asUintN(64, packed);
    },
    encodeSlot(slot): number {
      assertSlot(slot, "GC encode slot");
      const recipeId = Number(encodeSlot(slot));
      assertRecipeId(recipeId);
      return recipeId;
    },
    allocate(recipeId): void {
      assertRecipeId(recipeId);
      if (recipeId === 0) {
        throw new RangeError("the null recipe cannot be allocated");
      }
      allocate(recipeId);
    },
    fill(recipeId): void {
      assertRecipeId(recipeId);
      if (recipeId === 0) {
        throw new RangeError("the null recipe cannot be filled");
      }
      fill(recipeId);
    },
    publishExternref(recipeId, value): void {
      assertRecipeId(recipeId);
      if (recipeId === 0) {
        throw new RangeError("the null recipe cannot publish an externref");
      }
      publishExternref(recipeId, value);
    },
  };
}

export interface ForkGcConstructorProvenance {
  readonly activationId: number;
  readonly baseLayoutId: number;
  readonly layoutId: number;
  readonly scalars: Uint8Array;
  readonly references: readonly (object | null)[];
}

interface PendingProvenance {
  readonly token: number;
  readonly object: object;
  readonly activationId: number;
  readonly baseLayoutId: number;
  readonly layout: ForkGcLayoutDescriptor;
  readonly scalars: Uint8Array;
  readonly references: (object | null)[];
}

/**
 * Weak-keyed constructor evidence for non-shell GC objects.
 *
 * The registry owns a key strongly only between `begin` and `end`; finalized
 * records are ephemerons and disappear with their Wasm wrapper. `abortPending`
 * is called at every transaction/activation teardown so a trapping wrapper
 * cannot leave a hidden strong root.
 */
export class ForkGcProvenanceRegistry {
  private finalized = new WeakMap<object, ForkGcConstructorProvenance>();
  private pending: PendingProvenance | null = null;
  private nextToken = 1;

  begin(
    table: WebAssembly.Table,
    descriptor: ForkGcCodecDescriptor,
    expectedActivationId: number,
    slot: number,
    activationId: number,
    baseLayoutId: number,
    specializedLayoutId: number,
    scalarLo: bigint,
    scalarHi: bigint,
    referenceCount: number,
  ): number {
    try {
      if (this.pending) {
        throw new Error(
          `GC provenance registration ${this.pending.token} is still pending`,
        );
      }
      assertU32(expectedActivationId, "expected GC activation");
      assertU32(activationId, "GC provenance activation");
      assertU32(slot, "GC provenance slot");
      assertU32(referenceCount, "GC provenance reference count");
      if (activationId !== expectedActivationId) {
        throw new Error(
          `activation ${expectedActivationId} cannot register GC provenance `
          + `for activation ${activationId}`,
        );
      }
      if (slot >= table.length) {
        throw new Error(`GC provenance slot ${slot} is out of bounds`);
      }
      const object = table.get(slot);
      if (
        (typeof object !== "object" || object === null)
        && typeof object !== "function"
      ) {
        throw new Error("GC provenance source is not a non-null Wasm object");
      }
      const layout = descriptor.requireCaptureLayout(
        baseLayoutId,
        specializedLayoutId,
      );
      if (layout.provenanceReferenceCount !== referenceCount) {
        throw new Error(
          `GC layout ${layout.id} expects `
          + `${layout.provenanceReferenceCount} provenance references, `
          + `found ${referenceCount}`,
        );
      }
      const scalarBytes = new Uint8Array(16);
      const scalarView = new DataView(scalarBytes.buffer);
      scalarView.setBigUint64(0, BigInt.asUintN(64, scalarLo), true);
      scalarView.setBigUint64(8, BigInt.asUintN(64, scalarHi), true);
      const token = this.nextToken++;
      if (!Number.isSafeInteger(token) || token > 0x7fff_ffff) {
        this.nextToken = 1;
        throw new Error("GC provenance token space exhausted");
      }
      this.pending = {
        token,
        object: object as object,
        activationId,
        baseLayoutId,
        layout,
        scalars: scalarBytes.slice(0, layout.provenanceScalarLength),
        references: [],
      };
      return token;
    } catch (error) {
      this.abortPending();
      try {
        if (Number.isInteger(slot) && slot >= 0 && slot < table.length) {
          table.set(slot, null);
        }
      } catch {
        // Preserve the fail-closed provenance error.
      }
      throw error;
    }
  }

  appendReference(
    table: WebAssembly.Table,
    token: number,
    index: number,
    slot: number,
  ): void {
    try {
      const pending = this.requirePending(token);
      assertU32(index, "GC provenance reference index");
      assertU32(slot, "GC provenance reference slot");
      if (
        index !== pending.references.length
        || index >= pending.layout.provenanceReferenceCount
      ) {
        throw new Error(
          `GC provenance reference ${index} is out of canonical order`,
        );
      }
      if (slot >= table.length) {
        throw new Error(`GC provenance reference slot ${slot} is out of bounds`);
      }
      const value = table.get(slot);
      if (
        value !== null
        && (typeof value !== "object")
        && typeof value !== "function"
      ) {
        throw new Error(
          `GC provenance reference ${index} is neither null nor an object`,
        );
      }
      // A nullable seed for a zero-length immutable array is unobservable but
      // still a typed constructor operand. Preserve it as recipe zero so a
      // replayed child can register the same constructor evidence.
      pending.references.push(value as object | null);
    } catch (error) {
      this.abortPending();
      try {
        if (Number.isInteger(slot) && slot >= 0 && slot < table.length) {
          table.set(slot, null);
        }
      } catch {
        // Preserve the fail-closed provenance error.
      }
      throw error;
    }
  }

  end(token: number): void {
    try {
      const pending = this.requirePending(token);
      if (
        pending.references.length
        !== pending.layout.provenanceReferenceCount
      ) {
        throw new Error(
          `GC provenance registration ${token} has `
          + `${pending.references.length} references; expected `
          + `${pending.layout.provenanceReferenceCount}`,
        );
      }
      this.finalized.set(pending.object, {
        activationId: pending.activationId,
        baseLayoutId: pending.baseLayoutId,
        layoutId: pending.layout.id,
        scalars: pending.scalars,
        references: [...pending.references],
      });
      this.pending = null;
    } catch (error) {
      this.abortPending();
      throw error;
    }
  }

  lookup(
    object: unknown,
    expectedActivationId: number,
    descriptor: ForkGcCodecDescriptor,
    baseLayoutId: number,
  ): ForkGcConstructorProvenance | null {
    if (
      (typeof object !== "object" || object === null)
      && typeof object !== "function"
    ) {
      return null;
    }
    const provenance = this.finalized.get(object as object);
    if (!provenance) return null;
    if (provenance.activationId !== expectedActivationId) {
      throw new Error(
        `GC provenance belongs to activation ${provenance.activationId}, `
        + `not ${expectedActivationId}`,
      );
    }
    descriptor.requireCaptureLayout(baseLayoutId, provenance.layoutId);
    if (provenance.baseLayoutId !== baseLayoutId) {
      throw new Error(
        `GC provenance base ${provenance.baseLayoutId} does not match `
        + `${baseLayoutId}`,
      );
    }
    return provenance;
  }

  find(object: unknown): ForkGcConstructorProvenance | null {
    if (
      (typeof object !== "object" || object === null)
      && typeof object !== "function"
    ) {
      return null;
    }
    return this.finalized.get(object as object) ?? null;
  }

  abortPending(): void {
    this.pending = null;
  }

  clear(): void {
    this.abortPending();
    this.finalized = new WeakMap<object, ForkGcConstructorProvenance>();
  }

  private requirePending(token: number): PendingProvenance {
    assertU31(token, "GC provenance token");
    if (!this.pending || this.pending.token !== token) {
      throw new Error(`GC provenance token ${token} is not active`);
    }
    return this.pending;
  }
}
