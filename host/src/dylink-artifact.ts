/**
 * What a side-module ARTIFACT says about itself, independent of loading one.
 *
 * `dylink.0` metadata, the fork-instrument capability claim, and the
 * process-owned exception tags are properties of a compiled object and of the
 * process it will be linked into. They are read by the artifact-admission and
 * fork paths whether or not a `dlopen` ever happens, so they outlive
 * `host/src/dylink.ts` — the loader that used to house them now lives in
 * `crates/dylink`, and a Rust planner cannot be asked for a `WebAssembly.Tag`.
 *
 * Nothing here decides anything about linking. Placement, symbol scope, GOT
 * planning, dependency order and handle allocation are the planner's; this file
 * reads bytes and constructs two engine objects.
 *
 * The `dylink.0` reader is duplicated in `crates/dylink::metadata`, and
 * deliberately: the planner parses the section it links from, and this copy
 * answers the callers that only want to know what an artifact IS — the
 * admission checks, the package tooling, and the host package's public API. The
 * Rust one is authoritative for a load; a disagreement between them would show
 * up as a load the planner refuses and this reader accepted.
 */

import {
  ABI_VERSION,
  WPK_FORK_CAPABILITIES_SECTION,
  WPK_FORK_CAPABILITIES_VERSION,
  WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
  WPK_FORK_CAP_DYLINK_MAIN,
  WPK_FORK_CAP_KNOWN_MASK,
  WPK_FORK_CAP_SIDE_ENTRY,
  WPK_FORK_REQUIRED_EXPORTS,
} from "./generated/abi";

// dylink.0 sub-section types
const WASM_DYLINK_MEM_INFO = 1;
const WASM_DYLINK_NEEDED = 2;
const WASM_DYLINK_EXPORT_INFO = 3;
const WASM_DYLINK_IMPORT_INFO = 4;

// Export/import flags
const WASM_DYLINK_FLAG_TLS = 0x01;
const WASM_DYLINK_FLAG_WEAK = 0x02;

export const SIDE_MODULE_FORK_EXPORTS = WPK_FORK_REQUIRED_EXPORTS.map(
  ({ name }) => name,
);
const SIDE_MODULE_FORK_EXPORT_SET: ReadonlySet<string> =
  new Set(SIDE_MODULE_FORK_EXPORTS);

/**
 * Is this the name of a fork-instrument runtime export?
 *
 * These are activation-control machinery, not ELF-visible application symbols,
 * so `dlsym` must not hand one out. The planner enforces that; this copy serves
 * the artifact-admission callers that never load anything.
 */
export function isForkRuntimeExport(name: string): boolean {
  return SIDE_MODULE_FORK_EXPORT_SET.has(name);
}

export const FORK_CAPABILITIES_SECTION = WPK_FORK_CAPABILITIES_SECTION;
export const FORK_CAPABILITIES_VERSION = WPK_FORK_CAPABILITIES_VERSION;
export const FORK_CAP_SIDE_ENTRY = WPK_FORK_CAP_SIDE_ENTRY;
export const FORK_CAP_DYLINK_MAIN = WPK_FORK_CAP_DYLINK_MAIN;
export const FORK_CAP_ACTIVATION_STATE_SAFE = WPK_FORK_CAP_ACTIVATION_STATE_SAFE;
const FORK_CAP_KNOWN_MASK = WPK_FORK_CAP_KNOWN_MASK;
export const FORK_CAPABILITIES_REQUIRED_ABI = 17;

export interface ForkInstrumentCapabilityClaim {
  /** False for an ABI-16 artifact built before role markers were introduced. */
  present: boolean;
  flags: number;
}

/** Read and validate the explicit call-graph claims emitted by the tool. */
export function readForkInstrumentCapabilityClaim(
  module: WebAssembly.Module,
): ForkInstrumentCapabilityClaim {
  const sections = WebAssembly.Module.customSections(module, FORK_CAPABILITIES_SECTION);
  if (sections.length === 0) return { present: false, flags: 0 };
  if (sections.length !== 1) {
    throw new Error(`duplicate ${FORK_CAPABILITIES_SECTION} custom sections`);
  }
  const data = new Uint8Array(sections[0]!);
  if (data.length !== 2) {
    throw new Error(`malformed ${FORK_CAPABILITIES_SECTION} custom section`);
  }
  if (data[0] !== FORK_CAPABILITIES_VERSION) {
    throw new Error(
      `unsupported fork-instrument capability version ${data[0]}; ` +
        `expected ${FORK_CAPABILITIES_VERSION}`,
    );
  }
  if ((data[1]! & ~FORK_CAP_KNOWN_MASK) !== 0) {
    throw new Error(`unknown fork-instrument capability flags 0x${data[1]!.toString(16)}`);
  }
  return { present: true, flags: data[1]! };
}

/** Return just the validated flags for callers that do not need presence. */
export function readForkInstrumentCapabilities(module: WebAssembly.Module): number {
  return readForkInstrumentCapabilityClaim(module).flags;
}

/**
 * Decide whether an artifact may serve one fork-instrument role.
 *
 * ABI 16 predates role markers, so an absent section falls back to the legacy
 * five-export contract. ABI 17 makes the role claim mandatory. A marker that
 * is present is always authoritative, including during ABI 16 migration.
 */
export function forkInstrumentRoleAvailable(
  claim: ForkInstrumentCapabilityClaim,
  roleFlag: number,
  abiVersion: number = ABI_VERSION,
): boolean {
  if (claim.present) return (claim.flags & roleFlag) !== 0;
  return abiVersion < FORK_CAPABILITIES_REQUIRED_ABI;
}
export interface DylinkMetadata {
  /** Bytes of linear memory this module needs */
  memorySize: number;
  /** Memory alignment as power of 2 */
  memoryAlign: number;
  /** Number of indirect function table slots needed */
  tableSize: number;
  /** Table alignment as power of 2 */
  tableAlign: number;
  /** Dependent shared libraries (like ELF DT_NEEDED) */
  neededDynlibs: string[];
  /** Exports that are TLS-related */
  tlsExports: Set<string>;
  /** Imports that are weakly bound */
  weakImports: Set<string>;
}

/** Read a LEB128 unsigned integer from a DataView. */
function readVarUint(data: Uint8Array, offset: { value: number }): number {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = data[offset.value++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return result >>> 0; // Ensure unsigned
}

/** Read a UTF-8 string (length-prefixed) from a byte array. */
function readString(data: Uint8Array, offset: { value: number }): string {
  const len = readVarUint(data, offset);
  const bytes = data.subarray(offset.value, offset.value + len);
  offset.value += len;
  return new TextDecoder().decode(bytes);
}

/**
 * Parse the dylink.0 custom section from a Wasm binary.
 * Returns null if the section is not found.
 */
export function parseDylinkSection(wasmBytes: Uint8Array): DylinkMetadata | null {
  // Wasm magic + version = 8 bytes
  if (wasmBytes.length < 8) return null;
  if (wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 ||
      wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) {
    return null; // Not a Wasm binary
  }

  const offset = { value: 8 };

  // The dylink.0 section must be the very first section
  if (offset.value >= wasmBytes.length) return null;

  const sectionId = wasmBytes[offset.value++];
  if (sectionId !== 0) return null; // Must be a custom section (id=0)

  const sectionSize = readVarUint(wasmBytes, offset);
  const sectionEnd = offset.value + sectionSize;

  // Read custom section name
  const name = readString(wasmBytes, offset);
  if (name !== "dylink.0") return null;

  const metadata: DylinkMetadata = {
    memorySize: 0,
    memoryAlign: 0,
    tableSize: 0,
    tableAlign: 0,
    neededDynlibs: [],
    tlsExports: new Set(),
    weakImports: new Set(),
  };

  // Parse sub-sections
  while (offset.value < sectionEnd) {
    const subType = readVarUint(wasmBytes, offset);
    const subSize = readVarUint(wasmBytes, offset);
    const subEnd = offset.value + subSize;

    switch (subType) {
      case WASM_DYLINK_MEM_INFO:
        metadata.memorySize = readVarUint(wasmBytes, offset);
        metadata.memoryAlign = readVarUint(wasmBytes, offset);
        metadata.tableSize = readVarUint(wasmBytes, offset);
        metadata.tableAlign = readVarUint(wasmBytes, offset);
        break;

      case WASM_DYLINK_NEEDED: {
        const count = readVarUint(wasmBytes, offset);
        for (let i = 0; i < count; i++) {
          metadata.neededDynlibs.push(readString(wasmBytes, offset));
        }
        break;
      }

      case WASM_DYLINK_EXPORT_INFO: {
        const count = readVarUint(wasmBytes, offset);
        for (let i = 0; i < count; i++) {
          const symName = readString(wasmBytes, offset);
          const flags = readVarUint(wasmBytes, offset);
          if (flags & WASM_DYLINK_FLAG_TLS) {
            metadata.tlsExports.add(symName);
          }
        }
        break;
      }

      case WASM_DYLINK_IMPORT_INFO: {
        const count = readVarUint(wasmBytes, offset);
        for (let i = 0; i < count; i++) {
          const _module = readString(wasmBytes, offset);
          const field = readString(wasmBytes, offset);
          const flags = readVarUint(wasmBytes, offset);
          if (flags & WASM_DYLINK_FLAG_WEAK) {
            metadata.weakImports.add(field);
          }
        }
        break;
      }

      default:
        // Skip unknown sub-sections
        break;
    }

    offset.value = subEnd;
  }

  return metadata;
}

type TagConstructor = new (
  descriptor: { parameters: Array<"i32" | "i64"> },
) => WebAssembly.Tag;

function tagConstructor(): TagConstructor | undefined {
  return (WebAssembly as typeof WebAssembly & { Tag?: TagConstructor }).Tag;
}

/** Create the exception tag used by one process and all of its side modules. */
export function createLongjmpTag(ptrWidth: 4 | 8): WebAssembly.Tag | undefined {
  if (ptrWidth !== 4 && ptrWidth !== 8) {
    throw new TypeError(`invalid process pointer width ${String(ptrWidth)}`);
  }
  const Tag = tagConstructor();
  return Tag
    ? new Tag({ parameters: [ptrWidth === 8 ? "i64" : "i32"] })
    : undefined;
}

/** Create the process-owned C++ exception tag for the target pointer width. */
export function createCppExceptionTag(ptrWidth: 4 | 8): WebAssembly.Tag | undefined {
  if (ptrWidth !== 4 && ptrWidth !== 8) {
    throw new TypeError(`invalid process pointer width ${String(ptrWidth)}`);
  }
  const Tag = tagConstructor();
  return Tag
    ? new Tag({ parameters: [ptrWidth === 8 ? "i64" : "i32"] })
    : undefined;
}

/** Reject lookalike values before handing an exception-tag import to Wasm. */
export function requireLongjmpTag(value: unknown, context: string): WebAssembly.Tag {
  const Tag = tagConstructor();
  if (!Tag) {
    throw new Error(`${context}: this WebAssembly runtime does not support exception tags`);
  }
  if (!(value instanceof Tag)) {
    throw new TypeError(`${context}: __c_longjmp must be an actual WebAssembly.Tag`);
  }
  return value;
}

/** Reject lookalike values before handing the C++ tag import to Wasm. */
export function requireCppExceptionTag(value: unknown, context: string): WebAssembly.Tag {
  const Tag = tagConstructor();
  if (!Tag) {
    throw new Error(`${context}: this WebAssembly runtime does not support exception tags`);
  }
  if (!(value instanceof Tag)) {
    throw new TypeError(`${context}: __cpp_exception must be an actual WebAssembly.Tag`);
  }
  return value;
}
