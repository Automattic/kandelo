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
  decodeResolvedSymbol,
  encodeActResult,
  encodeLinkerConfig,
  encodeLoadRequest,
  encodeMainImage,
  type ActResult,
  type CloseOutcome,
  type ExternKind,
  type HostRequest,
  type ImportBinding,
  type InstanceExport,
  type LinkAct,
  type LinkerConfig,
  type LoadRequest,
  type MainImage,
  type PlanStep,
  type ResolvedSymbol,
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
  readonly dl_open_begin: (len: number) => number;
  readonly dl_step: () => number;
  readonly dl_resume: (len: number) => number;
  readonly dl_open_finish: (replayHandle: number) => number;
  readonly dl_open_abort: () => number;
  readonly dl_plan_instance: () => bigint;
  readonly dl_plan_memory_base: () => bigint;
  readonly dl_plan_table_base: () => bigint;
  readonly dl_plan_tls_base: () => bigint;
  readonly dl_plan_activation: () => bigint;
  readonly dl_sym: (handle: number, len: number) => number;
  readonly dl_close: (handle: number) => number;
  readonly dl_is_unloadable: (len: number) => number;
  readonly dl_forget: (len: number) => number;
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

  openBegin(request: LoadRequest): void {
    const length = this.#write(encodeLoadRequest(request));
    this.#require(this.#exports.dl_open_begin(length), "dl_open_begin");
  }

  step(): PlanStep {
    this.#require(this.#exports.dl_step(), "dl_step");
    return decodePlanStep(this.#output());
  }

  resume(result: ActResult): void {
    const length = this.#write(encodeActResult(result));
    this.#require(this.#exports.dl_resume(length), "dl_resume");
  }

  /**
   * Complete the load. `replayHandle` pins a fork parent's exact handle; pass
   * -1 for an ordinary load.
   */
  openFinish(replayHandle = -1): number {
    const handle = this.#exports.dl_open_finish(replayHandle);
    if (handle < 0) {
      throw new DylinkPlannerError("dl_open_finish", this.takeError() ?? "");
    }
    return handle;
  }

  /**
   * Abandon the load in flight and re-arm the SAME drive loop with its
   * rollback. Returns the table range to reclaim, when there is one.
   */
  openAbort(): { readonly firstIndex: bigint; readonly length: bigint } | null {
    this.#require(this.#exports.dl_open_abort(), "dl_open_abort");
    const bytes = this.#output();
    if (bytes.length === 0 || bytes[0] === 0) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { firstIndex: view.getBigUint64(1, true), length: view.getBigUint64(9, true) };
  }

  /** The layout the plan chose, for the caller that has to record it. */
  planLayout(): {
    readonly instance: number;
    readonly memoryBase: bigint;
    readonly tableBase: bigint;
    readonly tlsBase: bigint | null;
    readonly activationId: number | null;
  } {
    const optional = (value: bigint): bigint | null => (value < 0n ? null : value);
    const tls = optional(this.#exports.dl_plan_tls_base());
    const activation = optional(this.#exports.dl_plan_activation());
    return {
      instance: Number(this.#exports.dl_plan_instance()),
      memoryBase: this.#exports.dl_plan_memory_base(),
      tableBase: this.#exports.dl_plan_table_base(),
      tlsBase: tls,
      activationId: activation === null ? null : Number(activation),
    };
  }

  /** Resolve a symbol. `null` is a miss, which POSIX reports via `dlerror`. */
  sym(handle: number, name: string): ResolvedSymbol | null {
    const length = this.#write(TEXT_ENCODER.encode(name));
    this.#require(this.#exports.dl_sym(handle, length), "dl_sym");
    return decodeResolvedSymbol(this.#output());
  }

  close(handle: number): CloseOutcome {
    this.#require(this.#exports.dl_close(handle), "dl_close");
    return decodeCloseOutcome(this.#output());
  }

  /**
   * Whether the library the last {@link close} released is safe to unload.
   * Releasing the last HANDLE reference does not authorize unloading: a
   * dependency edge from another object keeps the image alive.
   */
  isUnloadable(library: string): boolean {
    const length = this.#write(TEXT_ENCODER.encode(library));
    const status = this.#exports.dl_is_unloadable(length);
    if (status < 0) {
      throw new DylinkPlannerError("dl_is_unloadable", this.takeError() ?? "");
    }
    return status === 1;
  }

  forget(library: string): void {
    const length = this.#write(TEXT_ENCODER.encode(library));
    this.#require(this.#exports.dl_forget(length), "dl_forget");
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
  readonly table: WebAssembly.Table;
  readonly stackPointer: WebAssembly.Global;
  /** The main image, bound at `InstanceId` 0. */
  readonly mainInstance: () => WebAssembly.Instance | undefined;
  /**
   * A value owned by the process fork-activation coordinator: `fork`, the
   * `__wpk_fork_*` entry points, the private unwind tag, and the
   * frame/reference/exception/GC imports. The planner binds these by name and
   * never inspects them; ownership stays with the fork side.
   */
  readonly activationEnv: (name: string) => unknown;
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
  readonly #modules = new Map<number, WebAssembly.Module>();
  readonly #instances = new Map<number, WebAssembly.Instance>();
  readonly #globals = new Map<number, WebAssembly.Global>();
  readonly #tags = new Map<number, WebAssembly.Tag>();
  /**
   * The image the current load was requested with. `ModuleSource.original`
   * carries no bytes on the wire — the driver already holds the caller's copy,
   * so shipping a second one across the boundary would double the cost of
   * every `dlopen` for nothing.
   */
  #currentImage: Uint8Array | null = null;

  constructor(environment: DylinkEngineEnvironment, host: DylinkProcessHost) {
    this.#environment = environment;
    this.#host = host;
  }

  /** Announce the image the next `compile` act refers to. */
  setCurrentImage(bytes: Uint8Array | null): void {
    this.#currentImage = bytes;
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
          act.source.kind === "rewritten" ? act.source.bytes : this.#currentImage;
        if (!bytes) {
          throw new Error("dylink: compile act has no module image");
        }
        this.#modules.set(act.module, new WebAssembly.Module(asModuleSource(bytes)));
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
        const global = this.#requireGlobal(act.global);
        const raw: unknown = global.value;
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
        const before = this.#environment.table.length;
        this.#environment.table.grow(Number(act.delta));
        return { result: "index", index: BigInt(before) };
      }
      case "writeTable": {
        const value =
          act.value.kind === "null"
            ? null
            : (this.#requireExport(act.value.instance, act.value.name) as Function);
        this.#environment.table.set(Number(act.index), value);
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
        const imports = buildImportObject(act.bindings, (binding) =>
          this.#resolveBinding(binding, slot),
        );
        const instance = new WebAssembly.Instance(module, imports);
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
        return this.#environment.table;
      case "processStackPointer":
        return this.#environment.stackPointer;
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
  onStagedCall: (call: Extract<PlanStep, { step: "call" }>["call"]) => void,
): void {
  for (;;) {
    const step = session.step();
    switch (step.step) {
      case "finished":
        return;
      case "act":
        session.resume(executor.perform(step.act));
        break;
      case "host":
        session.resume(executor.performHost(step.request));
        break;
      case "call":
        onStagedCall(step.call);
        session.resume({ result: "done" });
        break;
    }
  }
}
