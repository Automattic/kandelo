/**
 * The artifact reader's irreducible JavaScript floor: a session wrapper around
 * `crates/wasm-artifact-module`, and nothing else.
 *
 * # Why this file is small, and what it is NOT allowed to grow into
 *
 * `host/src/constants.ts` used to be a complete WebAssembly binary reader —
 * LEB128, type/subtype/composite decode, instruction-immediate skipping,
 * import/export/custom-section descriptors — plus the whole fork-artifact
 * contract, in a language with no types over the bytes. Three copies of that
 * job existed (`tools/xtask/src/build_deps.rs` and
 * `crates/fork-instrument/src/contract_inventory.rs` were the others), and
 * three readers of one format drift: the TypeScript validated descriptor bytes
 * the other two never looked at, while the native pair checked memory
 * pointer-width agreement the TypeScript reached only by another path. An
 * artifact could pass the gate that ran and fail the one that did not.
 *
 * Everything here is therefore transport. There is no LEB128 decoding, no
 * section walking, no policy, no contract rule and no errno choice in this
 * file, and none may be added: if a change here would decide something ABOUT an
 * artifact, the decision belongs in `crates/wasm-artifact`, where it is
 * unit-testable with plain `cargo test` and shared with the kernel, the native
 * host and the build tooling.
 *
 * # Why a module rather than a kernel export
 *
 * The kernel already judges its `exec` target through
 * `kernel_exec_target_artifact_policy`. That export cannot serve the callers
 * here, because they have no kernel:
 *
 * - `kernel.ts` needs the artifact's pointer width to build the import object
 *   **before the kernel module is compiled**;
 * - `worker-main.ts`, `dylink.ts`, `fork-host-import-runtime.ts` and
 *   `wasm-module-reflection.ts` run in the process worker, which holds no
 *   kernel instance;
 * - `binary-resolver.ts` validates `kernel.wasm` itself, before any kernel
 *   exists.
 *
 * `crates/wasm-artifact-module` imports **nothing at all** — not even
 * `env.memory`, verified on every build — so instantiating it depends on
 * nothing, which dissolves that bootstrap cycle rather than working around it.
 *
 * # Installation, and why Node's is automatic
 *
 * The module's bytes arrive differently on each host: Node reads them from the
 * resolved binary tier, the browser fetches a bundler URL. Both are host
 * concerns, so neither belongs here. The `#wasm-artifact-module-source` import
 * below resolves to whichever of the two this realm is, through the conditions
 * declared in `host/package.json`.
 *
 * On Node that registers a synchronous loader, so a realm gets the reader by
 * REACHING this file rather than by remembering to call something. That
 * matters: the reader must be installed once per realm, and while remembering
 * was every entry point's job, four of them forgot — and each failed with a
 * message about something else entirely (a package that would not build, a repo
 * root that could not be found, a kernel "not accepted", a bundler that could
 * not resolve an alias). "Everyone must remember" has no failure mode that
 * names itself.
 *
 * On a browser the condition resolves to a file that deliberately does nothing,
 * because `fetch` is asynchronous and every read here is synchronous. A browser
 * worker installs explicitly at its own `await`-shaped entry, which is the same
 * asymmetry `kernel.wasm` already has between the two hosts.
 *
 * A read before installation throws a message naming the build step, rather
 * than falling back to a JavaScript reader. There is no JavaScript reader to
 * fall back to any more, and a silent fallback is how two of the three copies
 * stayed alive.
 *
 * # The memory contract, which a driver WILL get wrong once
 *
 * Every `wa_*` entry point may allocate, and allocating may grow the module's
 * memory, which detaches every existing `ArrayBuffer` view of it. So every view
 * is acquired fresh, immediately before use, and never held across a call.
 */

// Side-effect import: on Node this registers the loader; on a browser it is
// empty. This line is what makes installation a property of RESOLUTION instead
// of a ritual every entry point has to repeat.
import {
  getInstalledModule,
  getModuleLoader,
  setInstalledModule,
  setModuleLoader,
} from "./wasm-artifact-module-registry";
import "#wasm-artifact-module-source";

/** The exports `crates/wasm-artifact-module` provides. */
interface ArtifactModuleExports {
  readonly memory: WebAssembly.Memory;
  readonly wa_wire_version: () => number;
  readonly wa_input_reserve: (len: number) => number;
  readonly wa_output_ptr: () => number;
  readonly wa_output_len: () => number;
  readonly wa_is_wasm_module: (len: number) => number;
  readonly wa_detect_pointer_width: (len: number) => number;
  readonly wa_custom_section: (artifactLen: number, nameLen: number) => number;
  readonly wa_heap_base: (len: number) => number;
  readonly wa_i32_const_export: (artifactLen: number, nameLen: number) => number;
  readonly wa_read_facts: (len: number) => number;
  readonly wa_fork_contract: (len: number) => number;
  readonly wa_policy: (artifactLen: number, requestLen: number) => number;
}

/**
 * The wire version this driver decodes.
 *
 * Checked against the module's own at installation. A mismatch is refused
 * rather than decoded optimistically: the failure mode of a silently-drifted
 * binary format is a *plausible wrong answer* about whether an artifact may
 * run, which is exactly the class of failure this module exists to remove.
 */
const WIRE_VERSION = 1;

/** `WA_OK` / `WA_ERROR` from `crates/wasm-artifact-module`. */
const WA_OK = 0;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** A call into the artifact module that failed, carrying the module's message. */
export class WasmArtifactModuleError extends Error {
  constructor(operation: string, detail: string) {
    super(detail === "" ? `${operation} failed` : `${operation}: ${detail}`);
    this.name = "WasmArtifactModuleError";
  }
}

// State lives in `wasm-artifact-module-registry`, a module that imports
// nothing, so a loader registered by the side-effect import above cannot
// arrive before this file's own bindings exist. See that file for the
// temporal-dead-zone failure this avoids.
function readExports(): ArtifactModuleExports | null {
  return getInstalledModule() as ArtifactModuleExports | null;
}

/**
 * Instantiate the artifact-reader module.
 *
 * Accepts either the module bytes or an already-compiled `WebAssembly.Module`,
 * because Node has the bytes on hand and a browser worker may have compiled
 * them once for reuse. Idempotent: installing twice keeps the first instance,
 * so a host that installs at two entry points does not reset the module
 * underneath a caller.
 */
export function installWasmArtifactModule(
  source: BufferSource | WebAssembly.Module,
): void {
  if (readExports() !== null) return;
  const module = source instanceof WebAssembly.Module
    ? source
    : new WebAssembly.Module(source);
  // The module imports NOTHING — not even `env.memory` — so there is no import
  // object and no way for a host to accidentally widen its surface. That is
  // checked at build time by `crates/wasm-artifact-module/build-wasm.sh`; this
  // instantiation is what makes a regression there fail loudly here.
  const instance = new WebAssembly.Instance(module, {});
  const candidate = instance.exports as unknown as ArtifactModuleExports;
  if (
    typeof candidate.wa_read_facts !== "function"
    || typeof candidate.wa_wire_version !== "function"
    || !(candidate.memory instanceof WebAssembly.Memory)
  ) {
    throw new Error(
      "wasm-artifact module is missing its wa_* surface; rebuild "
        + "wasm_artifact_module32.wasm with "
        + "`scripts/dev-shell.sh bash crates/wasm-artifact-module/build-wasm.sh`.",
    );
  }
  const moduleWireVersion = candidate.wa_wire_version();
  if (moduleWireVersion !== WIRE_VERSION) {
    throw new Error(
      `wasm-artifact module speaks wire version ${moduleWireVersion}, but this `
        + `host decodes version ${WIRE_VERSION}. One of the two is stale; `
        + "rebuild wasm_artifact_module32.wasm with "
        + "`scripts/dev-shell.sh bash crates/wasm-artifact-module/build-wasm.sh`.",
    );
  }
  setInstalledModule(candidate);
}

/** Whether {@link installWasmArtifactModule} has run in this realm. */
export function wasmArtifactModuleInstalled(): boolean {
  return readExports() !== null;
}

/**
 * A host's synchronous way of obtaining the module's bytes on demand.
 *
 * Node has one: the resolved binary tier is a file read away, and registering a
 * loader means a Node entry point does not have to remember to install before
 * the first artifact is read. A browser worker has none — its bytes arrive over
 * `fetch` — so it calls {@link installWasmArtifactModule} at its own entry
 * instead. That asymmetry is a real difference between the hosts rather than a
 * Node-first convenience: it is the same reason `kernel.wasm` itself is read
 * synchronously on one host and fetched on the other.
 */
type WasmArtifactModuleLoader = () => BufferSource | WebAssembly.Module;

// See `wasm-artifact-module-registry`: the loader reference lives there.

/**
 * Register a synchronous source for the module's bytes.
 *
 * The loader is called at most once, on the first artifact read, so registering
 * it cannot itself trigger a file read or a resolver walk at import time — which
 * matters because the Node loader resolves through `binary-resolver.ts`, one of
 * this driver's own callers.
 */
export function setWasmArtifactModuleLoader(
  load: WasmArtifactModuleLoader,
): void {
  setModuleLoader(load);
}

/**
 * Forget the installed module.
 *
 * Exists for tests that need to exercise the uninstalled path. Production hosts
 * install once at their entry point and never uninstall.
 */
export function resetWasmArtifactModuleForTesting(): void {
  setInstalledModule(null);
  setModuleLoader(null);
}

function required(): ArtifactModuleExports {
  const registeredLoader = getModuleLoader();
  if (readExports() === null && registeredLoader !== null) {
    installWasmArtifactModule(registeredLoader());
  }
  const current = readExports();
  if (current === null) {
    throw new Error(
      "the wasm-artifact module has not been installed in this realm, so no "
        + "artifact can be read. A host entry point must call "
        + "installWasmArtifactModule() with the bytes of "
        + "wasm_artifact_module32.wasm before any artifact is validated. Build "
        + "it with `scripts/dev-shell.sh bash "
        + "crates/wasm-artifact-module/build-wasm.sh`.",
    );
  }
  return current;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Copy the artifact, and optionally a trailing payload, into the module's input
 * buffer.
 *
 * `wa_input_reserve` may grow the module's memory, so the view is taken AFTER
 * the call and never before.
 */
function writeInput(
  api: ArtifactModuleExports,
  artifact: Uint8Array,
  trailer?: Uint8Array,
): void {
  const total = artifact.byteLength + (trailer?.byteLength ?? 0);
  const address = api.wa_input_reserve(total);
  const view = new Uint8Array(api.memory.buffer, address, total);
  view.set(artifact, 0);
  if (trailer) view.set(trailer, artifact.byteLength);
}

/** A fresh copy of the module's answer bytes. */
function readOutput(api: ArtifactModuleExports): Uint8Array {
  const address = api.wa_output_ptr();
  const length = api.wa_output_len();
  return new Uint8Array(api.memory.buffer, address, length).slice();
}

/** The module's answer rendered as text, which is how it reports a failure. */
function readOutputText(api: ArtifactModuleExports): string {
  return TEXT_DECODER.decode(readOutput(api));
}

/** Normalize the several shapes callers hold their artifact bytes in. */
function asBytes(programBytes: ArrayBuffer | Uint8Array): Uint8Array {
  return programBytes instanceof Uint8Array
    ? programBytes
    : new Uint8Array(programBytes);
}

/** A little-endian reader over one of the module's answer blobs. */
class WireReader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array, operation: string) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = this.u32();
    if (version !== WIRE_VERSION) {
      throw new WasmArtifactModuleError(
        operation,
        `answer carries wire version ${version}, but this host decodes `
          + `version ${WIRE_VERSION}`,
      );
    }
  }

  #take(length: number): number {
    const start = this.#offset;
    if (start + length > this.#bytes.byteLength) {
      throw new WasmArtifactModuleError(
        "wasm-artifact answer",
        "is truncated; the module and this decoder disagree about the layout",
      );
    }
    this.#offset += length;
    return start;
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), true);
  }

  i32(): number {
    return this.#view.getInt32(this.#take(4), true);
  }

  u64(): bigint {
    return this.#view.getBigUint64(this.#take(8), true);
  }

  i64(): bigint {
    return this.#view.getBigInt64(this.#take(8), true);
  }

  string(): string {
    const length = this.u32();
    const start = this.#take(length);
    return TEXT_DECODER.decode(
      this.#bytes.subarray(start, start + length),
    );
  }

  strings(): string[] {
    const count = this.u32();
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(this.string());
    return out;
  }

  /** An optional `i32`: a presence byte, then the value, always written. */
  optionalI32(): number | null {
    const present = this.bool();
    const value = this.i32();
    return present ? value : null;
  }

  /** An optional `u64`: a presence byte, then the value, always written. */
  optionalU64(): bigint | null {
    const present = this.bool();
    const value = this.u64();
    return present ? value : null;
  }
}

/** A little-endian writer for the one request shape the module accepts. */
class WireWriter {
  #bytes: number[] = [];

  constructor() {
    this.u32(WIRE_VERSION);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }

  u8(value: number): void {
    this.#bytes.push(value & 0xff);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  u32(value: number): void {
    this.#bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }

  raw(value: Uint8Array): void {
    this.u32(value.byteLength);
    for (const byte of value) this.#bytes.push(byte);
  }

  string(value: string): void {
    this.raw(TEXT_ENCODER.encode(value));
  }

  strings(values: readonly string[]): void {
    this.u32(values.length);
    for (const value of values) this.string(value);
  }
}

// ---------------------------------------------------------------------------
// The reader's public shapes
// ---------------------------------------------------------------------------

export interface WasmValueType {
  /**
   * Leading binary opcode: a numeric type, a reference shorthand, or
   * `0x63`/`0x64` (`ref null ht` / `ref ht`) for the long form.
   *
   * The module emits a CANONICAL spelling. One reference type has two legal
   * encodings — `externref` (0x6F) and `ref null extern` (0x63 -0x11) — and the
   * original is not recoverable from a parsed module, so the reader picks one
   * consistently. Every predicate over this field accepts both spellings of one
   * type, which is why canonicalizing preserves meaning.
   */
  code: number;
  /** Signed heap type for the multi-byte `ref`/`ref null` forms. */
  heapType?: number;
  /** Whether a multi-byte reference uses the shared heap-type prefix. */
  shared: boolean;
}

export interface WasmFunctionSignature {
  readonly params: readonly number[];
  readonly results: readonly number[];
  /** Complete binary value types, including heap type and nullability. */
  readonly paramTypes: readonly WasmValueType[];
  /** Complete binary value types, including heap type and nullability. */
  readonly resultTypes: readonly WasmValueType[];
}

export interface WasmFunctionImportType {
  readonly module: string;
  readonly name: string;
  /** Ordinal among every import-section entry, regardless of import kind. */
  readonly importOrdinal: number;
  /** Function index assigned by the core Wasm index space. */
  readonly functionIndex: number;
  readonly signature: WasmFunctionSignature;
}

export type DecodedWasmExternalKind =
  | "function"
  | "table"
  | "memory"
  | "global"
  | "tag";

export interface DecodedWasmImportDescriptor {
  readonly module: string;
  readonly name: string;
  readonly kind: DecodedWasmExternalKind;
}

export interface DecodedWasmExportDescriptor {
  readonly name: string;
  readonly kind: DecodedWasmExternalKind;
}

/**
 * The binary-format kind byte, in the order the format assigns.
 *
 * Indexed by the module's `DescriptorKind::code()`, so a kind this host does
 * not know is a decoder/module disagreement rather than a silent "function".
 */
const EXTERNAL_KINDS: readonly DecodedWasmExternalKind[] = [
  "function",
  "table",
  "memory",
  "global",
  "tag",
];

function externalKind(code: number): DecodedWasmExternalKind {
  const kind = EXTERNAL_KINDS[code];
  if (kind === undefined) {
    throw new WasmArtifactModuleError(
      "wasm-artifact answer",
      `names external kind ${code}, which this host does not know`,
    );
  }
  return kind;
}

/** Everything one walk over the container established. */
export interface WasmArtifactFacts {
  readonly pointerWidth: 4 | 8;
  readonly abiVersion: number | null;
  readonly heapBase: bigint | null;
  readonly threadSlotDeclaration: number | null;
  readonly containsLegacyAsyncify: boolean;
  readonly importsKernelFork: boolean;
  readonly isRelocatable: boolean;
  /** An unlinked relocatable OBJECT: `linking` and/or `reloc.*` present. */
  readonly isRelocatableObject: boolean;
  readonly hasForkArtifactSurface: boolean;
  readonly customSectionNames: readonly string[];
  readonly importDescriptors: readonly DecodedWasmImportDescriptor[];
  readonly exportDescriptors: readonly DecodedWasmExportDescriptor[];
  readonly functionImports: readonly WasmFunctionImportType[];
  /** Type index of each function in the function index space, imports first. */
  readonly functionTypeIndices: readonly number[];
  /** `{ parameters, results }` per type index; `null` for non-function types. */
  readonly typeArities: readonly (
    { readonly parameters: number; readonly results: number } | null
  )[];
}

function readValueType(reader: WireReader): WasmValueType {
  const code = reader.u8();
  const hasHeapType = reader.bool();
  const heapType = reader.i64();
  const shared = reader.bool();
  return hasHeapType
    // The heap type is a signed LEB in the binary format: negative for the
    // abstract types and a non-negative type index for a concrete one. Both
    // fit a JavaScript number comfortably, so it is narrowed here rather than
    // pushed onto every consumer as a bigint.
    ? { code, heapType: Number(heapType), shared }
    : { code, shared };
}

/**
 * Read every fact about an artifact in one call.
 *
 * One call rather than several because the expensive part is the container
 * walk: a caller that asked five questions through five entry points would copy
 * the artifact and walk it five times.
 */
export function readWasmArtifactFacts(
  programBytes: ArrayBuffer | Uint8Array,
): WasmArtifactFacts {
  const api = required();
  const bytes = asBytes(programBytes);
  writeInput(api, bytes);
  if (api.wa_read_facts(bytes.byteLength) !== WA_OK) {
    throw new WasmArtifactModuleError("wa_read_facts", readOutputText(api));
  }
  const reader = new WireReader(readOutput(api), "wa_read_facts");

  const pointerWidth = reader.u8() === 8 ? 8 : 4;
  const abiVersion = reader.optionalI32();
  const heapBase = reader.optionalU64();
  const threadSlotDeclaration = reader.optionalI32();
  const containsLegacyAsyncify = reader.bool();
  const importsKernelFork = reader.bool();
  const isRelocatable = reader.bool();
  const isRelocatableObject = reader.bool();
  const hasForkArtifactSurface = reader.bool();

  const customSectionNames = reader.strings();

  const importCount = reader.u32();
  const importDescriptors: DecodedWasmImportDescriptor[] = [];
  for (let i = 0; i < importCount; i++) {
    const module = reader.string();
    const name = reader.string();
    importDescriptors.push({ module, name, kind: externalKind(reader.u8()) });
  }

  const exportCount = reader.u32();
  const exportDescriptors: DecodedWasmExportDescriptor[] = [];
  for (let i = 0; i < exportCount; i++) {
    const name = reader.string();
    exportDescriptors.push({ name, kind: externalKind(reader.u8()) });
  }

  const functionImportCount = reader.u32();
  const functionImports: WasmFunctionImportType[] = [];
  for (let i = 0; i < functionImportCount; i++) {
    const module = reader.string();
    const name = reader.string();
    const importOrdinal = reader.u32();
    const functionIndex = reader.u32();
    const paramCount = reader.u32();
    const paramTypes: WasmValueType[] = [];
    for (let p = 0; p < paramCount; p++) paramTypes.push(readValueType(reader));
    const resultCount = reader.u32();
    const resultTypes: WasmValueType[] = [];
    for (let r = 0; r < resultCount; r++) resultTypes.push(readValueType(reader));
    functionImports.push({
      module,
      name,
      importOrdinal,
      functionIndex,
      signature: {
        params: paramTypes.map((type) => type.code),
        results: resultTypes.map((type) => type.code),
        paramTypes,
        resultTypes,
      },
    });
  }

  const functionTypeIndexCount = reader.u32();
  const functionTypeIndices: number[] = [];
  for (let i = 0; i < functionTypeIndexCount; i++) {
    functionTypeIndices.push(reader.u32());
  }

  const typeArityCount = reader.u32();
  const typeArities: ({ parameters: number; results: number } | null)[] = [];
  for (let i = 0; i < typeArityCount; i++) {
    const present = reader.bool();
    const parameters = reader.u32();
    const results = reader.u32();
    typeArities.push(present ? { parameters, results } : null);
  }

  return {
    pointerWidth,
    abiVersion,
    heapBase,
    threadSlotDeclaration,
    containsLegacyAsyncify,
    importsKernelFork,
    isRelocatable,
    isRelocatableObject,
    hasForkArtifactSurface,
    customSectionNames,
    importDescriptors,
    exportDescriptors,
    functionImports,
    functionTypeIndices,
    typeArities,
  };
}

// ---------------------------------------------------------------------------
// The narrow questions
// ---------------------------------------------------------------------------

/**
 * Whether bytes open with a WebAssembly module header.
 *
 * Its own entry point rather than a fact, because it must answer for bytes that
 * are NOT a container at all — `exec` asks it before deciding whether it is
 * looking at a script or a program, and a shell script is an expected answer
 * here rather than a failure.
 */
export function isWasmModuleBytes(
  programBytes: ArrayBuffer | Uint8Array,
): boolean {
  const api = required();
  const bytes = asBytes(programBytes);
  writeInput(api, bytes);
  return api.wa_is_wasm_module(bytes.byteLength) !== 0;
}

/**
 * Whether an artifact is wasm32 (4) or wasm64 (8).
 *
 * This is the bootstrap floor: `kernel.ts` calls it to build the kernel's
 * import object before the kernel module is compiled. It answers from the
 * memory declarations alone, so it does not require the whole container to walk
 * cleanly, and a module with no memory is wasm32 — the default data model, and
 * a memory-less module has no pointers to disagree about.
 */
export function detectPtrWidth(
  programBytes: ArrayBuffer | Uint8Array,
): 4 | 8 {
  const api = required();
  const bytes = asBytes(programBytes);
  writeInput(api, bytes);
  return api.wa_detect_pointer_width(bytes.byteLength) === 8 ? 8 : 4;
}

/**
 * Custom-section name carrying the 32-byte ABI-contract digest
 * (`hash(abi/snapshot.json + ABI_VERSION)`) a wasm artifact was built against.
 *
 * Stamped by the local-build engine onto every program. The host reads the
 * kernel's own stamp at init and compares each guest's against it at exec, so a
 * structural ABI change cannot let a stale guest run against a mismatched
 * kernel even when the ABI version numbers coincide.
 */
export const ABI_CONTRACT_SECTION = "kandelo.abi.contract";

/**
 * The payload bytes of the first custom section named `name`, or `null` when
 * the artifact carries no such section.
 *
 * Absent and unreadable are deliberately distinct: an artifact with no
 * ABI-contract stamp is a documented rollout state the policy WARNS about,
 * while a request the module could not read is a defect.
 */
export function readWasmCustomSectionPayload(
  programBytes: ArrayBuffer | Uint8Array,
  name: string,
): Uint8Array | null {
  const api = required();
  const bytes = asBytes(programBytes);
  const nameBytes = TEXT_ENCODER.encode(name);
  writeInput(api, bytes, nameBytes);
  const status = api.wa_custom_section(bytes.byteLength, nameBytes.byteLength);
  if (status < 0) {
    throw new WasmArtifactModuleError("wa_custom_section", readOutputText(api));
  }
  return status === 1 ? readOutput(api) : null;
}

/**
 * The `__heap_base` export's value, or `null`.
 *
 * TOLERANT of an artifact that is not a readable container, matching every
 * other narrow question here: a caller asking for a heap base is asking
 * something with a legitimate "no", and a program with no `__heap_base` runs
 * perfectly well. Turning that into a thrown error would be a behaviour change
 * disguised as a refactor.
 */
export function readWasmHeapBase(
  programBytes: ArrayBuffer | Uint8Array,
): bigint | null {
  const api = required();
  const bytes = asBytes(programBytes);
  writeInput(api, bytes);
  if (api.wa_heap_base(bytes.byteLength) !== 1) return null;
  const answer = readOutput(api);
  return new DataView(
    answer.buffer,
    answer.byteOffset,
    answer.byteLength,
  ).getBigUint64(0, true);
}

/**
 * The value of a trivial `i32`-returning marker export, or `null`.
 *
 * Tolerant for the same reason, and a sharper one: absence means "this binary
 * predates the marker", which the policy treats as a documented rollout state
 * rather than a failure. A thrown error here would turn a legacy binary into a
 * crash instead of a warning.
 */
export function readWasmI32ConstExport(
  programBytes: ArrayBuffer | Uint8Array,
  exportName: string,
): number | null {
  const api = required();
  const bytes = asBytes(programBytes);
  const nameBytes = TEXT_ENCODER.encode(exportName);
  writeInput(api, bytes, nameBytes);
  if (api.wa_i32_const_export(bytes.byteLength, nameBytes.byteLength) !== 1) {
    return null;
  }
  const answer = readOutput(api);
  return new DataView(
    answer.buffer,
    answer.byteOffset,
    answer.byteLength,
  ).getInt32(0, true);
}

/**
 * Validate the complete ABI-epoch fork contract without compiling or running
 * the artifact.
 *
 * Shared by program admission and the dynamic linker so a side module cannot
 * defer a malformed reconstruction recipe until replay.
 */
export function describeWasmForkArtifactContractFailures(
  programBytes: ArrayBuffer | Uint8Array,
): string[] {
  const api = required();
  const bytes = asBytes(programBytes);
  writeInput(api, bytes);
  if (api.wa_fork_contract(bytes.byteLength) !== WA_OK) {
    throw new WasmArtifactModuleError("wa_fork_contract", readOutputText(api));
  }
  return new WireReader(readOutput(api), "wa_fork_contract").strings();
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** `require_fork_instrumentation`'s tri-state on the wire. */
const REQUIRE_FORK_FALSE = 0;
const REQUIRE_FORK_TRUE = 1;
const REQUIRE_FORK_AUTO = 2;

export interface WasmArtifactPolicyOptions {
  expectedAbi?: number | null;
  expectedAbiContractDigest?: Uint8Array | null;
  requiredExports?: readonly string[];
  forbiddenExports?: readonly string[];
  requireForkInstrumentation?: boolean;
  forbidForkInstrumentation?: boolean;
}

/** A policy verdict, separating hard failures from rollout warnings. */
export interface WasmArtifactPolicyReport {
  readonly failures: string[];
  readonly warnings: string[];
}

/**
 * Judge an artifact against a policy, returning failures and warnings apart.
 *
 * Warnings are returned rather than printed because whether a missing rollout
 * marker is worth a console line is a host decision.
 */
export function describeWasmArtifactPolicy(
  programBytes: ArrayBuffer | Uint8Array,
  options: WasmArtifactPolicyOptions = {},
): WasmArtifactPolicyReport {
  const api = required();
  const bytes = asBytes(programBytes);

  const request = new WireWriter();
  const expectedAbi = options.expectedAbi;
  const hasExpectedAbi = expectedAbi !== undefined && expectedAbi !== null;
  request.bool(hasExpectedAbi);
  request.u32(hasExpectedAbi ? expectedAbi : 0);

  const digest = options.expectedAbiContractDigest;
  const hasDigest = digest !== undefined && digest !== null;
  request.bool(hasDigest);
  request.raw(hasDigest ? digest : new Uint8Array(0));

  request.strings(options.requiredExports ?? []);
  request.strings(options.forbiddenExports ?? []);
  request.u8(
    options.requireForkInstrumentation === undefined
      ? REQUIRE_FORK_AUTO
      : options.requireForkInstrumentation
      ? REQUIRE_FORK_TRUE
      : REQUIRE_FORK_FALSE,
  );
  request.bool(options.forbidForkInstrumentation ?? false);

  const requestBytes = request.bytes();
  writeInput(api, bytes, requestBytes);
  if (api.wa_policy(bytes.byteLength, requestBytes.byteLength) !== WA_OK) {
    throw new WasmArtifactModuleError("wa_policy", readOutputText(api));
  }
  const reader = new WireReader(readOutput(api), "wa_policy");
  return { failures: reader.strings(), warnings: reader.strings() };
}
