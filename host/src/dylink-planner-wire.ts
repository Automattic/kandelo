/**
 * The JavaScript half of `crates/dylink/src/wire.rs`.
 *
 * The dynamic-linking planner is a wasm module that imports nothing, so every
 * value crossing into or out of it is bytes. This file is that boundary and
 * nothing else: it has no knowledge of ELF, relocation, symbol scope, GOT
 * placement, or load ordering, and it makes no decision the planner could have
 * made. Each function here mirrors exactly one `put_*`/`get_*` in `wire.rs`.
 *
 * Two conventions carried over verbatim, because a mismatch is silent:
 *
 *   * Every integer is little-endian, every length is a `u32` prefix, and every
 *     string is a length-prefixed UTF-8 blob.
 *   * A decoder must consume its record exactly. `Reader.finish()` throws on a
 *     trailing byte, matching `Reader::finish`, because a format disagreement
 *     that decodes "successfully" is the failure mode this format exists to
 *     make loud.
 *
 * Pointer-width values keep their width across the boundary. `I64` is read as a
 * `bigint` rather than narrowed to a `number`: a wasm64 process carries
 * addresses a double cannot hold exactly, and narrowing at the transport would
 * corrupt them before any caller could notice.
 */

/** A pointer-width scalar, with its width preserved. */
export type WasmValue =
  | { readonly kind: "i32"; readonly value: number }
  | { readonly kind: "i64"; readonly value: bigint };

export type ValType =
  | { readonly kind: "i32" }
  | { readonly kind: "i64" }
  | { readonly kind: "f32" }
  | { readonly kind: "f64" }
  | { readonly kind: "opaque"; readonly byte: number };

export type ExternKind = "func" | "table" | "memory" | "global" | "tag";

export type BindingValue =
  | { readonly kind: "processMemory" }
  | { readonly kind: "processTable" }
  | { readonly kind: "processStackPointer" }
  | { readonly kind: "global"; readonly global: number }
  | { readonly kind: "tag"; readonly tag: number }
  | { readonly kind: "export"; readonly instance: number; readonly name: string }
  | { readonly kind: "selfImport"; readonly name: string }
  | { readonly kind: "activationEnv"; readonly name: string }
  | { readonly kind: "weakUndefined" };

export interface ImportBinding {
  readonly position: number;
  readonly module: string;
  readonly name: string;
  readonly kind: ExternKind;
  readonly value: BindingValue;
  readonly duplicateOccurrence: boolean;
}

export interface InstanceExport {
  readonly name: string;
  readonly kind: ExternKind;
  readonly value?: WasmValue;
  readonly mutable?: boolean;
}

export type TableValue =
  | { readonly kind: "null" }
  | { readonly kind: "export"; readonly instance: number; readonly name: string };

export type ModuleSource =
  | { readonly kind: "original" }
  | { readonly kind: "rewritten"; readonly bytes: Uint8Array };

export type LinkAct =
  | {
      readonly act: "compile";
      readonly module: number;
      /**
       * The object this image belongs to.
       *
       * A load resolves its whole `DT_NEEDED` closure, so the image being
       * compiled is often NOT the one the `dlopen` named. The driver already
       * holds every image it was given or fetched; naming the one this act
       * means is what stops it from guessing.
       */
      readonly library: string;
      readonly source: ModuleSource;
    }
  | {
      readonly act: "newGlobal";
      readonly global: number;
      readonly ty: ValType;
      readonly mutable: boolean;
      readonly init: WasmValue;
    }
  | { readonly act: "readGlobal"; readonly global: number }
  | { readonly act: "writeGlobal"; readonly global: number; readonly value: WasmValue }
  | { readonly act: "growTable"; readonly delta: bigint }
  | { readonly act: "writeTable"; readonly index: bigint; readonly value: TableValue }
  | { readonly act: "growMemory"; readonly deltaPages: bigint }
  | { readonly act: "newTag"; readonly tag: number; readonly parameters: readonly ValType[] }
  | {
      readonly act: "instantiate";
      readonly module: number;
      readonly instance: number;
      readonly bindings: readonly ImportBinding[];
    }
  | { readonly act: "readExports"; readonly instance: number }
  | { readonly act: "zeroMemory"; readonly address: bigint; readonly length: bigint };

export interface DylinkAllocation {
  readonly address: bigint;
  readonly size: bigint;
  readonly mappingAddress: bigint;
  readonly mappingSize: bigint;
}

export type HostRequest =
  | {
      readonly request: "allocateMemory";
      readonly library: string;
      readonly size: bigint;
      readonly align: bigint;
    }
  | {
      readonly request: "adoptMapping";
      readonly library: string;
      readonly allocation: DylinkAllocation;
    }
  | {
      readonly request: "releaseMapping";
      readonly library: string;
      readonly allocation: DylinkAllocation;
    }
  | {
      readonly request: "prepareActivation";
      readonly library: string;
      readonly replayActivationId?: number;
    }
  | {
      readonly request: "registerActivation";
      readonly library: string;
      readonly activation: number;
      readonly instance: number;
    }
  | {
      readonly request: "unregisterActivation";
      readonly library: string;
      readonly activation: number;
    }
  | {
      readonly request: "journalTableMutation";
      readonly firstIndex: bigint;
      readonly length: bigint;
    }
  | {
      readonly request: "readDependency";
      readonly library: string;
      readonly path: string;
    }
  | {
      readonly request: "readArchive";
      readonly address: bigint;
      readonly length: bigint;
    }
  | { readonly request: "allocateArchive"; readonly size: bigint }
  | {
      readonly request: "writeArchive";
      readonly address: bigint;
      readonly bytes: Uint8Array;
    }
  | {
      readonly request: "publishGeneration";
      readonly address: bigint;
      readonly generation: bigint;
    }
  | {
      readonly request: "releaseArchive";
      readonly address: bigint;
      readonly size: bigint;
    }
  | {
      readonly request: "savedGotFunc";
      readonly library: string;
      readonly symbol: string;
    };

export type InitializationStage = "bootstrap" | "relocations" | "constructors";

/** The export each stage names. Mirrors `InitializationStage::export_name`. */
export const STAGE_EXPORT: Readonly<Record<InitializationStage, string>> = {
  bootstrap: "wpk_fork_module_bootstrap",
  relocations: "__wasm_apply_data_relocs",
  constructors: "__wasm_call_ctors",
};

export interface StagedCall {
  readonly library: string;
  readonly stage: InitializationStage;
  readonly instance: number;
  readonly exportName: string;
}

export type PlanStep =
  | { readonly step: "act"; readonly act: LinkAct }
  | { readonly step: "host"; readonly request: HostRequest }
  | { readonly step: "call"; readonly call: StagedCall }
  | { readonly step: "finished" };

export type ActResult =
  | { readonly result: "done" }
  | { readonly result: "value"; readonly value: WasmValue }
  | { readonly result: "index"; readonly index: bigint }
  | { readonly result: "exports"; readonly exports: readonly InstanceExport[] }
  | { readonly result: "bytes"; readonly bytes: Uint8Array | null };

export type DataBinding =
  | { readonly kind: "export"; readonly instance: number; readonly name: string }
  | { readonly kind: "global"; readonly global: number };

export type SymbolValue =
  | { readonly kind: "data"; readonly address: bigint; readonly binding: DataBinding }
  | { readonly kind: "func"; readonly instance: number; readonly export: string };

export interface ResolvedSymbol {
  readonly value: SymbolValue;
  readonly owner?: string;
  readonly globallyVisible: boolean;
}

export type CloseOutcome =
  | { readonly outcome: "mainImage" }
  | { readonly outcome: "stillReferenced"; readonly library: string; readonly remaining: number }
  | { readonly outcome: "released"; readonly library: string };

export type PointerWidth = 4 | 8;
export type UnresolvedPolicy = "elfStrict" | "legacyZero";

export interface LinkerConfig {
  readonly pointerWidth: PointerWidth;
  readonly hasAllocator: boolean;
  readonly forkActivationAvailable: boolean;
  readonly forkActivationUnavailableReason: string;
  readonly unresolvedPolicy: UnresolvedPolicy;
  readonly memoryBytes: bigint;
  readonly sharedMemory: boolean;
  readonly heapPointer?: bigint;
  /**
   * The default `DT_NEEDED` search path, in order. A property of the process's
   * filesystem rather than of the linker, which is why it is configured and not
   * compiled in. The requesting object's own directory is always tried first
   * and is not listed here.
   */
  readonly librarySearchPaths: readonly string[];
}

export interface MainImage {
  readonly tableLength: bigint;
  readonly exports: readonly (readonly [string, SymbolValue])[];
  readonly elementSlots: readonly (readonly [bigint, number, string])[];
}

export interface ReplayInputs {
  readonly memoryBase: bigint;
  readonly tableBase: bigint;
  readonly activationId?: number;
  readonly tlsBase?: bigint;
  readonly globalVisibility: boolean;
  readonly committedGlobalRoot: boolean;
  readonly providerDependencies: readonly string[];
  readonly allocations: readonly DylinkAllocation[];
  readonly initializationStage?: InitializationStage;
  readonly savedGotFunc: readonly (readonly [string, WasmValue])[];
}

export interface LoadRequest {
  readonly name: string;
  readonly moduleBytes: Uint8Array;
  readonly globalVisibility: boolean;
  readonly borrowedMemory: boolean;
  readonly replay?: ReplayInputs;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/** A growing little-endian byte sink. */
export class Writer {
  #bytes: Uint8Array = new Uint8Array(256);
  #length = 0;

  #reserve(extra: number): void {
    if (this.#length + extra <= this.#bytes.length) return;
    let capacity = this.#bytes.length * 2;
    while (capacity < this.#length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
  }

  bytes(): Uint8Array {
    return this.#bytes.subarray(0, this.#length);
  }

  u8(value: number): void {
    this.#reserve(1);
    this.#bytes[this.#length++] = value & 0xff;
  }

  u32(value: number): void {
    this.#reserve(4);
    new DataView(this.#bytes.buffer, this.#bytes.byteOffset + this.#length, 4).setUint32(
      0,
      value >>> 0,
      true,
    );
    this.#length += 4;
  }

  u64(value: bigint): void {
    this.#reserve(8);
    new DataView(this.#bytes.buffer, this.#bytes.byteOffset + this.#length, 8).setBigUint64(
      0,
      BigInt.asUintN(64, value),
      true,
    );
    this.#length += 8;
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  blob(value: Uint8Array): void {
    this.u32(value.length);
    this.#reserve(value.length);
    this.#bytes.set(value, this.#length);
    this.#length += value.length;
  }

  str(value: string): void {
    this.blob(TEXT_ENCODER.encode(value));
  }
}

/** A bounds-checked little-endian byte source. */
export class Reader {
  #view: DataView;
  #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #take(count: number): Uint8Array {
    const end = this.#offset + count;
    if (end > this.#bytes.length) {
      throw new RangeError("dylink wire read past end of record");
    }
    const slice = this.#bytes.subarray(this.#offset, end);
    this.#offset = end;
    return slice;
  }

  /**
   * A trailing byte means the two sides disagree about the format. Mirrors
   * `Reader::finish`, which is the only reason a partial decode cannot pass as
   * a successful one.
   */
  finish(): void {
    if (this.#offset !== this.#bytes.length) {
      throw new RangeError(
        `dylink wire record has ${this.#bytes.length - this.#offset} trailing bytes`,
      );
    }
  }

  u8(): number {
    return this.#take(1)[0]!;
  }

  u32(): number {
    const offset = this.#offset;
    this.#take(4);
    return this.#view.getUint32(offset, true);
  }

  u64(): bigint {
    const offset = this.#offset;
    this.#take(8);
    return this.#view.getBigUint64(offset, true);
  }

  bool(): boolean {
    const byte = this.u8();
    if (byte > 1) throw new RangeError("dylink wire bool is not 0 or 1");
    return byte === 1;
  }

  blob(): Uint8Array {
    return this.#take(this.u32()).slice();
  }

  str(): string {
    // `slice()` first: TextDecoder rejects views backed by SharedArrayBuffer in
    // Firefox and recent Chrome, and the planner's memory can be shared.
    return TEXT_DECODER.decode(this.#take(this.u32()).slice());
  }

  /**
   * Read a vector length, refusing one the remaining bytes cannot possibly
   * back. Mirrors `Reader::vec_len`, so a corrupt length cannot ask for a huge
   * allocation before the read fails.
   */
  vecLen(minEntryBytes: number): number {
    const length = this.u32();
    if (minEntryBytes > 0 && length * minEntryBytes > this.#bytes.length - this.#offset) {
      throw new RangeError("dylink wire vector length exceeds record");
    }
    return length;
  }
}

// ---------------------------------------------------------------------------
// Leaf codecs
// ---------------------------------------------------------------------------

function putValType(w: Writer, ty: ValType): void {
  switch (ty.kind) {
    case "i32":
      return w.u8(0);
    case "i64":
      return w.u8(1);
    case "f32":
      return w.u8(2);
    case "f64":
      return w.u8(3);
    case "opaque":
      w.u8(4);
      return w.u8(ty.byte);
  }
}

function getValType(r: Reader): ValType {
  switch (r.u8()) {
    case 0:
      return { kind: "i32" };
    case 1:
      return { kind: "i64" };
    case 2:
      return { kind: "f32" };
    case 3:
      return { kind: "f64" };
    case 4:
      return { kind: "opaque", byte: r.u8() };
    default:
      throw new RangeError("unknown dylink wire value type");
  }
}

const EXTERN_KINDS: readonly ExternKind[] = ["func", "table", "memory", "global", "tag"];

function putExternKind(w: Writer, kind: ExternKind): void {
  const index = EXTERN_KINDS.indexOf(kind);
  if (index < 0) throw new RangeError(`unknown dylink extern kind ${kind}`);
  w.u8(index);
}

function getExternKind(r: Reader): ExternKind {
  const kind = EXTERN_KINDS[r.u8()];
  if (kind === undefined) throw new RangeError("unknown dylink wire extern kind");
  return kind;
}

export function putWasmValue(w: Writer, value: WasmValue): void {
  if (value.kind === "i32") {
    w.u8(0);
    w.u32(value.value);
  } else {
    w.u8(1);
    w.u64(value.value);
  }
}

export function getWasmValue(r: Reader): WasmValue {
  switch (r.u8()) {
    case 0:
      return { kind: "i32", value: r.u32() };
    case 1:
      return { kind: "i64", value: r.u64() };
    default:
      throw new RangeError("unknown dylink wire wasm value");
  }
}

function getBindingValue(r: Reader): BindingValue {
  switch (r.u8()) {
    case 0:
      return { kind: "processMemory" };
    case 1:
      return { kind: "processTable" };
    case 2:
      return { kind: "processStackPointer" };
    case 3:
      return { kind: "global", global: r.u32() };
    case 4:
      return { kind: "tag", tag: r.u32() };
    case 5:
      return { kind: "export", instance: r.u32(), name: r.str() };
    case 6:
      return { kind: "selfImport", name: r.str() };
    case 7:
      return { kind: "activationEnv", name: r.str() };
    case 8:
      return { kind: "weakUndefined" };
    default:
      throw new RangeError("unknown dylink wire binding value");
  }
}

/** Matches `MIN_IMPORT_BINDING_BYTES`. */
const MIN_IMPORT_BINDING_BYTES = 4 + 4 + 4 + 1 + 1 + 1;
const MIN_INSTANCE_EXPORT_BYTES = 4 + 1 + 1 + 1;

function getImportBinding(r: Reader): ImportBinding {
  return {
    position: r.u32(),
    module: r.str(),
    name: r.str(),
    kind: getExternKind(r),
    value: getBindingValue(r),
    duplicateOccurrence: r.bool(),
  };
}

function putInstanceExport(w: Writer, exported: InstanceExport): void {
  w.str(exported.name);
  putExternKind(w, exported.kind);
  if (exported.value === undefined) {
    w.bool(false);
  } else {
    w.bool(true);
    putWasmValue(w, exported.value);
  }
  if (exported.mutable === undefined) {
    w.bool(false);
  } else {
    w.bool(true);
    w.bool(exported.mutable);
  }
}

function getInstanceExport(r: Reader): InstanceExport {
  const name = r.str();
  const kind = getExternKind(r);
  const value = r.bool() ? getWasmValue(r) : undefined;
  const mutable = r.bool() ? r.bool() : undefined;
  return { name, kind, ...(value ? { value } : {}), ...(mutable === undefined ? {} : { mutable }) };
}

function getTableValue(r: Reader): TableValue {
  switch (r.u8()) {
    case 0:
      return { kind: "null" };
    case 1:
      return { kind: "export", instance: r.u32(), name: r.str() };
    default:
      throw new RangeError("unknown dylink wire table value");
  }
}

const STAGES: readonly InitializationStage[] = ["bootstrap", "relocations", "constructors"];

function putStage(w: Writer, stage: InitializationStage): void {
  w.u8(STAGES.indexOf(stage));
}

function getStage(r: Reader): InitializationStage {
  const stage = STAGES[r.u8()];
  if (stage === undefined) throw new RangeError("unknown dylink wire initialization stage");
  return stage;
}

function getModuleSource(r: Reader): ModuleSource {
  switch (r.u8()) {
    case 0:
      return { kind: "original" };
    case 1:
      return { kind: "rewritten", bytes: r.blob() };
    default:
      throw new RangeError("unknown dylink wire module source");
  }
}

function getLinkAct(r: Reader): LinkAct {
  switch (r.u8()) {
    case 0:
      return { act: "compile", module: r.u32(), library: r.str(), source: getModuleSource(r) };
    case 1:
      return {
        act: "newGlobal",
        global: r.u32(),
        ty: getValType(r),
        mutable: r.bool(),
        init: getWasmValue(r),
      };
    case 2:
      return { act: "readGlobal", global: r.u32() };
    case 3:
      return { act: "writeGlobal", global: r.u32(), value: getWasmValue(r) };
    case 4:
      return { act: "growTable", delta: r.u64() };
    case 5:
      return { act: "writeTable", index: r.u64(), value: getTableValue(r) };
    case 6:
      return { act: "growMemory", deltaPages: r.u64() };
    case 7: {
      const tag = r.u32();
      const count = r.vecLen(1);
      const parameters: ValType[] = [];
      for (let index = 0; index < count; index++) parameters.push(getValType(r));
      return { act: "newTag", tag, parameters };
    }
    case 8: {
      const module = r.u32();
      const instance = r.u32();
      const count = r.vecLen(MIN_IMPORT_BINDING_BYTES);
      const bindings: ImportBinding[] = [];
      for (let index = 0; index < count; index++) bindings.push(getImportBinding(r));
      return { act: "instantiate", module, instance, bindings };
    }
    case 9:
      return { act: "readExports", instance: r.u32() };
    case 10:
      return { act: "zeroMemory", address: r.u64(), length: r.u64() };
    default:
      throw new RangeError("unknown dylink wire link act");
  }
}

function getAllocation(r: Reader): DylinkAllocation {
  return {
    address: r.u64(),
    size: r.u64(),
    mappingAddress: r.u64(),
    mappingSize: r.u64(),
  };
}

function putAllocation(w: Writer, allocation: DylinkAllocation): void {
  w.u64(allocation.address);
  w.u64(allocation.size);
  w.u64(allocation.mappingAddress);
  w.u64(allocation.mappingSize);
}

function getHostRequest(r: Reader): HostRequest {
  switch (r.u8()) {
    case 0:
      return { request: "allocateMemory", library: r.str(), size: r.u64(), align: r.u64() };
    case 1:
      return { request: "adoptMapping", library: r.str(), allocation: getAllocation(r) };
    case 2:
      return { request: "releaseMapping", library: r.str(), allocation: getAllocation(r) };
    case 3: {
      const library = r.str();
      const replayActivationId = r.bool() ? r.u32() : undefined;
      return {
        request: "prepareActivation",
        library,
        ...(replayActivationId === undefined ? {} : { replayActivationId }),
      };
    }
    case 4:
      return {
        request: "registerActivation",
        library: r.str(),
        activation: r.u32(),
        instance: r.u32(),
      };
    case 5:
      return { request: "unregisterActivation", library: r.str(), activation: r.u32() };
    case 6:
      return { request: "journalTableMutation", firstIndex: r.u64(), length: r.u64() };
    case 7:
      return { request: "readDependency", library: r.str(), path: r.str() };
    case 8:
      return { request: "readArchive", address: r.u64(), length: r.u64() };
    case 9:
      return { request: "allocateArchive", size: r.u64() };
    case 10:
      return { request: "writeArchive", address: r.u64(), bytes: r.blob() };
    case 11:
      return { request: "publishGeneration", address: r.u64(), generation: r.u64() };
    case 12:
      return { request: "releaseArchive", address: r.u64(), size: r.u64() };
    case 13:
      return { request: "savedGotFunc", library: r.str(), symbol: r.str() };
    default:
      throw new RangeError("unknown dylink wire host request");
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Decode one `PlanStep`. Mirrors `decode_plan_step`. */
export function decodePlanStep(bytes: Uint8Array): PlanStep {
  const r = new Reader(bytes);
  let step: PlanStep;
  switch (r.u8()) {
    case 0:
      step = { step: "act", act: getLinkAct(r) };
      break;
    case 1:
      step = { step: "host", request: getHostRequest(r) };
      break;
    case 2: {
      const library = r.str();
      const stage = getStage(r);
      step = {
        step: "call",
        call: { library, stage, instance: r.u32(), exportName: STAGE_EXPORT[stage] },
      };
      break;
    }
    case 3:
      step = { step: "finished" };
      break;
    default:
      throw new RangeError("unknown dylink wire plan step");
  }
  r.finish();
  return step;
}

/** Encode one `ActResult`. Mirrors `encode_act_result`. */
export function encodeActResult(result: ActResult): Uint8Array {
  const w = new Writer();
  switch (result.result) {
    case "done":
      w.u8(0);
      break;
    case "value":
      w.u8(1);
      putWasmValue(w, result.value);
      break;
    case "index":
      w.u8(2);
      w.u64(result.index);
      break;
    case "exports":
      w.u8(3);
      w.u32(result.exports.length);
      for (const exported of result.exports) putInstanceExport(w, exported);
      break;
    case "bytes":
      w.u8(4);
      if (result.bytes === null) {
        w.bool(false);
      } else {
        w.bool(true);
        w.blob(result.bytes);
      }
      break;
  }
  return w.bytes();
}

/** Decode an `ActResult`, for the round-trip tests. */
export function decodeActResult(bytes: Uint8Array): ActResult {
  const r = new Reader(bytes);
  let result: ActResult;
  switch (r.u8()) {
    case 0:
      result = { result: "done" };
      break;
    case 1:
      result = { result: "value", value: getWasmValue(r) };
      break;
    case 2:
      result = { result: "index", index: r.u64() };
      break;
    case 3: {
      const count = r.vecLen(MIN_INSTANCE_EXPORT_BYTES);
      const exports: InstanceExport[] = [];
      for (let index = 0; index < count; index++) exports.push(getInstanceExport(r));
      result = { result: "exports", exports };
      break;
    }
    case 4:
      result = { result: "bytes", bytes: r.bool() ? r.blob() : null };
      break;
    default:
      throw new RangeError("unknown dylink wire act result");
  }
  r.finish();
  return result;
}

/** Encode the process-wide linker configuration. Mirrors `encode_linker_config`. */
export function encodeLinkerConfig(config: LinkerConfig): Uint8Array {
  const w = new Writer();
  w.u8(config.pointerWidth === 4 ? 0 : 1);
  w.bool(config.hasAllocator);
  w.bool(config.forkActivationAvailable);
  w.str(config.forkActivationUnavailableReason);
  w.u8(config.unresolvedPolicy === "elfStrict" ? 0 : 1);
  w.u64(config.memoryBytes);
  w.bool(config.sharedMemory);
  if (config.heapPointer === undefined) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u64(config.heapPointer);
  }
  w.u32(config.librarySearchPaths.length);
  for (const path of config.librarySearchPaths) w.str(path);
  return w.bytes();
}

/**
 * Encode the funcref table patches an archive publication must carry.
 *
 * They belong to the fork activation coordinator rather than to the linker, but
 * they ride in the same archive record chain and under the same generation
 * fence, so the record layout — which is the planner's — has to know about
 * them. The generation is deliberately not carried: it is assigned by the
 * publication, and a caller-chosen fence could claim to be newer than the
 * archive it lands in.
 */
export function encodeTablePatches(patches: readonly DylinkTablePatch[]): Uint8Array {
  const w = new Writer();
  w.u32(patches.length);
  for (const patch of patches) {
    w.u32(patch.activationId);
    w.u32(patch.ownerId);
    w.u64(patch.start);
    w.u64(patch.tableLength);
    w.u32(patch.runs.length);
    for (const run of patch.runs) {
      w.u64(run.length);
      if (run.function === undefined) {
        w.bool(false);
      } else {
        w.bool(true);
        w.u32(run.function.activationId);
        w.u32(run.function.ordinal);
      }
    }
  }
  return w.bytes();
}

/** One funcref coordinate inside a table-patch run. */
export interface DylinkTableFunction {
  readonly activationId: number;
  readonly ordinal: number;
}

/** `length` consecutive slots set to `function`, or cleared when absent. */
export interface DylinkTablePatchRun {
  readonly length: bigint;
  readonly function?: DylinkTableFunction;
}

/** One published funcref table patch. */
export interface DylinkTablePatch {
  readonly activationId: number;
  readonly ownerId: number;
  readonly start: bigint;
  readonly tableLength: bigint;
  readonly runs: readonly DylinkTablePatchRun[];
}

function putSymbolValue(w: Writer, value: SymbolValue): void {
  if (value.kind === "data") {
    w.u8(0);
    w.u64(value.address);
    if (value.binding.kind === "export") {
      w.u8(0);
      w.u32(value.binding.instance);
      w.str(value.binding.name);
    } else {
      w.u8(1);
      w.u32(value.binding.global);
    }
  } else {
    w.u8(1);
    w.u32(value.instance);
    w.str(value.export);
  }
}

function getSymbolValue(r: Reader): SymbolValue {
  switch (r.u8()) {
    case 0: {
      const address = r.u64();
      switch (r.u8()) {
        case 0:
          return {
            kind: "data",
            address,
            binding: { kind: "export", instance: r.u32(), name: r.str() },
          };
        case 1:
          return { kind: "data", address, binding: { kind: "global", global: r.u32() } };
        default:
          throw new RangeError("unknown dylink wire data binding");
      }
    }
    case 1:
      return { kind: "func", instance: r.u32(), export: r.str() };
    default:
      throw new RangeError("unknown dylink wire symbol value");
  }
}

/** Encode the main image's exports and element-segment table layout. */
export function encodeMainImage(image: MainImage): Uint8Array {
  const w = new Writer();
  w.u64(image.tableLength);
  w.u32(image.exports.length);
  for (const [name, value] of image.exports) {
    w.str(name);
    putSymbolValue(w, value);
  }
  w.u32(image.elementSlots.length);
  for (const [slot, instance, exportName] of image.elementSlots) {
    w.u64(slot);
    w.u32(instance);
    w.str(exportName);
  }
  return w.bytes();
}

/** Encode one `dlopen` request, replay inputs included. */
export function encodeLoadRequest(request: LoadRequest): Uint8Array {
  const w = new Writer();
  w.str(request.name);
  w.blob(request.moduleBytes);
  w.bool(request.globalVisibility);
  w.bool(request.borrowedMemory);
  const replay = request.replay;
  if (replay === undefined) {
    w.u8(0);
    return w.bytes();
  }
  w.u8(1);
  w.u64(replay.memoryBase);
  w.u64(replay.tableBase);
  if (replay.activationId === undefined) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u32(replay.activationId);
  }
  if (replay.tlsBase === undefined) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u64(replay.tlsBase);
  }
  w.bool(replay.globalVisibility);
  w.bool(replay.committedGlobalRoot);
  w.u32(replay.providerDependencies.length);
  for (const dependency of replay.providerDependencies) w.str(dependency);
  w.u32(replay.allocations.length);
  for (const allocation of replay.allocations) putAllocation(w, allocation);
  if (replay.initializationStage === undefined) {
    w.u8(0);
  } else {
    w.u8(1);
    putStage(w, replay.initializationStage);
  }
  w.u32(replay.savedGotFunc.length);
  for (const [name, value] of replay.savedGotFunc) {
    w.str(name);
    putWasmValue(w, value);
  }
  return w.bytes();
}

/** Decode a `dlsym` answer. `null` is a miss, not a transport failure. */
export function decodeResolvedSymbol(bytes: Uint8Array): ResolvedSymbol | null {
  const r = new Reader(bytes);
  let symbol: ResolvedSymbol | null;
  switch (r.u8()) {
    case 0:
      symbol = null;
      break;
    case 1: {
      const value = getSymbolValue(r);
      const owner = r.bool() ? r.str() : undefined;
      symbol = { value, ...(owner === undefined ? {} : { owner }), globallyVisible: r.bool() };
      break;
    }
    default:
      throw new RangeError("unknown dylink wire resolved symbol");
  }
  r.finish();
  return symbol;
}

/** Decode what `dlclose` did. */
export function decodeCloseOutcome(bytes: Uint8Array): CloseOutcome {
  const r = new Reader(bytes);
  let outcome: CloseOutcome;
  switch (r.u8()) {
    case 0:
      outcome = { outcome: "mainImage" };
      break;
    case 1:
      outcome = { outcome: "stillReferenced", library: r.str(), remaining: r.u32() };
      break;
    case 2:
      outcome = { outcome: "released", library: r.str() };
      break;
    default:
      throw new RangeError("unknown dylink wire close outcome");
  }
  r.finish();
  return outcome;
}
