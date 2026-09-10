/**
 * The dynamic linker's irreducible JavaScript floor: a session wrapper around
 * `crates/dylink-module`, and an executor for the eight acts wasm cannot
 * perform on itself.
 *
 * # Why this file is small, and what it is NOT allowed to grow into
 *
 * `host/src/dylink.ts` interleaves deterministic linker computation with the
 * JS-API calls that realize it, and that interleaving is what makes the whole
 * 4,188-line file TypeScript. The planner separates the two: it decides, and it
 * emits a `PlanStep` naming the one engine operation it needs performed.
 *
 * So everything here is transport or an engine act. There is no ELF policy, no
 * relocation arithmetic, no symbol scope, no GOT placement, no dependency
 * ordering and no handle allocation in this file, and none may be added: if a
 * change here would encode a linker DECISION, the decision belongs in
 * `crates/dylink`, where it is unit-testable with plain `cargo test` and shared
 * with the native executor that has no JavaScript at all.
 *
 * The eight acts, enumerated by walking all 16 JS-API call sites in
 * `dylink.ts` (`docs/plans/2026-09-09-k5-dynamic-linker-grounding.md` §2.1):
 *
 * | act | JS API |
 * |---|---|
 * | `compile` | `new WebAssembly.Module` |
 * | `newGlobal` | `new WebAssembly.Global` |
 * | `readGlobal` / `writeGlobal` | `Global.value` get / set |
 * | `growTable` / `writeTable` | `Table.grow` / `Table.set` |
 * | `growMemory` | `Memory.grow` |
 * | `newTag` | `new WebAssembly.Tag` |
 * | `instantiate` | import object + `new WebAssembly.Instance` |
 *
 * `readExports` and `zeroMemory` ride the same queue because they are ordered
 * against those acts, not because they are JS-API object constructions.
 *
 * # The ordered-binding invariant
 *
 * `wasm-ld` can emit two import entries with the same `(module, name)`, and the
 * JS API resolves imports in DECLARATION order, calling `Get` once per entry.
 * A name-keyed import object would collapse the duplicates and bind the wrong
 * provider. `LinkAct.instantiate` therefore carries one binding per
 * declaration, in order, and {@link buildImportObject} hands them back through
 * a counting `Proxy` — the ordering is explicit data here, not an emergent
 * property of proxy traps as it is in `dylink.ts:1785-1888`.
 *
 * # The memory contract, which a driver WILL get wrong once
 *
 * Every `dl_*` entry point may allocate, and allocating may `memory.grow`,
 * which detaches every existing `ArrayBuffer` view. So every view of the
 * planner's memory is acquired fresh, immediately before use, and never held
 * across a call. {@link PlannerSession} is the only place that touches it.
 */

import {
  decodeCloseOutcome,
  decodePlanStep,
  encodeActResult,
  encodeLinkerConfig,
  encodeLoadRequest,
  encodeMainImage,
  encodeTablePatches,
  type ActResult,
  type CloseOutcome,
  type DylinkTablePatch,
  type ExternKind,
  type HostRequest,
  type ImportBinding,
  type InstanceExport,
  type LinkAct,
  type LinkerConfig,
  type LoadRequest,
  type MainImage,
  type PlanStep,
  type ValType,
  type WasmValue,
} from "./dylink-planner-wire";

/** `DL_OK` / `DL_ERROR` from `crates/dylink-module`. */
const DL_OK = 0;

/** The reserved `dlopen(NULL, ...)` handle. Mirrors `MAIN_PROGRAM_HANDLE`. */
export const MAIN_PROGRAM_HANDLE = 1;

/** The exports `crates/dylink-module` provides. */
interface PlannerExports {
  readonly memory: WebAssembly.Memory;
  readonly dl_input_reserve: (len: number) => number;
  readonly dl_output_ptr: () => number;
  readonly dl_output_len: () => number;
  readonly dl_error: () => number;
  readonly dl_configure: (len: number) => number;
  readonly dl_reset: () => void;
  readonly dl_publish_main_image: (len: number) => number;
  readonly dl_adopt_process_tags: (longjmp: number, cppException: number) => number;
  readonly dl_open_begin: (len: number) => number;
  readonly dl_step: (token: number) => number;
  readonly dl_resume: (token: number, len: number) => number;
  readonly dl_open_finish: (token: number, replayHandle: number) => number;
  readonly dl_abort: (token: number) => number;
  readonly dl_discard: (token: number) => void;
  readonly dl_pending: (token: number) => number;
  readonly dl_finished: (token: number) => number;
  readonly dl_note_staged_slot: (token: number, tableIndex: bigint) => number;
  readonly dl_plan_instance: (token: number) => bigint;
  readonly dl_plan_memory_base: (token: number) => bigint;
  readonly dl_plan_table_base: (token: number) => bigint;
  readonly dl_plan_tls_base: (token: number) => bigint;
  readonly dl_plan_activation: (token: number) => bigint;
  readonly dl_sym_begin: (handle: number, len: number) => number;
  readonly dl_sym_address: (token: number) => bigint;
  readonly dl_close_begin: (handle: number) => number;
  readonly dl_close_result: (token: number) => number;
  readonly dl_archive_read_begin: (head: bigint, memoryLen: bigint) => number;
  readonly dl_archive_read_finish: (token: number) => number;
  readonly dl_archive_sync_begin: () => number;
  readonly dl_archive_sync_finish: (token: number) => number;
  readonly dl_archive_is_empty: () => number;
  readonly dl_archive_generation: (token: number) => bigint;
  readonly dl_archive_set_table_patches: (len: number) => number;
  readonly dl_archive_set_table_state_root: (root: bigint) => number;
  readonly dl_archive_append_table_patch: (len: number) => number;
  readonly dl_archive_can_append_table_patch: (len: number) => number;
  readonly dl_archive_table_state: () => number;
  readonly dl_archive_modules: () => number;
  readonly dl_fork_reconcile_begin: (borrowed: number) => number;
  readonly dl_fork_reconcile_finish: (token: number) => number;
}

/**
 * A `WebAssembly.Table` addressed at its own index width.
 *
 * A `table64` — which a `wasm64posix` process has — takes and returns `BigInt`
 * indices, and passing it a `number` throws "Cannot convert 1 to a BigInt". The
 * width is discovered from the table itself rather than assumed from the
 * process pointer width, because the two are separate declarations and an
 * artifact is free to disagree with its host's expectation. The planner speaks
 * in `u64` throughout; this is the one place the JS API's width shows.
 */
interface AddressedTable {
  readonly length: number | bigint;
  grow(delta: number | bigint): number | bigint;
  get(index: number | bigint): unknown;
  set(index: number | bigint, value: Function | null): void;
}

function tableIndex(table: WebAssembly.Table, value: number): number | bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`dylink: table index ${value} is not an exact non-negative integer`);
  }
  return typeof (table as unknown as AddressedTable).length === "bigint"
    ? BigInt(value)
    : value;
}

/** The table's current length, as an exact JavaScript integer. */
export function tableLength(table: WebAssembly.Table): number {
  const raw = (table as unknown as AddressedTable).length;
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw new RangeError("dylink: table length exceeds JavaScript's exact integer range");
  }
  return length;
}

/** Grow the table, returning the length BEFORE the growth. */
export function growTable(table: WebAssembly.Table, delta: number): number {
  const before = (table as unknown as AddressedTable).grow(tableIndex(table, delta));
  const length = Number(before);
  if (!Number.isSafeInteger(length)) {
    throw new RangeError("dylink: table length exceeds JavaScript's exact integer range");
  }
  return length;
}

export function setTableEntry(
  table: WebAssembly.Table,
  index: number,
  value: Function | null,
): void {
  (table as unknown as AddressedTable).set(tableIndex(table, index), value);
}

export function getTableEntry(table: WebAssembly.Table, index: number): unknown {
  return (table as unknown as AddressedTable).get(tableIndex(table, index));
}

/** A planner call that failed, carrying the module's own `dlerror` text. */
export class DylinkPlannerError extends Error {
  constructor(operation: string, detail: string) {
    super(detail === "" ? `${operation} failed` : `${operation}: ${detail}`);
    this.name = "DylinkPlannerError";
  }
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * One process's planner session.
 *
 * Every method is a typed call into the module: encode the request, reserve,
 * write, call, check the status, read the answer. Nothing here interprets what
 * it carries.
 */
export class PlannerSession {
  readonly #exports: PlannerExports;

  private constructor(exports: PlannerExports) {
    this.#exports = exports;
  }

  /**
   * Instantiate the planner module.
   *
   * The module imports NOTHING — not even `env.memory` — so there is no import
   * object and no way for a host to accidentally widen its surface. That is
   * checked at build time by `crates/dylink-module/build-wasm.sh`; this
   * instantiation is what makes a regression there fail loudly here.
   */
  static instantiate(module: WebAssembly.Module): PlannerSession {
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as PlannerExports;
    if (typeof exports.dl_configure !== "function" || !(exports.memory instanceof WebAssembly.Memory)) {
      throw new Error(
        "dylink planner module is missing its dl_* surface; rebuild dylink_module32.wasm",
      );
    }
    return new PlannerSession(exports);
  }

  /**
   * Copy a request into the module's input buffer.
   *
   * `dl_input_reserve` may grow the module's memory, so the view is taken
   * AFTER the call and never before.
   */
  #write(bytes: Uint8Array): number {
    const address = this.#exports.dl_input_reserve(bytes.length);
    new Uint8Array(this.#exports.memory.buffer, address, bytes.length).set(bytes);
    return bytes.length;
  }

  /** A fresh copy of the module's answer bytes. */
  #output(): Uint8Array {
    const address = this.#exports.dl_output_ptr();
    const length = this.#exports.dl_output_len();
    return new Uint8Array(this.#exports.memory.buffer, address, length).slice();
  }

  /**
   * The pending `dlerror` message, consumed as POSIX requires.
   *
   * This is also how a failed call reports itself: the module never flattens a
   * planner error into a zero or an empty answer, so a caller that ignores the
   * status would be ignoring a real failure.
   */
  takeError(): string | null {
    const length = this.#exports.dl_error();
    if (length === 0) return null;
    return TEXT_DECODER.decode(this.#output());
  }

  #require(status: number, operation: string): void {
    if (status === DL_OK) return;
    throw new DylinkPlannerError(operation, this.takeError() ?? "");
  }

  configure(config: LinkerConfig): void {
    const length = this.#write(encodeLinkerConfig(config));
    this.#require(this.#exports.dl_configure(length), "dl_configure");
  }

  reset(): void {
    this.#exports.dl_reset();
  }

  publishMainImage(image: MainImage): void {
    const length = this.#write(encodeMainImage(image));
    this.#require(this.#exports.dl_publish_main_image(length), "dl_publish_main_image");
  }

  /**
   * Adopt the process's existing exception tags under the ids this side has
   * bound them to. `null` for a tag the process does not have.
   */
  adoptProcessTags(longjmp: number | null, cppException: number | null): void {
    this.#require(
      this.#exports.dl_adopt_process_tags(longjmp ?? -1, cppException ?? -1),
      "dl_adopt_process_tags",
    );
  }

  /**
   * Begin a `dlopen`. Returns the transaction token to drive.
   *
   * A second concurrent begin is a NESTED load, not a refusal: a constructor
   * calling `dlopen` is legal POSIX. The module's token map is the authority on
   * which loads are live, which is why this driver keeps none of its own.
   */
  openBegin(request: LoadRequest): number {
    const length = this.#write(encodeLoadRequest(request));
    return this.#token(this.#exports.dl_open_begin(length), "dl_open_begin");
  }

  step(token: number): PlanStep {
    this.#require(this.#exports.dl_step(token), "dl_step");
    return decodePlanStep(this.#output());
  }

  resume(token: number, result: ActResult): void {
    const length = this.#write(encodeActResult(result));
    this.#require(this.#exports.dl_resume(token, length), "dl_resume");
  }

  /**
   * Complete the load. `replayHandle` pins a fork parent's exact handle; pass
   * -1 for an ordinary load.
   */
  openFinish(token: number, replayHandle = -1): number {
    const handle = this.#exports.dl_open_finish(token, replayHandle);
    if (handle < 0) {
      throw new DylinkPlannerError("dl_open_finish", this.takeError() ?? "");
    }
    return handle;
  }

  /**
   * Abandon the transaction in flight and re-arm the SAME drive loop with its
   * rollback. Returns the table range to reclaim, when there is one.
   */
  abort(token: number): { readonly firstIndex: bigint; readonly length: bigint } | null {
    this.#require(this.#exports.dl_abort(token), "dl_abort");
    const bytes = this.#output();
    if (bytes.length === 0 || bytes[0] === 0) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { firstIndex: view.getBigUint64(1, true), length: view.getBigUint64(9, true) };
  }

  /** Forget a transaction whose rollback has drained. */
  discard(token: number): void {
    this.#exports.dl_discard(token);
  }

  /** Is `token` a live transaction? */
  pending(token: number): boolean {
    return this.#exports.dl_pending(token) === 1;
  }

  /**
   * Has `token`'s drive loop reached `finished`?
   *
   * A transaction whose staged initializer is still outstanding is not a FAILED
   * transaction — it is one the guest has not finished driving. Committing it
   * early is a misuse, and rolling back on that mistake would destroy a
   * `dlopen` that was going to succeed.
   */
  finished(token: number): boolean {
    return this.#exports.dl_finished(token) === 1;
  }

  /**
   * Tell the module where the staged `() -> ()` entry was published.
   *
   * The slot is an engine fact only this side has, and a fork child needs it to
   * resume an interrupted `dlopen` at the exact continuation point.
   */
  noteStagedSlot(token: number, tableIndex: bigint): void {
    this.#require(
      this.#exports.dl_note_staged_slot(token, tableIndex),
      "dl_note_staged_slot",
    );
  }

  /** The layout the plan chose, for the caller that has to record it. */
  planLayout(token: number): {
    readonly instance: number;
    readonly memoryBase: bigint;
    readonly tableBase: bigint;
    readonly tlsBase: bigint | null;
    readonly activationId: number | null;
  } {
    const optional = (value: bigint): bigint | null => (value < 0n ? null : value);
    const tls = optional(this.#exports.dl_plan_tls_base(token));
    const activation = optional(this.#exports.dl_plan_activation(token));
    return {
      instance: Number(this.#exports.dl_plan_instance(token)),
      memoryBase: this.#exports.dl_plan_memory_base(token),
      tableBase: this.#exports.dl_plan_table_base(token),
      tlsBase: tls,
      activationId: activation === null ? null : Number(activation),
    };
  }

  /**
   * Begin a `dlsym`. Returns the transaction token to drive, after which
   * {@link symAddress} reports the answer.
   *
   * A transaction rather than a plain call because a resolved function may have
   * no indirect-function-table slot yet, and taking one is a table mutation
   * only this side can perform. A C function pointer IS that index.
   */
  symBegin(handle: number, name: string): number {
    const length = this.#write(TEXT_ENCODER.encode(name));
    return this.#token(this.#exports.dl_sym_begin(handle, length), "dl_sym_begin");
  }

  /**
   * The resolved address, or `null` for a miss.
   *
   * A miss is a SUCCESSFUL call: POSIX reports it through `dlerror`, and
   * conflating the two would make a legitimately absent weak symbol
   * indistinguishable from a broken lookup.
   */
  symAddress(token: number): bigint | null {
    const address = this.#exports.dl_sym_address(token);
    if (address === -1n) return null;
    if (address < 0n) {
      throw new DylinkPlannerError("dl_sym_address", this.takeError() ?? "");
    }
    return address;
  }

  /** Begin a `dlclose`. Returns the transaction token to drive. */
  closeBegin(handle: number): number {
    return this.#token(this.#exports.dl_close_begin(handle), "dl_close_begin");
  }

  /** What the `dlclose` did. */
  closeResult(token: number): CloseOutcome {
    this.#require(this.#exports.dl_close_result(token), "dl_close_result");
    return decodeCloseOutcome(this.#output());
  }

  /**
   * Read the process archive whose header is at `head` into the module.
   *
   * `head` of zero is a process that has never published, which decodes to
   * nothing rather than to an error.
   */
  archiveReadBegin(head: bigint, memoryLen: bigint): number {
    return this.#token(
      this.#exports.dl_archive_read_begin(head, memoryLen),
      "dl_archive_read_begin",
    );
  }

  archiveReadFinish(token: number): void {
    this.#require(this.#exports.dl_archive_read_finish(token), "dl_archive_read_finish");
  }

  /** Publish the loader's current state into the process archive. */
  archiveSyncBegin(): number {
    return this.#token(this.#exports.dl_archive_sync_begin(), "dl_archive_sync_begin");
  }

  /** The head address and generation the sync published. */
  archiveSyncFinish(token: number): { readonly head: bigint; readonly generation: bigint } {
    this.#require(this.#exports.dl_archive_sync_finish(token), "dl_archive_sync_finish");
    const bytes = this.#output();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { head: view.getBigUint64(0, true), generation: view.getBigUint64(8, true) };
  }

  /** Does the decoded archive describe a process that ever loaded anything? */
  archiveIsEmpty(): boolean {
    return this.#exports.dl_archive_is_empty() === 1;
  }

  /** The generation of the archive the last read decoded. */
  archiveGeneration(): bigint {
    return this.#exports.dl_archive_generation(0);
  }

  /**
   * Hand the activation coordinator's funcref table patches to the archive.
   * They are not loader state, but they ride in the same record chain under the
   * same generation fence, so publishing them is publishing the archive.
   */
  setTablePatches(patches: readonly DylinkTablePatch[]): void {
    const length = this.#write(encodeTablePatches(patches));
    this.#require(
      this.#exports.dl_archive_set_table_patches(length),
      "dl_archive_set_table_patches",
    );
  }

  /**
   * The archive's table-replication state, still encoded.
   *
   * This is the only part of the archive that crosses back: the funcref table
   * replica is the one consumer that is not the loader. Modules and
   * transactions never cross, because a reconcile drives them from inside.
   */
  tableStateBytes(): Uint8Array {
    this.#require(this.#exports.dl_archive_table_state(), "dl_archive_table_state");
    return this.#output();
  }

  /** The archived objects a fork child names before it reconciles. */
  archivedModulesBytes(): Uint8Array {
    this.#require(this.#exports.dl_archive_modules(), "dl_archive_modules");
    return this.#output();
  }

  /** Would the patch journal accept this patch, or must it be compacted? */
  canAppendTablePatch(patch: DylinkTablePatch): boolean {
    return this.#appendTablePatch(patch, true);
  }

  /** Append one funcref patch to the journal the next publication carries. */
  appendTablePatch(patch: DylinkTablePatch): boolean {
    return this.#appendTablePatch(patch, false);
  }

  #appendTablePatch(patch: DylinkTablePatch, probeOnly: boolean): boolean {
    const length = this.#write(encodeTablePatches([patch]));
    const status = probeOnly
      ? this.#exports.dl_archive_can_append_table_patch(length)
      : this.#exports.dl_archive_append_table_patch(length);
    if (status < 0) {
      throw new DylinkPlannerError("dl_archive_append_table_patch", this.takeError() ?? "");
    }
    return status === 1;
  }

  /** Seal a typed table snapshot; patches before a checkpoint are superseded. */
  setTableStateRoot(root: bigint): void {
    this.#require(
      this.#exports.dl_archive_set_table_state_root(root),
      "dl_archive_set_table_state_root",
    );
  }

  /** Begin a fork reconcile against the archive the last read decoded. */
  forkReconcileBegin(borrowed: boolean): number {
    return this.#token(
      this.#exports.dl_fork_reconcile_begin(borrowed ? 1 : 0),
      "dl_fork_reconcile_begin",
    );
  }

  forkReconcileFinish(token: number): void {
    this.#require(this.#exports.dl_fork_reconcile_finish(token), "dl_fork_reconcile_finish");
  }

  /** A transaction token, or the module's own diagnostic. */
  #token(value: number, operation: string): number {
    if (value > 0) return value;
    throw new DylinkPlannerError(operation, this.takeError() ?? "");
  }
}

// ---------------------------------------------------------------------------
// The engine environment and the host side
// ---------------------------------------------------------------------------

/**
 * The process's engine objects, which only the process can supply.
 *
 * Deliberately narrow: the planner asks for these by TAG, never by inspecting
 * them, so this is the whole of what an executor needs to know about the guest.
 */
export interface DylinkEngineEnvironment {
  readonly memory: WebAssembly.Memory;
  /**
   * The process's indirect function table and stack pointer, resolved lazily.
   *
   * A loader exists before the main image does: a fork child reads the archive
   * it inherited before it has instantiated anything. Taking these eagerly made
   * that read fail with "program has no table or stack pointer", which named
   * the wrong thing entirely — the read needs neither.
   */
  readonly table: () => WebAssembly.Table;
  readonly stackPointer: () => WebAssembly.Global;
  /** The main image, bound at `InstanceId` 0. */
  readonly mainInstance: () => WebAssembly.Instance | undefined;
  /**
   * A value owned by the process fork-activation coordinator: `fork`, the
   * `__wpk_fork_*` entry points, the private unwind tag, and the
   * frame/reference/exception/GC imports. The planner binds these by name and
   * never inspects them; ownership stays with the fork side.
   */
  readonly activationEnv: (name: string) => unknown;
  /**
   * One synchronous wrapper boundary for the process activation owner, applied
   * to the import object immediately before instantiation.
   *
   * Imported global and table identity is observable only while WebAssembly is
   * resolving this exact proxy graph, so the owner is handed the graph rather
   * than an enumeration of it: enumerating would collapse duplicate
   * `(module, name)` declarations and capture the wrong provider.
   */
  readonly wrapImports?: (imports: WebAssembly.Imports) => WebAssembly.Imports;
  /**
   * Route one resolved FUNCTION import through the process Worker owner.
   *
   * Called at the moment the binding is resolved, so duplicate declarations and
   * activation-owned exception identities are not collapsed. `occurrence` is
   * which read of this `(module, name)` pair this is, counting from zero.
   */
  readonly routeFunctionImport?: (
    library: string,
    module: string,
    name: string,
    occurrence: number,
    value: CallableFunction,
  ) => unknown;
}

/**
 * Work the process host performs that is not an engine act: address-space
 * allocation on the syscall channel, mapping ownership, fork-activation
 * lifecycle, and table-mutation journalling.
 */
export interface DylinkProcessHost {
  allocateMemory(library: string, size: bigint, align: bigint): bigint;
  adoptMapping(library: string, allocation: AllocationRecord): void;
  releaseMapping(library: string, allocation: AllocationRecord): void;
  prepareActivation(library: string, replayActivationId: number | undefined): number;
  registerActivation(library: string, activation: number, instance: number): void;
  unregisterActivation(library: string, activation: number): void;
  journalTableMutation(firstIndex: bigint, length: bigint): void;
  /**
   * Read one `DT_NEEDED` search-path candidate: `openat`/`read`/`close` and
   * nothing else. `null` means the file does not exist, which the planner
   * answers by trying the next candidate ITSELF. Which paths are tried, in what
   * order, and what a miss means are ELF search semantics and are not decided
   * here.
   */
  readDependency(library: string, path: string): Uint8Array | null;
  /** Read one byte range of the process archive out of guest memory. */
  readArchive(address: bigint, length: bigint): Uint8Array;
  /** Allocate one archive record block; returns its address. */
  allocateArchive(size: bigint): bigint;
  /** Copy record bytes into a block already obtained. */
  writeArchive(address: bigint, bytes: Uint8Array): void;
  /**
   * Store the archive's generation as ONE aligned 8-byte write.
   *
   * It is the publication fence a pthread peer consumes: every reachable record
   * is complete before it lands, and it must land atomically rather than as the
   * tail of a header copy.
   */
  publishGeneration(address: bigint, generation: bigint): void;
  /** Release an archive block that is no longer reachable. */
  releaseArchive(address: bigint, size: bigint): void;
  /**
   * The parent's saved `GOT.func` value for one symbol, during fork replay.
   *
   * A funcref's identity in a child must match the parent's exactly: the guest
   * holds table indexes in copied memory, so re-deriving one would aim a live
   * function pointer at a different function.
   */
  savedGotFunc(library: string, symbol: string): bigint;
}

export interface AllocationRecord {
  readonly address: bigint;
  readonly size: bigint;
  readonly mappingAddress: bigint;
  readonly mappingSize: bigint;
}

/**
 * `WebAssembly.Module` takes a `BufferSource`, which excludes a
 * SharedArrayBuffer-backed view.
 *
 * A `.so` image reaching this executor has already been copied off guest
 * memory — compilation can grow and detach that memory, so a live view into it
 * could not be used here anyway — but the type cannot see that. Copying only
 * when the backing store is genuinely shared keeps the common path free and
 * keeps the constraint visible instead of hiding it behind a cast.
 */
function asModuleSource(bytes: Uint8Array): BufferSource {
  const buffer = bytes.buffer;
  return buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

function valTypeName(ty: ValType): WebAssembly.ValueType {
  switch (ty.kind) {
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f32":
      return "f32";
    case "f64":
      return "f64";
    case "opaque":
      // A reference type the planner records but never constructs. Reaching
      // here means a module declared a global the loader cannot make, which is
      // a real boundary rather than something to substitute a value for.
      throw new Error(
        `dylink: cannot construct a global of opaque value type 0x${ty.byte.toString(16)}`,
      );
  }
}

function wasmValueToJs(value: WasmValue): number | bigint {
  return value.kind === "i32" ? value.value : value.value;
}

function jsToWasmValue(value: unknown, ty: ValType): WasmValue {
  if (ty.kind === "i64") {
    if (typeof value !== "bigint") {
      throw new TypeError("dylink: an i64 global did not read back as a bigint");
    }
    return { kind: "i64", value: BigInt.asUintN(64, value) };
  }
  if (typeof value !== "number") {
    throw new TypeError("dylink: an i32 global did not read back as a number");
  }
  return { kind: "i32", value: value >>> 0 };
}

/**
 * Build the import object for one `instantiate` act.
 *
 * The bindings arrive one per DECLARATION, in order. Each namespace gets a
 * `Proxy` whose `get` pops the next binding queued for that name, so two
 * import entries with the same `(module, name)` receive the first and second
 * bindings respectively — the behaviour `wasm-ld` output depends on and the
 * reason a plain object cannot be used here.
 */
export function buildImportObject(
  bindings: readonly ImportBinding[],
  resolve: (binding: ImportBinding) => unknown,
): WebAssembly.Imports {
  const namespaces = new Map<string, Map<string, unknown[]>>();
  for (let position = 0; position < bindings.length; position++) {
    const binding = bindings[position]!;
    if (binding.position !== position) {
      // The ordinal is restated on the wire precisely so a mis-ordered
      // executor is a detectable bug rather than a silent mis-binding.
      throw new RangeError(
        `dylink import binding ${position} claims position ${binding.position}`,
      );
    }
    let namespace = namespaces.get(binding.module);
    if (!namespace) {
      namespace = new Map();
      namespaces.set(binding.module, namespace);
    }
    let queue = namespace.get(binding.name);
    if (!queue) {
      queue = [];
      namespace.set(binding.name, queue);
    }
    queue.push(resolve(binding));
  }

  const imports: WebAssembly.Imports = {};
  for (const [module, namespace] of namespaces) {
    const cursors = new Map<string, number>();
    imports[module] = new Proxy(
      {},
      {
        has: (_target, property) =>
          typeof property === "string" && namespace.has(property),
        get: (_target, property) => {
          if (typeof property !== "string") return undefined;
          const queue = namespace.get(property);
          if (!queue) return undefined;
          const cursor = cursors.get(property) ?? 0;
          if (cursor >= queue.length) {
            throw new RangeError(
              `dylink: ${module}.${property} was read more times than it was declared`,
            );
          }
          cursors.set(property, cursor + 1);
          return queue[cursor];
        },
      },
    ) as WebAssembly.ModuleImports;
  }
  return imports;
}

/**
 * The eight acts, and nothing else.
 *
 * The executor holds the engine objects the planner refers to by opaque id and
 * performs exactly the operation each act names. It has no view of what a load
 * is for, in what order objects must be linked, or what a symbol means.
 */
export class DylinkActExecutor {
  readonly #environment: DylinkEngineEnvironment;
  readonly #host: DylinkProcessHost;
  readonly #pointerWidth: 4 | 8;
  readonly #modules = new Map<number, WebAssembly.Module>();
  readonly #instances = new Map<number, WebAssembly.Instance>();
  readonly #globals = new Map<number, WebAssembly.Global>();
  readonly #tags = new Map<number, WebAssembly.Tag>();
  /**
   * Every image this executor holds, by library name.
   *
   * `ModuleSource.original` carries no bytes on the wire — the driver already
   * holds the caller's copy, so shipping a second one across the boundary would
   * double the cost of every `dlopen` for nothing. A load resolves its whole
   * `DT_NEEDED` closure, so "the image" is not one image: the `compile` act
   * names which library it means, and a dependency's bytes are recorded here
   * the moment the planner asks for them.
   */
  readonly #images = new Map<string, Uint8Array>();
  /** Compiled modules by library name, for the activation coordinator. */
  readonly #modulesByLibrary = new Map<string, WebAssembly.Module>();
  /** The object the last `compile` act named, for import routing. */
  #currentLibrary = "";

  constructor(
    environment: DylinkEngineEnvironment,
    host: DylinkProcessHost,
    pointerWidth: 4 | 8 = 4,
  ) {
    this.#environment = environment;
    this.#host = host;
    this.#pointerWidth = pointerWidth;
  }

  /** Announce an image the planner may ask to compile, by library name. */
  setImage(library: string, bytes: Uint8Array): void {
    this.#images.set(library, bytes);
  }

  /** Drop an image once its object is loaded or its load was abandoned. */
  forgetImage(library: string): void {
    this.#images.delete(library);
    this.#modulesByLibrary.delete(library);
  }

  /** The compiled module for a library, once its `compile` act has run. */
  moduleFor(library: string): WebAssembly.Module | undefined {
    return this.#modulesByLibrary.get(library);
  }

  /** The image a library was compiled from. */
  imageFor(library: string): Uint8Array | undefined {
    return this.#images.get(library);
  }

  instance(id: number): WebAssembly.Instance | undefined {
    return id === 0 ? this.#environment.mainInstance() : this.#instances.get(id);
  }

  tag(id: number): WebAssembly.Tag | undefined {
    return this.#tags.get(id);
  }

  /** Adopt a process-owned tag the planner will refer to by id. */
  adoptTag(id: number, tag: WebAssembly.Tag): void {
    this.#tags.set(id, tag);
  }

  #requireInstance(id: number): WebAssembly.Instance {
    const instance = this.instance(id);
    if (!instance) throw new Error(`dylink: no instance ${id}`);
    return instance;
  }

  #requireGlobal(id: number): WebAssembly.Global {
    const global = this.#globals.get(id);
    if (!global) throw new Error(`dylink: no global ${id}`);
    return global;
  }

  #requireExport(instance: number, name: string): unknown {
    const exported = this.#requireInstance(instance).exports[name];
    if (exported === undefined) {
      throw new Error(`dylink: instance ${instance} does not export ${name}`);
    }
    return exported;
  }

  /** Perform one engine act and return the planner's answer. */
  perform(act: LinkAct): ActResult {
    switch (act.act) {
      case "compile": {
        const bytes =
          act.source.kind === "rewritten"
            ? act.source.bytes
            : this.#images.get(act.library);
        if (!bytes) {
          throw new Error(`dylink: no module image for ${act.library}`);
        }
        const compiled = new WebAssembly.Module(asModuleSource(bytes));
        this.#modules.set(act.module, compiled);
        // The activation coordinator reads this object's custom sections when
        // it prepares an activation, and it knows the object only by name.
        this.#modulesByLibrary.set(act.library, compiled);
        this.#currentLibrary = act.library;
        return { result: "done" };
      }
      case "newGlobal": {
        const global = new WebAssembly.Global(
          { value: valTypeName(act.ty), mutable: act.mutable },
          wasmValueToJs(act.init),
        );
        this.#globals.set(act.global, global);
        return { result: "done" };
      }
      case "readGlobal": {
        // The act carries no type, because the planner only ever reads
        // POINTER-WIDTH globals — `__memory_base`, `__table_base`, a GOT cell —
        // and the JS API reports i64 as a bigint and i32 as a number. That is
        // the same discrimination `dylink.ts` makes. A float global would read
        // back as a number and be reported as i32; the planner never asks for
        // one, and `jsToWasmValue` refuses anything that is neither.
        const raw: unknown = this.#requireGlobal(act.global).value;
        return {
          result: "value",
          value: jsToWasmValue(raw, typeof raw === "bigint" ? { kind: "i64" } : { kind: "i32" }),
        };
      }
      case "writeGlobal": {
        this.#requireGlobal(act.global).value = wasmValueToJs(act.value);
        return { result: "done" };
      }
      case "growTable": {
        // `Table.prototype.grow` returns the PREVIOUS length, which is what the
        // planner asked for. Reading `table.length` separately would be a
        // second observation of a value the call already reported.
        const before = growTable(this.#environment.table(), Number(act.delta));
        return { result: "index", index: BigInt(before) };
      }
      case "writeTable": {
        const value =
          act.value.kind === "null"
            ? null
            : (this.#requireExport(act.value.instance, act.value.name) as Function);
        setTableEntry(this.#environment.table(), Number(act.index), value);
        return { result: "done" };
      }
      case "growMemory": {
        this.#environment.memory.grow(Number(act.deltaPages));
        return { result: "done" };
      }
      case "newTag": {
        this.#tags.set(
          act.tag,
          new WebAssembly.Tag({ parameters: act.parameters.map(valTypeName) }),
        );
        return { result: "done" };
      }
      case "instantiate": {
        const module = this.#modules.get(act.module);
        if (!module) throw new Error(`dylink: no compiled module ${act.module}`);
        // A `selfImport` routes back into the module's own like-named export,
        // which does not exist until the instance does. The trampoline closes
        // over the slot rather than the value.
        const slot: { instance?: WebAssembly.Instance } = {};
        // Which read of each `(module, name)` pair this binding is. The routing
        // hook needs it because `wasm-ld` can declare the same pair twice and
        // the two declarations may be routed differently.
        const occurrences = new Map<string, number>();
        const imports = buildImportObject(act.bindings, (binding) => {
          const key = `${binding.module} ${binding.name}`;
          const occurrence = occurrences.get(key) ?? 0;
          occurrences.set(key, occurrence + 1);
          const value = this.#resolveBinding(binding, slot);
          const route = this.#environment.routeFunctionImport;
          if (!route || typeof value !== "function") return value;
          return route(
            this.#currentLibrary,
            binding.module,
            binding.name,
            occurrence,
            value as CallableFunction,
          );
        });
        const instance = new WebAssembly.Instance(
          module,
          this.#environment.wrapImports?.(imports) ?? imports,
        );
        slot.instance = instance;
        this.#instances.set(act.instance, instance);
        return { result: "done" };
      }
      case "readExports": {
        const instance = this.#requireInstance(act.instance);
        const exports: InstanceExport[] = [];
        for (const [name, value] of Object.entries(instance.exports)) {
          exports.push(describeExport(name, value));
        }
        return { result: "exports", exports };
      }
      case "zeroMemory": {
        const address = Number(act.address);
        const length = Number(act.length);
        new Uint8Array(this.#environment.memory.buffer, address, length).fill(0);
        return { result: "done" };
      }
    }
  }

  /** Perform one process-host request and return the planner's answer. */
  performHost(request: HostRequest): ActResult {
    switch (request.request) {
      case "allocateMemory":
        return {
          result: "index",
          index: this.#host.allocateMemory(request.library, request.size, request.align),
        };
      case "adoptMapping":
        this.#host.adoptMapping(request.library, request.allocation);
        return { result: "done" };
      case "releaseMapping":
        this.#host.releaseMapping(request.library, request.allocation);
        return { result: "done" };
      case "prepareActivation": {
        const activation = this.#host.prepareActivation(
          request.library,
          request.replayActivationId,
        );
        if (!Number.isInteger(activation) || activation <= 0) {
          throw new RangeError(
            `dylink: fork activation for ${request.library} must be a nonzero id`,
          );
        }
        return { result: "index", index: BigInt(activation) };
      }
      case "registerActivation":
        this.#host.registerActivation(request.library, request.activation, request.instance);
        return { result: "done" };
      case "unregisterActivation":
        this.#host.unregisterActivation(request.library, request.activation);
        return { result: "done" };
      case "journalTableMutation":
        this.#host.journalTableMutation(request.firstIndex, request.length);
        return { result: "done" };
      case "readDependency": {
        const bytes = this.#host.readDependency(request.library, request.path);
        // The planner will ask to compile this image by name, and this is the
        // only point at which the driver sees it.
        if (bytes !== null) this.#images.set(request.library, bytes);
        return { result: "bytes", bytes };
      }
      case "readArchive":
        return {
          result: "bytes",
          bytes: this.#host.readArchive(request.address, request.length),
        };
      case "allocateArchive":
        return { result: "index", index: this.#host.allocateArchive(request.size) };
      case "writeArchive":
        this.#host.writeArchive(request.address, request.bytes);
        return { result: "done" };
      case "publishGeneration":
        this.#host.publishGeneration(request.address, request.generation);
        return { result: "done" };
      case "releaseArchive":
        this.#host.releaseArchive(request.address, request.size);
        return { result: "done" };
      case "savedGotFunc": {
        const saved = this.#host.savedGotFunc(request.library, request.symbol);
        // The planner asked for a pointer-width value and will bind it into a
        // GOT cell of that width, so the width is the process's, not this
        // value's magnitude.
        return {
          result: "value",
          value: this.#pointerWidth === 8
            ? { kind: "i64", value: BigInt.asUintN(64, saved) }
            : { kind: "i32", value: Number(BigInt.asUintN(32, saved)) },
        };
      }
    }
  }

  #resolveBinding(
    binding: ImportBinding,
    slot: { instance?: WebAssembly.Instance },
  ): unknown {
    switch (binding.value.kind) {
      case "processMemory":
        return this.#environment.memory;
      case "processTable":
        return this.#environment.table();
      case "processStackPointer":
        return this.#environment.stackPointer();
      case "global":
        return this.#requireGlobal(binding.value.global);
      case "tag": {
        const tag = this.#tags.get(binding.value.tag);
        if (!tag) throw new Error(`dylink: no tag ${binding.value.tag}`);
        return tag;
      }
      case "export":
        return this.#requireExport(binding.value.instance, binding.value.name);
      case "selfImport": {
        const name = binding.value.name;
        return (...args: unknown[]): unknown => {
          const instance = slot.instance;
          if (!instance) {
            throw new Error(`dylink: ${name} called before its module finished instantiating`);
          }
          const target = instance.exports[name];
          if (typeof target !== "function") {
            throw new Error(`dylink: ${name} is not a self-defined function`);
          }
          return (target as (...values: unknown[]) => unknown)(...args);
        };
      }
      case "activationEnv":
        return this.#environment.activationEnv(binding.value.name);
      case "weakUndefined":
        return weakUndefinedValue(binding);
    }
  }
}

/**
 * ELF gives a weak undefined symbol the value zero and no error. A data import
 * therefore binds a zero global; a FUNCTION import has no zero to bind, so it
 * binds a stub that fails at the call rather than at the load.
 *
 * That distinction is ELF's, not a convenience: a STRONG undefined symbol is a
 * load failure (`DylinkError::UndefinedSymbol`), and the planner never emits
 * `weakUndefined` for one. Substituting a silent no-op here would erase the
 * difference between "this program may legally not call it" and "this program
 * is broken".
 */
function weakUndefinedValue(binding: ImportBinding): unknown {
  switch (binding.kind) {
    case "global":
      return new WebAssembly.Global({ value: "i32", mutable: false }, 0);
    case "func":
      return (): never => {
        throw new Error(
          `dylink: called weak undefined symbol ${binding.module}.${binding.name}`,
        );
      };
    default:
      throw new Error(
        `dylink: ${binding.module}.${binding.name} is an unresolved ${binding.kind} import`,
      );
  }
}

/**
 * Report one export to the planner.
 *
 * A global's value is read eagerly because the planner needs it to relocate
 * data addresses, and its mutability is reported because relocation applies
 * only to immutable address globals. `dylink.ts:2071-2098` distinguishes them
 * by attempting a self-assignment, which is the only reflection the JS API
 * offers; that probe stays here, at the engine boundary, rather than in the
 * planner.
 */
function describeExport(name: string, value: unknown): InstanceExport {
  if (typeof value === "function") {
    return { name, kind: "func" };
  }
  if (value instanceof WebAssembly.Global) {
    const raw: unknown = value.value;
    const observed: WasmValue =
      typeof raw === "bigint"
        ? { kind: "i64", value: BigInt.asUintN(64, raw) }
        : { kind: "i32", value: Number(raw) >>> 0 };
    return { name, kind: "global", value: observed, mutable: probeMutable(value, raw) };
  }
  if (value instanceof WebAssembly.Memory) return { name, kind: "memory" };
  if (value instanceof WebAssembly.Table) return { name, kind: "table" };
  return { name, kind: "tag" as ExternKind };
}

/** The JS API's only mutability reflection: try to write the value back. */
function probeMutable(global: WebAssembly.Global, current: unknown): boolean {
  try {
    global.value = current;
    return true;
  } catch {
    return false;
  }
}

/**
 * Drive one `dlopen` to `finished`, or to the first failure.
 *
 * The loop is the whole protocol: step, perform, resume. A staged `call` is
 * handed to `onStagedCall`, because those three points are where the GUEST, not
 * the host, runs loader code — libc's staged loader turns each into an ordinary
 * table call so the host never re-enters wasm while a `dlopen` import frame is
 * live.
 */
export function drivePlan(
  session: PlannerSession,
  executor: DylinkActExecutor,
  token: number,
  onStagedCall: (call: Extract<PlanStep, { step: "call" }>["call"]) => void,
): void {
  for (;;) {
    const step = session.step(token);
    switch (step.step) {
      case "finished":
        return;
      case "act":
        session.resume(token, executor.perform(step.act));
        break;
      case "host":
        session.resume(token, executor.performHost(step.request));
        break;
      case "call":
        onStagedCall(step.call);
        session.resume(token, { result: "done" });
        break;
    }
  }
}
