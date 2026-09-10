/**
 * The process's dynamic loader, driven from `crates/dylink-module`.
 *
 * # What this file is, and what it must never become
 *
 * `host/src/dylink.ts` was a complete `ld.so` in TypeScript: `dylink.0`
 * parsing, placement arithmetic, symbol scope and interposition, the GOT plan,
 * the dependency graph, handle allocation, the staged `dlopen` state machine,
 * and the fork archive's record layout. Every one of those is a DECISION, and
 * every one of them now lives in `crates/dylink`, where it is unit-testable
 * with plain `cargo test` and shared with the native executor.
 *
 * What is left here is transport and engine acts. This file:
 *
 *   * turns a guest `dlopen`/`dlsym`/`dlclose` call into a transaction on the
 *     module and drives its step/resume loop;
 *   * performs the eight JS-API acts, through {@link DylinkActExecutor}; and
 *   * answers the process-host requests the module cannot make itself —
 *     `mmap`, a file read, a byte copy into guest memory, an activation
 *     lifecycle call.
 *
 * **If a change here would encode a linker decision, the decision belongs in
 * `crates/dylink`.** Search paths, load order, symbol resolution, GOT
 * placement, handle numbering, unload eligibility, archive layout and the
 * generation fence's ORDERING are all the planner's; this file supplies
 * `openat`, `Uint8Array.set` and `Atomics.store`.
 *
 * # The one ordering rule this file must not get wrong
 *
 * A staged `dlopen` hands the guest a table slot and returns. The guest calls
 * it and re-enters through `__wasm_dlopen_next`, and only THEN may the planner
 * be told the call completed. So a staged call's `resume` is deliberately
 * deferred to the start of the following {@link DylinkLoader.nextInitialization}
 * rather than issued when the slot is published — resuming early would tell the
 * planner a constructor had run before it had.
 */

import {
  DylinkActExecutor,
  DylinkPlannerError,
  PlannerSession,
  growTable,
  setTableEntry,
  tableLength,
  type AllocationRecord,
  type DylinkEngineEnvironment,
  type DylinkProcessHost,
} from "./dylink-planner";
import {
  type DylinkTablePatch,
  type LinkerConfig,
  type MainImage,
  type PlanStep,
  type SymbolValue,
} from "./dylink-planner-wire";
import { readWasmFunctionImports, type WasmFunctionImportType } from "./constants";

/** `dlopen(NULL, ...)`. POSIX's `RTLD_DEFAULT` pseudo-handle. */
export const MAIN_PROGRAM_HANDLE = 1;

/**
 * The ids the process's own exception tags are bound to.
 *
 * Chosen here rather than by the planner because the objects exist before any
 * `dlopen` does: the main image either exports them or the process created them
 * before instantiating it.
 */
const PROCESS_LONGJMP_TAG_ID = 0;
const PROCESS_CPP_EXCEPTION_TAG_ID = 1;

/** A prepared fork activation, as the process coordinator hands it over. */
export interface LoaderForkActivation {
  readonly activationId: number;
  readonly env: Readonly<Record<string, WebAssembly.ImportValue>>;
  savedMutableGlobalImport?(
    moduleName: string,
    importName: string,
  ): number | bigint | undefined;
  wrapImports(imports: WebAssembly.Imports): WebAssembly.Imports;
  register(instance: WebAssembly.Instance): void;
  unregister(): void;
}

export interface LoaderForkActivationRequest {
  readonly name: string;
  readonly module: WebAssembly.Module;
  readonly moduleBytes: Uint8Array;
  readonly replayActivationId?: number;
}

export interface LoaderForkActivationOwner {
  prepare(request: LoaderForkActivationRequest): LoaderForkActivation;
}

/** Everything the loader needs from the process it is loading into. */
export interface DylinkLoaderOptions {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly ptrWidth: 4 | 8;
  readonly table: () => WebAssembly.Table;
  readonly stackPointer: () => WebAssembly.Global;
  readonly mainInstance: () => WebAssembly.Instance | undefined;
  /** Address-space allocation on the syscall channel. */
  readonly allocateMemory: (size: number, align: number) => number;
  readonly deallocateMemory: (
    address: number,
    size: number,
    allowCopiedArchiveAllocation?: boolean,
  ) => void;
  readonly describeMemoryAllocation: (
    address: number,
    size: number,
  ) => Readonly<{ mappingAddress: number; mappingSize: number }>;
  readonly adoptMemoryAllocation: (allocation: {
    readonly address: number;
    readonly size: number;
    readonly mappingAddress: number;
    readonly mappingSize: number;
  }) => void;
  /** Read one `DT_NEEDED` search-path candidate; `null` when absent. */
  readonly readDependencyFile: (path: string) => Uint8Array | null;
  /** The archive header address, and how to publish a new one. */
  readonly readArchiveHead: () => number;
  readonly writeArchiveHead: (address: number) => void;
  readonly readGenerationFence: () => number;
  readonly writeGenerationFence: (generation: number) => void;
  readonly forkActivationOwner?: LoaderForkActivationOwner;
  readonly forkActivationUnavailableReason?: string;
  readonly onTableMutation?: (
    table: WebAssembly.Table,
    firstIndex: number,
    length: number,
  ) => void;
  readonly routeFunctionImport?: (
    imported: WasmFunctionImportType,
    localImplementation: CallableFunction,
  ) => CallableFunction;
  /**
   * The default `DT_NEEDED` search path. A property of the process's
   * filesystem, not of the linker.
   */
  readonly librarySearchPaths?: readonly string[];
}

/** The archive's table-replication state, which is the only part read back. */
export interface LoaderTableState {
  readonly generation: number;
  readonly tableStateRoot: number;
  readonly tableCheckpointGeneration: number;
  readonly tablePatches: readonly (DylinkTablePatch & { readonly generation: number })[];
}

const DEFAULT_SEARCH_PATHS = ["/lib", "/usr/lib", "/usr/local/lib"] as const;

export class DylinkLoader {
  readonly #options: DylinkLoaderOptions;
  readonly #session: PlannerSession;
  readonly #executor: DylinkActExecutor;
  /** Tokens whose staged call the guest has been handed but not acknowledged. */
  readonly #outstandingCall = new Set<number>();
  /** One transaction-owned table slot per staged load, as `dylink.ts` had. */
  readonly #stagedSlot = new Map<number, number>();
  /** The activation prepared for the object currently being instantiated. */
  #preparing: LoaderForkActivation | null = null;
  /** Registered activations, so an unload can release them. */
  readonly #registered = new Map<string, LoaderForkActivation>();
  /** Per-library function-import declarations, for host-import routing. */
  readonly #functionImports = new Map<string, Map<string, WasmFunctionImportType[]>>();
  #error: string | null = null;
  #mainImagePublished = false;
  /** How to describe the main image when its scope is first needed. */
  #describeMainImage: (() => MainImage) | null = null;

  constructor(options: DylinkLoaderOptions, config: Omit<LinkerConfig, "librarySearchPaths">) {
    this.#options = options;
    this.#session = PlannerSession.instantiate(options.module);
    const environment: DylinkEngineEnvironment = {
      memory: options.memory,
      table: options.table,
      stackPointer: options.stackPointer,
      mainInstance: options.mainInstance,
      activationEnv: (name) => {
        const prepared = this.#preparing;
        if (!prepared || !Object.hasOwn(prepared.env, name)) {
          // Falling through to a process symbol would split ownership between
          // the loader and the activation coordinator, so a missing activation
          // import fails before the side module executes.
          throw new Error(`dylink: activation import ${name} is unavailable`);
        }
        return prepared.env[name];
      },
      wrapImports: (imports) => {
        const prepared = this.#preparing;
        if (!prepared) return imports;
        // Imported global and table identity is observable only while
        // WebAssembly is resolving this exact proxy graph. The coordinator gets
        // one synchronous wrapper boundary and no eager enumeration, because
        // enumerating would collapse duplicate `(module, name)` declarations and
        // capture the wrong provider.
        const wrapped = prepared.wrapImports(imports);
        if (!wrapped || typeof wrapped !== "object") {
          throw new TypeError("dylink: activation owner returned invalid wrapped imports");
        }
        return wrapped;
      },
      routeFunctionImport: options.routeFunctionImport
        ? (library, moduleName, importName, occurrence, value) => {
            const declared = this.#functionImports
              .get(library)
              ?.get(importKey(moduleName, importName));
            if (!declared || declared.length === 0) return value;
            const imported = declared[Math.min(occurrence, declared.length - 1)]!;
            return options.routeFunctionImport!(imported, value);
          }
        : undefined,
    };
    this.#executor = new DylinkActExecutor(environment, this.#processHost(), options.ptrWidth);
    this.#session.configure({
      ...config,
      librarySearchPaths: options.librarySearchPaths ?? DEFAULT_SEARCH_PATHS,
    });
  }

  /**
   * Publish the main image's scope, once, before the first thing that needs it.
   *
   * Deferred rather than done at construction because a loader exists before
   * the main image does: a fork child reads the archive it inherited before it
   * has instantiated anything, and that read needs no scope at all. The
   * describing callback is invoked at most once.
   */
  publishMainImage(describe: () => MainImage): void {
    if (this.#mainImagePublished) return;
    this.#mainImagePublished = true;
    this.#session.publishMainImage(describe());
  }

  /**
   * Record how to describe the main image, for the first operation that needs
   * its scope.
   */
  setMainImage(describe: () => MainImage): void {
    this.#describeMainImage = describe;
  }

  /** Publish the main image if it has not been published yet. */
  #requireMainImage(): void {
    if (this.#mainImagePublished || !this.#describeMainImage) return;
    this.publishMainImage(this.#describeMainImage);
  }

  /**
   * Adopt the process's own exception tags.
   *
   * C++ exceptions and `longjmp` crossing a side-module call require tag
   * IDENTITY, and the identity is the main image's. Both sides must agree: the
   * executor binds the objects to these ids, and the planner is told not to
   * create tags of its own for them.
   */
  adoptProcessTags(
    longjmp: WebAssembly.Tag | undefined,
    cppException: WebAssembly.Tag | undefined,
  ): void {
    if (longjmp) this.#executor.adoptTag(PROCESS_LONGJMP_TAG_ID, longjmp);
    if (cppException) this.#executor.adoptTag(PROCESS_CPP_EXCEPTION_TAG_ID, cppException);
    this.#session.adoptProcessTags(
      longjmp ? PROCESS_LONGJMP_TAG_ID : null,
      cppException ? PROCESS_CPP_EXCEPTION_TAG_ID : null,
    );
  }

  instance(id: number): WebAssembly.Instance | undefined {
    return this.#executor.instance(id);
  }

  // -------------------------------------------------------------------------
  // dlopen / dlsym / dlclose
  // -------------------------------------------------------------------------

  /** `dlopen(NULL, ...)`: the main program's global scope. */
  dlopenMain(): number {
    this.#error = null;
    return MAIN_PROGRAM_HANDLE;
  }

  /**
   * Begin one staged `dlopen` without entering guest code. Returns the private
   * token libc's prepare/next/commit loop uses, or 0 on failure.
   */
  begin(name: string, wasmBytes: Uint8Array, globalVisibility = true): number {
    try {
      this.#requireMainImage();
      const owned = wasmBytes.slice();
      this.#recordImage(name, owned);
      return this.#session.openBegin({
        name,
        moduleBytes: owned,
        globalVisibility,
        borrowedMemory: false,
      });
    } catch (error) {
      this.#error = messageOf(error);
      return 0;
    }
  }

  hasPending(token: number): boolean {
    return this.#session.pending(token);
  }

  /**
   * Acknowledge the previously returned `() -> ()` entry and select the next.
   * Zero means initialization is complete; -1 is a failure the transaction has
   * already been rolled back for.
   */
  nextInitialization(token: number): number {
    try {
      if (this.#outstandingCall.delete(token)) {
        // The guest ran it between the two calls. Only now may the planner be
        // told the stage completed.
        this.#session.resume(token, { result: "done" });
      }
      for (;;) {
        const step = this.#session.step(token);
        if (step.step === "finished") {
          this.#releaseStagedSlot(token);
          this.#error = null;
          return 0;
        }
        if (step.step === "call") {
          const index = this.#publishStagedCall(token, step.call);
          this.#outstandingCall.add(token);
          this.#session.noteStagedSlot(token, BigInt(index));
          this.#error = null;
          return index;
        }
        this.#session.resume(token, this.#perform(step));
      }
    } catch (error) {
      this.abort(token, error);
      return -1;
    }
  }

  /**
   * Advance one staged load and atomically publish its handle on finish.
   *
   * Combined so no guest instruction can observe a completed transaction that
   * is still archived as an issued initializer.
   */
  advance(token: number): Readonly<{ entry: number; handle: number }> {
    const entry = this.nextInitialization(token);
    if (entry !== 0) return { entry, handle: 0 };
    const handle = this.commit(token);
    return handle > 0 ? { entry: 0, handle } : { entry: -1, handle: 0 };
  }

  /**
   * Commit a fully initialized closure and return its stable handle.
   *
   * Zero means one of two different things, and they must not be conflated.
   * A transaction whose staged initializer is still outstanding is NOT a failed
   * load: the guest has not finished driving it, and rolling it back on that
   * mistake would destroy a `dlopen` that was going to succeed. So the misuse
   * returns zero and leaves the transaction — and the process loader lease —
   * exactly where they were. Only a load that cannot complete is rolled back.
   */
  commit(token: number): number {
    if (!this.#session.finished(token)) {
      this.#error = "staged dlopen committed before initialization completed";
      return 0;
    }
    try {
      const handle = this.#session.openFinish(token);
      this.#releaseStagedSlot(token);
      this.#error = null;
      return handle;
    } catch (error) {
      this.abort(token, error);
      return 0;
    }
  }

  /**
   * Abandon a transaction and drain its rollback through the SAME loop.
   *
   * The planner decided what to give back; this only performs it and nulls the
   * table range it reports, because a `WebAssembly.Table` cannot shrink.
   */
  abort(token: number, cause?: unknown): void {
    if (cause !== undefined) this.#error = messageOf(cause);
    try {
      const range = this.#session.abort(token);
      this.#outstandingCall.delete(token);
      this.#drive(token);
      if (range) this.#nullTableRange(Number(range.firstIndex), Number(range.length));
      this.#releaseStagedSlot(token);
      this.#session.discard(token);
    } catch (error) {
      // A rollback that cannot complete leaves the process in a state no later
      // call can reason about, so it is reported rather than swallowed.
      this.#error = `${this.#error ?? "dlopen failed"}; rollback also failed: ${messageOf(error)}`;
      try {
        this.#session.discard(token);
      } catch {
        /* the transaction is already gone */
      }
    }
  }

  /**
   * A whole `dlopen` in one call, with the loader itself invoking each stage.
   *
   * The staged form exists because libc's loader turns each stage into an
   * ordinary table call, so the host never re-enters wasm while a `dlopen`
   * import frame is live. This form is for the callers that have no such frame.
   */
  dlopenSync(name: string, wasmBytes: Uint8Array, globalVisibility = true): number {
    const token = this.begin(name, wasmBytes, globalVisibility);
    if (token === 0) return 0;
    try {
      this.#drive(token, (call) => {
        const target = this.#executor.instance(call.instance)?.exports[call.exportName];
        if (typeof target !== "function") {
          throw new Error(`${call.library}: ${call.exportName} is not callable`);
        }
        (target as () => void)();
      });
      return this.commit(token);
    } catch (error) {
      this.abort(token, error);
      return 0;
    }
  }

  /** Resolve a symbol to the guest scalar a C pointer is. `null` is a miss. */
  dlsym(handle: number, symbolName: string): number | null {
    let token = 0;
    try {
      this.#requireMainImage();
      token = this.#session.symBegin(handle, symbolName);
      this.#drive(token);
      const address = this.#session.symAddress(token);
      if (address === null) {
        this.#error = this.#session.takeError();
        return null;
      }
      this.#error = null;
      return Number(address);
    } catch (error) {
      this.#error = messageOf(error);
      if (token !== 0) this.#discardQuietly(token);
      return null;
    }
  }

  /** Close a handle. Zero on success, -1 with a `dlerror` on failure. */
  dlclose(handle: number): number {
    let token = 0;
    try {
      this.#requireMainImage();
      token = this.#session.closeBegin(handle);
      this.#drive(token);
      const outcome = this.#session.closeResult(token);
      if (outcome.outcome === "released") {
        const activation = this.#registered.get(outcome.library);
        if (activation) {
          this.#registered.delete(outcome.library);
        }
        this.#executor.forgetImage(outcome.library);
        this.#functionImports.delete(outcome.library);
      }
      this.#error = null;
      return 0;
    } catch (error) {
      this.#error = messageOf(error);
      if (token !== 0) this.#discardQuietly(token);
      return -1;
    }
  }

  /** POSIX `dlerror()`: report once, then clear. */
  dlerror(): string | null {
    const local = this.#error;
    this.#error = null;
    if (local !== null) return local;
    return this.#session.takeError();
  }

  /** Record a message a caller produced outside a transaction. */
  setError(message: string | null): void {
    this.#error = message;
  }

  // -------------------------------------------------------------------------
  // The fork archive
  // -------------------------------------------------------------------------

  /** The publication fence other Workers consume. */
  generation(): number {
    return this.#options.readArchiveHead() === 0 ? 0 : this.#options.readGenerationFence();
  }

  /** Publish the loader's state, and the head and fence that make it visible. */
  syncArchive(): { readonly head: number; readonly generation: number } {
    this.#requireMainImage();
    const token = this.#session.archiveSyncBegin();
    this.#drive(token);
    const published = this.#session.archiveSyncFinish(token);
    const head = Number(published.head);
    const generation = Number(published.generation);
    // The records are complete; only now is the archive reachable, and only
    // after that does the fence say so.
    this.#options.writeArchiveHead(head);
    this.#options.writeGenerationFence(generation);
    return { head, generation };
  }

  /** Decode the process archive into the module. */
  readArchive(): void {
    // The CURRENT memory size, not the configured one: memory grows, and a
    // record allocated past the configured bound would be refused as out of
    // bounds.
    const token = this.#session.archiveReadBegin(
      BigInt(this.#options.readArchiveHead()),
      BigInt(this.#options.memory.buffer.byteLength),
    );
    this.#drive(token);
    this.#session.archiveReadFinish(token);
  }

  /** Whether the decoded archive names anything at all. */
  archiveIsEmpty(): boolean {
    return this.#session.archiveIsEmpty();
  }

  /**
   * Rebuild every object the decoded archive names that this session lacks,
   * then adopt the parent's handle table.
   */
  reconcile(memoryOwnership: "copied" | "borrowed" = "copied"): void {
    this.#requireMainImage();
    // A replay's images come from the ARCHIVE, not from a search: the planner
    // will ask to compile each object by name, and this is the only point at
    // which the driver can see the bytes the parent recorded.
    for (const module of this.archivedModules()) {
      this.#recordImage(module.name, module.moduleBytes);
    }
    const token = this.#session.forkReconcileBegin(memoryOwnership === "borrowed");
    this.#drive(token, (call) => {
      const target = this.#executor.instance(call.instance)?.exports[call.exportName];
      if (typeof target !== "function") {
        throw new Error(`${call.library}: ${call.exportName} is not callable`);
      }
      (target as () => void)();
    });
    this.#session.forkReconcileFinish(token);

    // A load the parent was suspended inside is now live under the parent's own
    // token, positioned at the exact staged call it stopped in. Publish that
    // call into the slot the parent recorded — the guest's copied memory names
    // that index — and leave the transaction for libc to drive.
    for (const restored of this.#session.restoredTransactions()) {
      this.#stagedSlot.set(restored.token, restored.tableSlot);
      const entry = this.nextInitialization(restored.token);
      if (entry !== restored.tableSlot) {
        throw new Error(
          `dylink: restored transaction ${restored.token} resumed at slot ${entry}, ` +
            `not the ${restored.tableSlot} its parent recorded`,
        );
      }
    }
  }

  /** The archive's table-replication state. */
  tableState(): LoaderTableState {
    return decodeTableState(this.#session.tableStateBytes());
  }

  /**
   * The archived objects, for a fork child that must map activation ids to
   * images before anything is rebuilt.
   *
   * The images cross the boundary here, which is one extra copy of each side
   * module per fork child. It is the price of the child needing that map BEFORE
   * the reconcile that would otherwise be the only reader of these bytes.
   */
  archivedModules(): readonly LoaderArchivedModule[] {
    return decodeArchivedModules(this.#session.archivedModulesBytes());
  }

  /**
   * Seal a typed table snapshot and publish it.
   *
   * The previous root comes back so its arena can be released — but only after
   * the new generation is visible, which is why it is reported rather than
   * released here.
   */
  publishTableState(root: number): {
    readonly state: LoaderTableState;
    readonly previousTableStateRoot: number;
  } {
    const previousTableStateRoot = this.tableState().tableStateRoot;
    this.#session.setTableStateRoot(BigInt(root));
    this.syncArchive();
    return { state: this.tableState(), previousTableStateRoot };
  }

  /** Would the patch journal accept this patch, or must it be compacted? */
  canPublishTablePatch(patch: DylinkTablePatch): boolean {
    return this.#session.canAppendTablePatch(patch);
  }

  /** Append one funcref patch and publish it. */
  publishTablePatch(patch: DylinkTablePatch): { readonly state: LoaderTableState } {
    if (!this.#session.appendTablePatch(patch)) {
      throw new Error("dylink: the funcref patch journal is full");
    }
    this.syncArchive();
    return { state: this.tableState() };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Run a transaction's loop to `finished`. */
  #drive(token: number, onStagedCall?: (call: StagedCallStep) => void): void {
    for (;;) {
      const step = this.#session.step(token);
      if (step.step === "finished") return;
      if (step.step === "call") {
        if (!onStagedCall) {
          throw new Error(
            `dylink: ${step.call.library} needs a staged ${step.call.stage} call ` +
              "on a path that cannot enter guest code",
          );
        }
        onStagedCall(step.call);
        this.#session.resume(token, { result: "done" });
        continue;
      }
      this.#session.resume(token, this.#perform(step));
    }
  }

  #perform(step: Extract<PlanStep, { step: "act" } | { step: "host" }>) {
    return step.step === "act"
      ? this.#executor.perform(step.act)
      : this.#executor.performHost(step.request);
  }

  #recordImage(library: string, bytes: Uint8Array): void {
    this.#executor.setImage(library, bytes);
    if (!this.#options.routeFunctionImport) return;
    const declarations = new Map<string, WasmFunctionImportType[]>();
    const copy = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    for (const imported of readWasmFunctionImports(copy)) {
      const key = importKey(imported.module, imported.name);
      const entries = declarations.get(key) ?? [];
      entries.push(imported);
      declarations.set(key, entries);
    }
    this.#functionImports.set(library, declarations);
  }

  /** Publish one staged `() -> ()` entry into the transaction's slot. */
  #publishStagedCall(token: number, call: StagedCallStep): number {
    const table = this.#options.table();
    const target = this.#executor.instance(call.instance)?.exports[call.exportName];
    if (typeof target !== "function") {
      throw new Error(`${call.library}: ${call.exportName} is not callable`);
    }
    let index = this.#stagedSlot.get(token);
    if (index !== undefined) {
      // A restored transaction carries the slot its parent recorded, and a
      // child's table may not have grown that far yet. The index is not
      // negotiable: the guest's copied memory names it.
      const length = tableLength(table);
      if (length <= index) growTable(table, index + 1 - length);
    }
    if (index === undefined) {
      index = tableLength(table);
      if (index === 0) {
        // Slot zero is the null function pointer. A staged entry published
        // there would be indistinguishable from "no entry" to the guest.
        growTable(table, 1);
        index = 1;
      }
      growTable(table, 1);
      this.#stagedSlot.set(token, index);
    }
    setTableEntry(table, index, target as unknown as Function);
    this.#options.onTableMutation?.(table, index, 1);
    return index;
  }

  #releaseStagedSlot(token: number): void {
    const index = this.#stagedSlot.get(token);
    if (index === undefined) return;
    const table = this.#options.table();
    setTableEntry(table, index, null);
    this.#options.onTableMutation?.(table, index, 1);
    this.#stagedSlot.delete(token);
  }

  #nullTableRange(firstIndex: number, length: number): void {
    const table = this.#options.table();
    const current = tableLength(table);
    for (let offset = 0; offset < length; offset++) {
      const index = firstIndex + offset;
      if (index < current) setTableEntry(table, index, null);
    }
    if (length > 0) this.#options.onTableMutation?.(table, firstIndex, length);
  }

  #discardQuietly(token: number): void {
    try {
      this.#session.abort(token);
      this.#drive(token);
      this.#session.discard(token);
    } catch {
      // The transaction failed before it owned anything worth giving back.
    }
  }

  #processHost(): DylinkProcessHost {
    const options = this.#options;
    const toRecord = (allocation: AllocationRecord) => ({
      address: Number(allocation.address),
      size: Number(allocation.size),
      mappingAddress: Number(allocation.mappingAddress),
      mappingSize: Number(allocation.mappingSize),
    });
    return {
      allocateMemory: (library, size, align) => {
        const address = options.allocateMemory(Number(size), Number(align));
        // The planner records the LOGICAL allocation; the process records which
        // mapping backs it, and the two must agree or a fork child would adopt
        // ownership of a mapping that never existed.
        options.describeMemoryAllocation(address, Number(size));
        void library;
        return BigInt(address);
      },
      adoptMapping: (_library, allocation) => {
        options.adoptMemoryAllocation(toRecord(allocation));
      },
      releaseMapping: (_library, allocation) => {
        const record = toRecord(allocation);
        options.deallocateMemory(record.address, record.size, true);
      },
      prepareActivation: (library, replayActivationId) => {
        const owner = options.forkActivationOwner;
        if (!owner) {
          throw new Error(
            options.forkActivationUnavailableReason ??
              `${library}: side modules require a process activation owner`,
          );
        }
        const module = this.#executor.moduleFor(library);
        const bytes = this.#executor.imageFor(library);
        if (!module || !bytes) {
          throw new Error(`${library}: no compiled image to prepare an activation for`);
        }
        const prepared = owner.prepare({
          name: library,
          module,
          moduleBytes: bytes,
          ...(replayActivationId === undefined ? {} : { replayActivationId }),
        });
        this.#preparing = prepared;
        return prepared.activationId;
      },
      registerActivation: (library, _activation, instance) => {
        const prepared = this.#preparing;
        if (!prepared) throw new Error(`${library}: no prepared activation to register`);
        const built = this.#executor.instance(instance);
        if (!built) throw new Error(`${library}: instance ${instance} does not exist`);
        prepared.register(built);
        this.#registered.set(library, prepared);
        this.#preparing = null;
      },
      unregisterActivation: (library, _activation) => {
        const prepared = this.#registered.get(library) ?? this.#preparing;
        if (!prepared) return;
        this.#registered.delete(library);
        if (this.#preparing === prepared) this.#preparing = null;
        prepared.unregister();
      },
      journalTableMutation: (firstIndex, length) => {
        options.onTableMutation?.(options.table(), Number(firstIndex), Number(length));
      },
      readDependency: (_library, path) => options.readDependencyFile(path),
      readArchive: (address, length) =>
        new Uint8Array(
          new Uint8Array(options.memory.buffer, Number(address), Number(length)),
        ),
      allocateArchive: (size) => BigInt(options.allocateMemory(Number(size), 8)),
      writeArchive: (address, bytes) => {
        new Uint8Array(options.memory.buffer, Number(address), bytes.length).set(bytes);
      },
      publishGeneration: (address, generation) => {
        storeGeneration(options.memory, Number(address), generation);
      },
      releaseArchive: (address, size) => {
        options.deallocateMemory(Number(address), Number(size), true);
      },
      savedGotFunc: (library, symbol) => {
        const prepared = this.#preparing;
        const saved = prepared?.savedMutableGlobalImport?.("GOT.func", symbol);
        if (saved === undefined) {
          throw new Error(`${library}: fork replay has no saved GOT.func.${symbol} value`);
        }
        return BigInt(saved);
      },
    };
  }
}

type StagedCallStep = Extract<PlanStep, { step: "call" }>["call"];

function importKey(moduleName: string, importName: string): string {
  return `${moduleName.length}:${moduleName}${importName}`;
}

function messageOf(error: unknown): string {
  if (error instanceof DylinkPlannerError || error instanceof Error) return error.message;
  return String(error);
}

/**
 * Store the archive generation as ONE aligned 8-byte write.
 *
 * It is the fence a pthread peer consumes, so it must land atomically rather
 * than as the tail of a byte copy: a reader that saw a new generation beside
 * stale cursors would instantiate a half-written recipe graph.
 */
function storeGeneration(
  memory: WebAssembly.Memory,
  address: number,
  generation: bigint,
): void {
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    memory.buffer instanceof SharedArrayBuffer
  ) {
    Atomics.store(new BigUint64Array(memory.buffer, address, 1), 0, generation);
    return;
  }
  new DataView(memory.buffer).setBigUint64(address, generation, true);
}

/** One archived object, as a fork child needs to name it. */
export interface LoaderArchivedModule {
  readonly name: string;
  readonly activationId?: number;
  readonly moduleBytes: Uint8Array;
}

/** Decode `dl_archive_modules`'s answer. */
function decodeArchivedModules(bytes: Uint8Array): LoaderArchivedModule[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  const count = view.getUint32(offset, true);
  offset += 4;
  const modules: LoaderArchivedModule[] = [];
  for (let index = 0; index < count; index++) {
    const nameLength = view.getUint32(offset, true);
    offset += 4;
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const hasActivation = view.getUint8(offset) === 1;
    offset += 1;
    let activationId: number | undefined;
    if (hasActivation) {
      activationId = view.getUint32(offset, true);
      offset += 4;
    }
    const imageLength = view.getUint32(offset, true);
    offset += 4;
    const moduleBytes = new Uint8Array(bytes.subarray(offset, offset + imageLength));
    offset += imageLength;
    modules.push({ name, moduleBytes, ...(activationId === undefined ? {} : { activationId }) });
  }
  return modules;
}

/** Decode `dl_archive_table_state`'s answer. */
function decodeTableState(bytes: Uint8Array): LoaderTableState {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const generation = Number(view.getBigUint64(0, true));
  const tableStateRoot = Number(view.getBigUint64(8, true));
  const tableCheckpointGeneration = Number(view.getBigUint64(16, true));
  let offset = 24;
  const count = view.getUint32(offset, true);
  offset += 4;
  const tablePatches: (DylinkTablePatch & { generation: number })[] = [];
  for (let index = 0; index < count; index++) {
    const patchGeneration = Number(view.getBigUint64(offset, true));
    offset += 8;
    const activationId = view.getUint32(offset, true);
    offset += 4;
    const ownerId = view.getUint32(offset, true);
    offset += 4;
    const start = Number(view.getBigUint64(offset, true));
    offset += 8;
    const tableLength = Number(view.getBigUint64(offset, true));
    offset += 8;
    const runCount = view.getUint32(offset, true);
    offset += 4;
    const runs: DylinkTablePatch["runs"][number][] = [];
    for (let run = 0; run < runCount; run++) {
      const length = Number(view.getBigUint64(offset, true));
      offset += 8;
      const present = view.getUint8(offset) === 1;
      offset += 1;
      if (present) {
        const runActivation = view.getUint32(offset, true);
        offset += 4;
        const ordinal = view.getUint32(offset, true);
        offset += 4;
        runs.push({ length, function: { activationId: runActivation, ordinal } });
      } else {
        runs.push({ length, function: null });
      }
    }
    tablePatches.push({
      generation: patchGeneration,
      activationId,
      ownerId,
      start,
      tableLength,
      runs,
    });
  }
  return { generation, tableStateRoot, tableCheckpointGeneration, tablePatches };
}

/** Re-exported so a caller can build a `MainImage` without a second import. */
export type { MainImage, SymbolValue };
