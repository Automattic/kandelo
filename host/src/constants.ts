/**
 * Host constants, and the artifact-reader surface the rest of the host imports.
 *
 * # What this file used to be
 *
 * 3,041 lines: a complete hand-rolled WebAssembly binary reader — LEB128,
 * type/subtype/composite decode, instruction-immediate skipping,
 * import/export/custom-section descriptors — plus the whole ABI-epoch
 * fork-artifact contract. It was one of THREE readers of the same format in
 * this repository, and three readers of one format drift: this one validated
 * descriptor bytes the other two never looked at, while the native pair checked
 * memory pointer-width agreement this one reached only by another path. An
 * artifact could pass the gate that ran and fail the one that did not.
 *
 * All of it now lives in `crates/wasm-artifact`, judged once in Rust and shared
 * by the kernel, the native host and the build tooling; `host/src/wasm-artifact-driver.ts`
 * reaches it through a standalone zero-import wasm module. Two real defects
 * were fixed rather than ported on the way: a `readULEB128` that accumulated
 * with a 32-bit `|=`, so a section length at or above 2^31 read back negative,
 * and byte reads that ran past the end of the buffer.
 *
 * # What remains, and why
 *
 * Only two things:
 *
 * 1. **Process-memory and channel constants.** Generated ABI values with a
 *    host-facing name, plus `DEFAULT_MAX_WORKERS`, which is a host admission
 *    default rather than an ABI quantity.
 * 2. **Adapters over the reader.** Thin functions that ask
 *    `readWasmArtifactFacts` one question each, so the ~20 existing call sites
 *    keep their names. The one adapter with behaviour of its own is
 *    {@link describeWasmArtifactPolicyFailures}, which decides that a rollout
 *    warning is worth exactly one console line per worker — a host decision the
 *    `no_std` library deliberately does not make for it.
 *
 * Nothing here decodes a byte. If a change to this file would decide something
 * ABOUT an artifact, the decision belongs in `crates/wasm-artifact`.
 */

import {
  PROCESS_MEMORY_DEFAULT_MAX_PAGES,
  PROCESS_MEMORY_PAGES_PER_THREAD_SLOT,
  PROCESS_MEMORY_WASM_PAGE_SIZE,
  WPK_FORK_REQUIRED_EXPORTS,
} from "./generated/abi";
import {
  describeWasmArtifactPolicy,
  describeWasmForkArtifactContractFailures,
  readWasmArtifactFacts,
  type WasmArtifactFacts,
} from "./wasm-artifact-driver";

// ---------------------------------------------------------------------------
// Process memory and channel constants
// ---------------------------------------------------------------------------

/** WebAssembly page size (64 KiB). */
export const WASM_PAGE_SIZE = PROCESS_MEMORY_WASM_PAGE_SIZE;

export { CH_DATA_SIZE, CH_HEADER_SIZE, CH_TOTAL_SIZE } from "./generated/abi";

/** Default max pages for `WebAssembly.Memory`. */
export const DEFAULT_MAX_PAGES = PROCESS_MEMORY_DEFAULT_MAX_PAGES;

/**
 * Default process-worker admission input shared by Node and browser hosts.
 *
 * A host policy, not an ABI quantity: it bounds how many process workers a host
 * admits concurrently, and both hosts must pick the same default or the same
 * program behaves differently on each.
 */
export const DEFAULT_MAX_WORKERS = 4;

/**
 * Pages allocated per pthread slot: TLS/control, fork-save/scratch, syscall
 * channel primary, and syscall channel spill.
 */
export const PAGES_PER_THREAD = PROCESS_MEMORY_PAGES_PER_THREAD_SLOT;
export const PAGES_PER_THREAD_SLOT = PROCESS_MEMORY_PAGES_PER_THREAD_SLOT;

/**
 * Export set produced by `wasm-fork-instrument`.
 *
 * Any program that can reach `kernel.kernel_fork` must export all of these so
 * the host can unwind the parent and rewind the child at the fork point.
 */
export const WPK_FORK_EXPORTS = WPK_FORK_REQUIRED_EXPORTS.map(({ name }) => name);

// ---------------------------------------------------------------------------
// The artifact-reader surface
// ---------------------------------------------------------------------------

export {
  ABI_CONTRACT_SECTION,
  describeWasmForkArtifactContractFailures,
  detectPtrWidth,
  isWasmModuleBytes,
  readWasmArtifactFacts,
  readWasmCustomSectionPayload,
  type DecodedWasmExportDescriptor,
  type DecodedWasmExternalKind,
  type DecodedWasmImportDescriptor,
  type WasmArtifactFacts,
  type WasmFunctionImportType,
  type WasmFunctionSignature,
  type WasmValueType,
} from "./wasm-artifact-driver";

/**
 * Exact function-import identities, ordinals, and binary signatures.
 *
 * `WebAssembly.Module.imports()` omits function types. Fork-safe host-import
 * routing needs the artifact-declared signature so an owner descriptor cannot
 * accidentally reinterpret the same scalar words under a different type.
 */
export function readWasmFunctionImports(
  programBytes: ArrayBuffer,
): readonly WasmArtifactFacts["functionImports"][number][] {
  return readWasmArtifactFacts(programBytes).functionImports;
}

/** The exact parameter/result arity for one core function index. */
export function readWasmFunctionArity(
  programBytes: ArrayBuffer,
  functionIndex: number,
): Readonly<{ parameters: number; results: number }> | null {
  if (!Number.isSafeInteger(functionIndex) || functionIndex < 0) return null;
  const facts = readWasmArtifactFacts(programBytes);
  const typeIndex = facts.functionTypeIndices[functionIndex];
  if (typeIndex === undefined) return null;
  return facts.typeArities[typeIndex] ?? null;
}

/**
 * Every import name and kind in declaration order.
 *
 * Deliberately the artifact's own bytes rather than
 * `WebAssembly.Module.imports()`: release and resolver guards inspect binaries
 * built with newer Wasm features than the current JS engine can reflect, and
 * WebKit cannot currently produce descriptors for some valid exception-reference
 * imports.
 */
export function readWasmImportDescriptors(
  programBytes: ArrayBuffer,
): readonly WasmArtifactFacts["importDescriptors"][number][] {
  return readWasmArtifactFacts(programBytes).importDescriptors;
}

export function readWasmImportNames(programBytes: ArrayBuffer): string[] {
  return readWasmArtifactFacts(programBytes).importDescriptors.map(
    ({ module, name }) => `${module}.${name}`,
  );
}

/** Every export name and kind in declaration order. */
export function readWasmExportDescriptors(
  programBytes: ArrayBuffer,
): readonly WasmArtifactFacts["exportDescriptors"][number][] {
  return readWasmArtifactFacts(programBytes).exportDescriptors;
}

export function readWasmExportNames(programBytes: ArrayBuffer): string[] {
  return readWasmArtifactFacts(programBytes).exportDescriptors.map(
    ({ name }) => name,
  );
}

export function readWasmCustomSectionNames(programBytes: ArrayBuffer): string[] {
  return [...readWasmArtifactFacts(programBytes).customSectionNames];
}

/**
 * Whether the artifact carries the legacy Asyncify transform.
 *
 * WHY export names rather than a byte scan: this was
 * `containsAscii(bytes, "asyncify_")`, which flags any artifact that merely
 * *mentions* the string anywhere, including in its data section. It began
 * rejecting the kernel itself once `crates/wasm-artifact` — which carries that
 * literal in order to *detect* legacy instrumentation — was linked in, so the
 * host's own resolver refused to load the kernel. A module is
 * Asyncify-instrumented when it exports the transform's entry points; that is
 * the property, and a mention of it is not.
 */
export function wasmContainsLegacyAsyncify(programBytes: ArrayBuffer): boolean {
  return readWasmArtifactFacts(programBytes).containsLegacyAsyncify;
}

export function wasmImportsKernelFork(programBytes: ArrayBuffer): boolean {
  return readWasmArtifactFacts(programBytes).importsKernelFork;
}

export function wasmHasCompleteForkInstrumentation(
  programBytes: ArrayBuffer,
): boolean {
  try {
    const facts = readWasmArtifactFacts(programBytes);
    if (!facts.hasForkArtifactSurface) return false;
    return describeWasmForkArtifactContractFailures(programBytes).length === 0;
  } catch {
    return false;
  }
}

/**
 * Whether the artifact is an unlinked relocatable OBJECT.
 *
 * Distinct from a PIC side module, which is what the reader's `isRelocatable`
 * fact names: an object file carries `linking` and `reloc.*` sections and has
 * not been through `wasm-ld`, while a side module carries `dylink.0` and has.
 * Both are "relocatable" in ordinary speech and neither substitutes for the
 * other, so this asks the object-file question explicitly.
 */
export function wasmIsRelocatableObject(programBytes: ArrayBuffer): boolean {
  const names = readWasmArtifactFacts(programBytes).customSectionNames;
  return names.includes("linking")
    || names.some((name) => name.startsWith("reloc."));
}

/**
 * The `__heap_base` export's value, or `null` when the artifact does not export
 * it or its initializer is not a plain constant.
 *
 * The host calls `kernel_set_brk_base` with this before a new program's
 * `_start` runs, so `brk(0)` returns a value above the program's data and stack
 * region. A `bigint` because a wasm64 artifact's heap base does not fit a
 * JavaScript number's integer range.
 */
export function extractHeapBase(programBytes: ArrayBuffer): bigint | null {
  return readWasmArtifactFacts(programBytes).heapBase;
}

/** The artifact's declared ABI epoch, or `null` for a pre-marker binary. */
export function extractAbiVersion(programBytes: ArrayBuffer): number | null {
  return readWasmArtifactFacts(programBytes).abiVersion;
}

/**
 * A process-wasm pthread slot declaration.
 *
 * The SDK emits this as a constant-return export. A missing export means the
 * binary predates the declaration and should take the host default.
 */
export function extractThreadSlotDeclaration(
  programBytes: ArrayBuffer,
): number | null {
  return readWasmArtifactFacts(programBytes).threadSlotDeclaration;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Rollout warnings this worker has already printed.
 *
 * The library returns warnings rather than printing them, precisely so this
 * decision can be made here: a missing marker is worth saying once per worker,
 * not once per program load, and a host that logged every load would bury the
 * failures it is meant to surface.
 */
const warnedRolloutMessages = new Set<string>();

/**
 * Judge an artifact against the ABI epoch, returning only hard failures.
 *
 * Warnings are printed once per worker and do not appear in the returned list:
 * an artifact predating the `__abi_version` marker or the ABI-contract stamp is
 * a documented rollout state (`docs/abi-versioning.md`), not a policy failure.
 * Once every published binary carries both, those become hard failures in
 * `crates/wasm-artifact` and this function needs no change.
 */
export function describeWasmArtifactPolicyFailures(
  programBytes: ArrayBuffer,
  options: {
    expectedAbi?: number | null;
    expectedAbiContractDigest?: Uint8Array | null;
    requiredExports?: readonly string[];
    forbiddenExports?: readonly string[];
    requireForkInstrumentation?: boolean;
    forbidForkInstrumentation?: boolean;
  } = {},
): string[] {
  const report = describeWasmArtifactPolicy(programBytes, options);
  for (const warning of report.warnings) {
    if (warnedRolloutMessages.has(warning)) continue;
    warnedRolloutMessages.add(warning);
    console.warn(`[worker] ${warning}`);
  }
  return report.failures;
}
