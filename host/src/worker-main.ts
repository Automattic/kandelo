/**
 * Kernel worker entry points.
 *
 * Programs compiled with channel_syscall.c run in Worker threads.
 * All syscalls go through a shared-memory channel to the
 * CentralizedKernelWorker on the main thread.
 */
import {
  EXEC_RETIRE_SIGNAL_CODE,
  type CentralizedWorkerInitMessage,
  type CentralizedThreadInitMessage,
  type WorkerToHostMessage,
} from "./worker-protocol";
import {
  createCppExceptionTag,
  createLongjmpTag,
  FORK_CAP_DYLINK_MAIN,
  forkInstrumentRoleAvailable,
  readForkInstrumentCapabilityClaim,
  requireCppExceptionTag,
  requireLongjmpTag,
} from "./dylink-artifact";
import {
  DylinkLoader,
  type LoaderArchivedModule,
  type LoaderForkActivationOwner,
  type LoaderTableState,
} from "./dylink-loader";
import { DylinkForkTableReplica } from "./dylink-table-replica";
import { getTableEntry, tableLength } from "./dylink-planner";
import type { MainImage, SymbolValue } from "./dylink-planner-wire";
import {
  describeWasmArtifactPolicyFailures,
  extractAbiVersion,
  readWasmFunctionArity,
  readWasmImportDescriptors,
  WASM_PAGE_SIZE,
  WPK_FORK_EXPORTS,
} from "./constants";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_IDLE,
  CHANNEL_STATUS_PENDING,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_DATA,
  CH_ERRNO,
  CH_REQUEST_FLAGS,
  CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
  CH_RETURN,
  CH_SIG_SI_CODE,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  POSIX_ARG_MAX_BYTES,
  PROCESS_FORK_MODE_FORK,
  PROCESS_FORK_MODE_VFORK,
  PROCESS_METADATA_ENTRY_MAX_BYTES,
  PROCESS_STARTUP_MAX_ARGV_COUNT,
  PROCESS_STARTUP_MAX_ENVP_COUNT,
  WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP,
  WPK_FORK_EXPORT_THREAD_ENTRY,
  WPK_FORK_REQUIRED_IMPORTS,
  WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
  ABI_VERSION,
  type ProcessForkMode,
  WPK_FORK_UNWIND_TAG_IMPORT_MODULE as FORK_UNWIND_TAG_IMPORT_MODULE,
  WPK_FORK_UNWIND_TAG_IMPORT_NAME as FORK_UNWIND_TAG_IMPORT_NAME,
} from "./generated/abi";
import {
  FORK_SAVE_BUFFER_SIZE,
  FORK_SAVE_CONTROL_PREFIX_SIZE,
} from "./process-memory";
import { ContinuationAllocationError } from "./fork-continuation";
import {
  buildForkGuestImports,
  forkActivationFrameImports,
  FORK_GUEST_ACTIVATION_GLOBAL_IMPORT,
  FORK_GUEST_TABLE_GENERATION_ADDR_IMPORT,
  requireForkUnwindTag,
} from "./fork-guest-imports";
import { ForkModuleContinuationBackend } from "./fork-module-backend";
import {
  computeForkModuleTemplateId,
  readForkModuleStateRoot,
} from "./fork-guest-sections";
import { guardFunctionImport, guardImportObject } from "./import-trap-guard";
import {
  ForkImportIdentity,
  type ForkWasmImports,
  type PreparedForkParentActivation,
} from "./fork-import-identity";
import { ForkActivations } from "./fork-activations";
import { ForkChildImports } from "./fork-child-imports";
import {
  checkedWasmGuestPointerOffset,
  type WasmGuestPointer,
} from "./wasm-guest-pointer";
// WASI detection helpers are tiny and live in their own file so we can
// import them eagerly without dragging in the WASI hosting path.
// `wasi-module-instance.ts` is dynamically imported below, only when a worker
// actually needs to host a wasi_snapshot_preview1 module — which our
// native channel-syscall binaries (mariadbd, dinit, dash, coreutils,
// everything compiled by wasm32-posix) never trigger.
import { isWasiModule, wasiModuleDefinesMemory } from "./wasi-detect";
import { synchronizeReceivedSharedWasmMemory } from "./shared-wasm-memory-growth";
import {
  channelSyscall,
  ForkWorker,
  isWasmUnreachableTrap,
  processForkMode,
} from "./worker-main-fork-support";
import {
  registerWasmModuleReflection,
  wasmModuleExports,
  wasmModuleImports,
} from "./wasm-module-reflection";
export interface MessagePort {
  postMessage(msg: unknown, transferList?: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

function alignUp(value: number, align: number): number {
  return Math.ceil(value / align) * align;
}

const SYS_MMAP_NR = ABI_SYSCALLS.Mmap;
const PROT_READ_WRITE = 3;
const MAP_PRIVATE_ANONYMOUS = 0x22;
const SIGKILL = 9;

class ExecRetirement extends Error {}

// Moved to the shared fork support with the run loop that is its main reader;
// re-exported so its cross-engine test keeps one import path.
export { isWasmUnreachableTrap };

/** @internal Exported so ABI-generated retirement-marker decoding is tested. */
export function isExecRetirementMarker(
  view: DataView,
  channelOffset: number,
): boolean {
  return view.getUint32(channelOffset + CH_SIG_SIGNUM, true) === SIGKILL
    && view.getUint32(channelOffset + CH_SIG_SI_CODE, true)
      === EXEC_RETIRE_SIGNAL_CODE;
}

function markDeferredSignalDelivery(
  view: DataView,
  channelOffset: number,
): void {
  view.setUint32(
    channelOffset + CH_REQUEST_FLAGS,
    CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
    true,
  );
}

function clearDeferredSignalDelivery(
  view: DataView,
  channelOffset: number,
): void {
  view.setUint32(channelOffset + CH_REQUEST_FLAGS, 0, true);
}

/**
 * Map `size` anonymous bytes through this Worker's channel, for a host-placed
 * region (the fork module, the WASI module). One shared channel call does the
 * request/wait/reply dance (`channelSyscall`).
 */
function continuationMmap(
  memory: WebAssembly.Memory,
  channelOffset: number,
  size: number,
  label: string,
): number {
  const result = channelSyscall(memory, channelOffset, SYS_MMAP_NR, [
    0n, BigInt(size), BigInt(PROT_READ_WRITE), BigInt(MAP_PRIVATE_ANONYMOUS), -1n, 0n,
  ]);
  if (result < 0) {
    throw new ContinuationAllocationError(-result, size, `${label}: mmap(${size}) failed errno=${-result}`);
  }
  return result;
}

/**
 * Build kernel.* import stubs for channel-mode Wasm modules.
 * Both process and thread workers need these because the musl overlay CRT
 * imports kernel.* functions for argc/argv, environ, fork state, and clone.
 *
 * Startup metadata pointers are checked against their declared process
 * pointer width before any guest-memory view is created.
 */
type KernelImports = Record<string, WebAssembly.ExportValue> & {
  kernel_exit: (status: number) => void;
  kernel_fork: (mode: number) => number;
};

const STARTUP_E2BIG = 7;
const STARTUP_EAGAIN = 11;
const STARTUP_ENOMEM = 12;
const STARTUP_EFAULT = 14;
const STARTUP_EINVAL = 22;
const STARTUP_ERANGE = 34;

interface EncodedStartupMetadata {
  argv: readonly Uint8Array[];
  env: readonly Uint8Array[];
}

function encodeStartupMetadata(
  argv: readonly string[],
  env: readonly string[],
  ptrWidth: 4 | 8,
): EncodedStartupMetadata {
  if (argv.length > PROCESS_STARTUP_MAX_ARGV_COUNT) {
    throw new RangeError(
      `startup argv count exceeds ${PROCESS_STARTUP_MAX_ARGV_COUNT}: errno ${STARTUP_E2BIG}`,
    );
  }
  if (env.length > PROCESS_STARTUP_MAX_ENVP_COUNT) {
    throw new RangeError(
      `startup environment count exceeds ${PROCESS_STARTUP_MAX_ENVP_COUNT}: errno ${STARTUP_E2BIG}`,
    );
  }

  const encoder = new TextEncoder();
  // The two terminating null pointers count even for empty vectors.
  let representedBytes = 2 * ptrWidth;
  const encodeVector = (
    values: readonly string[],
    label: string,
  ): readonly Uint8Array[] => values.map((value, index) => {
    if (typeof value !== "string") {
      throw new TypeError(`${label}[${index}] must be a string`);
    }
    const encoded = encoder.encode(value);
    if (encoded.byteLength > PROCESS_METADATA_ENTRY_MAX_BYTES) {
      throw new RangeError(
        `${label}[${index}] exceeds the per-entry startup transfer limit: ` +
          `errno ${STARTUP_E2BIG}`,
      );
    }
    representedBytes += ptrWidth + encoded.byteLength + 1;
    if (
      !Number.isSafeInteger(representedBytes)
      || representedBytes > POSIX_ARG_MAX_BYTES
    ) {
      throw new RangeError(
        `startup argv/environment representation exceeds ARG_MAX: ` +
          `errno ${STARTUP_E2BIG}`,
      );
    }
    return encoded;
  });

  // WHY: startup imports can be queried twice (size, then exact copy). Encode
  // once so no caller mutation or coercion can make the second observation
  // name different bytes after the guest has allocated its lifetime region.
  return {
    argv: encodeVector(argv, "startup argv"),
    env: encodeVector(env, "startup environment"),
  };
}

function buildKernelImports(
  memory: WebAssembly.Memory,
  channelOffset: number,
  ptrWidth: 4 | 8,
  argv: string[] | undefined,
  envVars: string[] | undefined,
  secureExec: boolean,
  onKernelExit?: (status: number) => void,
): KernelImports {
  const metadata = encodeStartupMetadata(argv ?? [], envVars ?? [], ptrWidth);
  // The legacy clone payload remains a fixed wasm32 pair in CH_DATA.
  const n = (value: number | bigint): number =>
    typeof value === "bigint" ? Number(value) : value;
  const copyEntry = (
    entries: readonly Uint8Array[],
    index: number,
    bufPtr: WasmGuestPointer,
    bufCapacity: number,
    label: string,
  ): number => {
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || index >= entries.length
      || !Number.isSafeInteger(bufCapacity)
      || bufCapacity < 0
    ) {
      return -STARTUP_EINVAL;
    }
    const encoded = entries[index];
    if (bufCapacity === 0) {
      // Zero capacity is a side-effect-free complete-length query. The CRT
      // follows it with one exact-capacity copy into its mmap-owned region.
      return encoded.byteLength;
    }
    if (bufCapacity < encoded.byteLength) return -STARTUP_ERANGE;
    if (bufPtr === 0 || bufPtr === 0n) return -STARTUP_EFAULT;

    let range: { offset: number; length: number };
    try {
      range = checkedWasmMemoryRange(
        memory,
        bufPtr,
        encoded.byteLength,
        ptrWidth,
        label,
      );
    } catch {
      return -STARTUP_EFAULT;
    }
    // The encoded source is an immutable launch snapshot, and this direct
    // import has no await or callback between the range proof and full copy.
    new Uint8Array(memory.buffer, range.offset, range.length).set(encoded);
    return encoded.byteLength;
  };

  return {
    // CRT argv support
    kernel_get_argc: (): number => metadata.argv.length,
    kernel_argv_read: (index: number, bufPtr: number | bigint, bufMax: number): number => {
      return copyEntry(metadata.argv, index, bufPtr, bufMax, "kernel_argv_read");
    },

    // CRT environ support
    kernel_environ_count: (): number => metadata.env.length,
    kernel_environ_get: (index: number, bufPtr: number | bigint, bufMax: number): number => {
      return copyEntry(metadata.env, index, bufPtr, bufMax, "kernel_environ_get");
    },

    // Sticky kernel-owned state captured for this exact process image.
    kernel_get_secure_exec: (): number => secureExec ? 1 : 0,

    // Fork/exec state — not a fork child.
    kernel_is_fork_child: (): number => 0,
    kernel_apply_fork_fd_actions: (): number => 0,
    kernel_get_fork_exec_path: (_buf: number | bigint, _max: number): number =>
      0,
    kernel_get_fork_exec_argc: (): number => 0,
    kernel_get_fork_exec_argv: (
      _index: number,
      _buf: number | bigint,
      _max: number,
    ): number => 0,
    kernel_push_argv: (_ptr: number | bigint, _len: number): void => {},
    kernel_clear_fork_exec: (): number => 0,

    // Exec dispatches through channel
    kernel_execve: (_pathPtr: number | bigint): number => -38, // ENOSYS

    // Exit dispatches through channel (SYS_EXIT)
    kernel_exit: (status: number): void => {
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      if (isExecRetirementMarker(view, base)) {
        // Exec keeps the kernel Process alive. The old browser Worker must
        // unwind without publishing SYS_EXIT, then its wrapper emits the
        // exact-generation memory_quiescent ownership fence.
        view.setUint32(base + CH_SIG_SIGNUM, 0, true);
        view.setUint32(base + CH_SIG_SI_CODE, 0, true);
        throw new ExecRetirement();
      }
      view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Exit, true);
      view.setBigInt64(base + CH_ARGS, BigInt(status), true);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      // Wait until the reusable kernel transaction returns and the host has
      // committed the exit before terminating this disposable process Worker.
      while (
        Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) ===
        "ok"
      ) {
        /* */
      }
      onKernelExit?.(status);
      // WHY: this trap belongs at the disposable guest-Worker boundary, not in
      // the reusable kernel Wasm. It enforces `_Noreturn` even if a caller was
      // built without the compiler's trailing unreachable, and prevents
      // libc's SYS_exit retry loop from parking on a channel already removed
      // by the host.
      throw new WebAssembly.RuntimeError("unreachable");
    },

    // Clone dispatches through channel (SYS_CLONE)
    kernel_clone: (
      fnPtr: number | bigint,
      stackPtr: number | bigint,
      flags: number,
      arg: number | bigint,
      ptidPtr: number | bigint,
      tlsPtr: number | bigint,
      ctidPtr: number | bigint,
    ): number => {
      const SYS_CLONE_NR = ABI_SYSCALLS.Clone;
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + CH_SYSCALL, SYS_CLONE_NR, true);
      view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, BigInt(flags), true);
      view.setBigInt64(
        base + CH_ARGS + 1 * CH_ARG_SIZE,
        BigInt(stackPtr),
        true,
      );
      view.setBigInt64(base + CH_ARGS + 2 * CH_ARG_SIZE, BigInt(ptidPtr), true);
      view.setBigInt64(base + CH_ARGS + 3 * CH_ARG_SIZE, BigInt(tlsPtr), true);
      view.setBigInt64(base + CH_ARGS + 4 * CH_ARG_SIZE, BigInt(ctidPtr), true);
      view.setBigInt64(base + CH_ARGS + 5 * CH_ARG_SIZE, 0n, true);
      // Write fn_ptr and arg_ptr to CH_DATA area for handleClone
      view.setUint32(base + CH_DATA, n(fnPtr), true);
      view.setUint32(base + CH_DATA + 4, n(arg), true);

      markDeferredSignalDelivery(view, base);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      while (
        Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) ===
        "ok"
      ) {
        /* */
      }

      const result = Number(view.getBigInt64(base + CH_RETURN, true));
      const err = view.getUint32(base + CH_ERRNO, true);
      clearDeferredSignalDelivery(view, base);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

      if (err) return -err;
      return result;
    },

    // Fail loud by default. A fork-instrumented Worker replaces this with its
    // `ForkWorker`'s import; anything else cannot represent a fork, because
    // the child has no way to resume at the fork call site. This default used
    // to issue SYS_FORK with no continuation behind it, and every caller
    // replaced it -- a dead path that would have created a child with nothing
    // to run had anything ever reached it.
    kernel_fork: (_mode: number): number => {
      throw new Error(
        "kernel_fork reached without complete wasm-fork-instrument exports. "
          + "Rebuild the program with scripts/run-wasm-fork-instrument.sh.",
      );
    },
  };
}

/** @internal Exported for focused startup import contract tests. */
export function buildKernelImportsForTest(
  memory: WebAssembly.Memory,
  channelOffset: number,
  ptrWidth: 4 | 8,
  argv: string[] = [],
  env: string[] = [],
  secureExec: boolean = false,
): Record<string, WebAssembly.ExportValue> {
  return buildKernelImports(
    memory,
    channelOffset,
    ptrWidth,
    argv,
    env,
    secureExec,
  );
}

/**
 * Names the loader must never publish as main-image symbols.
 *
 * They are the loader's own per-module import contract — every side module gets
 * its own `__memory_base`, its own `__table_base`, and the process's one memory,
 * table, stack pointer and exception tags. Publishing the main image's under
 * these names would let a side module resolve them from the global scope and
 * shadow the ones the planner bound for it.
 */
const MAIN_IMAGE_RESERVED_EXPORTS: ReadonlySet<string> = new Set([
  "memory",
  "__indirect_function_table",
  "__memory_base",
  "__table_base",
  "__stack_pointer",
  "__c_longjmp",
  "__cpp_exception",
  FORK_UNWIND_TAG_IMPORT_NAME,
]);

/**
 * Describe the main image for the planner: its public symbols, and which table
 * slots its element segments already occupy.
 *
 * The slot map is built by scanning the table ONCE against the instance's own
 * exports. `dylink.ts:4037-4067` did the same scan on every `dlsym` of a
 * function; the planner keeps the map instead and never scans again, so this is
 * the only place the identity comparison happens.
 */
function describeMainImage(
  instance: WebAssembly.Instance | undefined,
  table: WebAssembly.Table,
): MainImage {
  const exports: [string, SymbolValue][] = [];
  const elementSlots: [bigint, number, string][] = [];
  const length = tableLength(table);
  if (!instance) {
    return { tableLength: BigInt(length), exports, elementSlots };
  }
  const byFunction = new Map<Function, string>();
  for (const [name, exported] of Object.entries(instance.exports)) {
    if (MAIN_IMAGE_RESERVED_EXPORTS.has(name)) continue;
    if (typeof exported === "function") {
      exports.push([name, { kind: "func", instance: 0, export: name }]);
      // A function exported under two names occupies one slot; the first name
      // wins, exactly as the scan it replaces did.
      if (!byFunction.has(exported as Function)) {
        byFunction.set(exported as Function, name);
      }
      continue;
    }
    if (exported instanceof WebAssembly.Global) {
      const raw: unknown = exported.value;
      exports.push([
        name,
        {
          kind: "data",
          address: typeof raw === "bigint" ? raw : BigInt(Number(raw) >>> 0),
          binding: { kind: "export", instance: 0, name },
        },
      ]);
    }
  }
  for (let slot = 0; slot < length; slot++) {
    let entry: unknown;
    try {
      entry = getTableEntry(table, slot);
    } catch {
      // A table whose element type this embedding cannot read back is not a
      // funcref table the loader can index; leave it out rather than guess.
      break;
    }
    if (typeof entry !== "function") continue;
    const name = byFunction.get(entry as Function);
    if (name !== undefined) elementSlots.push([BigInt(slot), 0, name]);
  }
  return { tableLength: BigInt(length), exports, elementSlots };
}

export interface DlopenSupport {
  imports: Record<string, WebAssembly.ExportValue>;
  /**
   * Decode the copied archive, and report the objects a child must name before
   * anything is rebuilt.
   *
   * The archive's records are read and validated inside the planner module; a
   * child needs only each object's name, activation id and image, because
   * module and reference recipes name activation coordinates rather than
   * whichever instance loads first.
   */
  readForkState: () => readonly LoaderArchivedModule[];
  /** Recreate the parent's live module and handle state from linear memory. */
  replayDlopens: (
    options?: { readonly memoryOwnership?: "copied" | "borrowed" },
  ) => void;
  /** Clear a fork parent's copied archive lock in ordinary child memory. */
  resetForkChildLock: () => void;
  /** The process's loader, which owns the archive. */
  readonly loader: () => DylinkLoader;
  /**
   * The publication fence, read straight from process memory.
   *
   * Separate from {@link DlopenSupport.loader} because a caller can need the
   * generation before a loader can exist: the loader requires the main image's
   * table and stack pointer, and a table replica is built while the worker is
   * still assembling itself.
   */
  readonly archiveGeneration: () => number;
  /** Acquire one reentrant process-archive writer depth, blocking if needed. */
  acquireArchiveWriter(): void;
  /** Release exactly one writer depth acquired by this Worker. */
  releaseArchiveWriter(): void;
  withArchiveWriter<T>(operation: () => T): T;
  /**
   * Install how the writer asks whether this Worker's fork holds the archive
   * READER. The fork module owns that token (lane F step 3c, ruling 4).
   */
  setForkReaderProbe(probe: () => boolean): void;
  writerOwned(): boolean;
  /** Run after a fresh writer acquisition and before the protected operation. */
  setWriterAcquireObserver(observer: () => void): void;
  /** Clean up state owned by a failed linker operation before releasing it. */
  setOperationAbortObserver(observer: () => void): void;
  setCommitObserver(
    observer: (
      linkerPublication: LoaderTableState | undefined,
      tableMutationCommitted: boolean,
    ) => void,
  ): void;
}

interface ProcessDylinkActivationOwnerOptions {
  readonly importedStateCapture?: ForkImportIdentity;
  /** The host's record of live activations; see `fork-activations.ts`. */
  readonly activations: ForkActivations;
  readonly tableReplication: ForkActivationTableReplication;
  /**
   * The child planner needs the copied dlopen archive, while the archive
   * reader needs the activation owner installed first. Resolve it lazily at
   * the actual side-module instantiation boundary to break that construction
   * cycle without permitting a side activation to instantiate unplanned.
   */
  readonly importedStatePlanner?: () => ForkChildImports | null;
  /**
   * The process's host identity floor, shared by every activation.
   *
   * Process-level rather than per-activation because both members are: the
   * reference identity maps are keyed by object identity across the whole
   * capture, and the exception throwers route by owner inside the broker.
   */
  readonly isForkChild: boolean;
  /**
   * A pthread owns a separate instance graph but adopts the process archive's
   * stable activation coordinates. Unlike a fork child it captures live state
   * and therefore uses the parent imported-state owner and bootstrap path.
   */
  readonly isPthreadReplica?: boolean;
  readonly invokeProcessFork: () => number;
  /**
   * Phase 6 D7a.1a: when present (a qualifying module-backed dlopen fork), each
   * side activation's five frozen frame/resume imports are flipped to its own
   * trampoline (wasm->wasm), and the activation is admitted into the module
   * (`admitActivation`) before it instantiates.
   */
  readonly forkModuleFrameFlip?: {
    /**
     * The shared fork-module's exports, which carry one pre-emitted frame entry
     * point per activation. The module folds the activation id in, so nothing
     * here synthesizes or caches anything per activation.
     */
    readonly moduleExports: Record<string, unknown>;
    readonly backend: ForkModuleContinuationBackend;
  };
  readonly label: string;
}

/**
 * Bind every instrumented side-module instance to the one process
 * continuation transaction.
 *
 * Activation IDs are coordinates in KFMS recipes and replay events, copied
 * verbatim through the dlopen replay archive, and they are NOT REUSED yet.
 * The fork module has 64 per-activation entries, so a process's 63rd side
 * activation fails its `dlopen` loudly however few libraries are open. A
 * `dlclose` is still local to the closing Worker: a peer thread keeps its
 * replica of the closed library, and reusing its id there made that peer
 * hang instead of failing. Reuse returns when closes propagate to other
 * threads -- docs/superpowers/plans/2026-09-23-fork-test-only-removal.md,
 * T4 item 2. The id stays here rather than in `crates/dylink`: it is claimed
 * before the loader instantiates anything and is also chosen by fork-child
 * and pthread replay, so moving it is a loader-protocol change of its own.
 */
function createProcessDylinkActivationOwner(
  options: ProcessDylinkActivationOwnerOptions,
): LoaderForkActivationOwner {
  let nextActivationId = 1;
  const claimed = new Set<number>();

  const claimActivationId = (
    replayActivationId: number | undefined,
  ): number => {
    const activationId = replayActivationId ?? nextActivationId;
    if (
      !Number.isInteger(activationId) ||
      activationId <= 0 ||
      activationId > 0xffff_ffff
    ) {
      throw new RangeError(
        `${options.label}: side-module activation id ${String(activationId)} is invalid`,
      );
    }
    if (claimed.has(activationId)) {
      throw new Error(
        `${options.label}: side-module activation id ${activationId} was claimed twice`,
      );
    }
    claimed.add(activationId);
    nextActivationId = Math.max(nextActivationId, activationId + 1);
    return activationId;
  };

  return {
    prepare(request) {
      if (options.isForkChild && request.replayActivationId === undefined) {
        throw new Error(
          `${request.name}: fresh-child replay is missing its activation id`,
        );
      }
      // WHY: any live process Worker may reconcile an activation published by
      // a peer or originate dlopen while holding the process archive writer.
      // Its writer-acquire hook first adopts every published activation, so
      // the same monotonic allocator safely claims the next process-wide ID.
      const activationId = claimActivationId(request.replayActivationId);
      let registered = false;
      let released = false;
      let importedStatePreparation: PreparedForkParentActivation | null = null;
      let childImportedStatePlanner: ForkChildImports | null = null;
      let importedStateRegistered = false;
      let importsWrapped = false;
      // The co-resident module is the ONLY capture/replay implementation on this
      // path (Phase 4 point of no return), so a side activation without one is a
      // programming error rather than a reason to fall back.
      if (!options.forkModuleFrameFlip) {
        throw new Error(
          `${request.name}: side activation ${activationId} has no fork module; ` +
            "there is no JavaScript continuation to fall back to",
        );
      }
      // ADMITTED before anything is instantiated, on the parent (dlopen) and
      // the child (replayDlopens) alike: every section of the side module goes
      // to the module, which decodes and checks it here -- pointer width
      // against this worker, the resume catalog, both codecs, KFIG/KFIT. A
      // child's pre-instantiation planner already admitted the same facts, so
      // this is its no-op. The host decodes none of it.
      options.forkModuleFrameFlip.backend.admitActivation(
        activationId,
        request.module,
        computeForkModuleTemplateId(request.moduleBytes),
      );
      const activationLabel = `${request.name}: fork activation`;
      const guestImports = buildForkGuestImports({
          moduleExports: options.forkModuleFrameFlip.moduleExports,
          // What a JS host genuinely supplies, and only that. Everything else
          // the guest imports comes from the module, and anything neither side
          // provides fails here BY NAME rather than as a LinkError naming a type.
          extras: {
            fork: (): number => options.invokeProcessFork(),
            // The resume table is NOT here any more. The module owns and
            // exports it, so `buildForkGuestImports` binds it from
            // `moduleExports` -- one object for the guest's import, the
            // module's numbering and this host's placement.
            [FORK_GUEST_ACTIVATION_GLOBAL_IMPORT]: new WebAssembly.Global(
              { value: "i32", mutable: false },
              activationId,
            ),
            [FORK_GUEST_TABLE_GENERATION_ADDR_IMPORT]:
              options.tableReplication.generationAddress,
          },
          guestModule: request.module,
          label: activationLabel,
      }) as Record<string, WebAssembly.ImportValue>;
      const env: Record<string, WebAssembly.ImportValue> = {
        ...guestImports,
        // Phase 6 D7a.1a FRAME FLIP: this side activation's five frozen
        // frame/resume imports route through its OWN trampoline, folding in the
        // activation id. After the binder on purpose: the module's plain
        // `__wpk_fork_frame_*` exports assume the primary activation, so a side
        // activation binding those would write its frames into activation 0's.
        ...(forkActivationFrameImports(
          options.forkModuleFrameFlip.moduleExports,
          activationId,
          activationLabel,
        ) as Record<string, WebAssembly.ImportValue>),
      };

      return {
        activationId,
        env,
        savedMutableGlobalImport(moduleName, importName) {
          if (!options.isForkChild) return undefined;
          // The dylink planner asks for a saved `GOT.func` value while it is
          // still MAKING the GOT cells, which is before instantiation and so
          // before `wrapImports`. Resolve the planner lazily here too, as
          // `wrapImports` does: the fork child built it before replaying any
          // dlopen. Requiring `wrapImports` first failed every replayed side
          // module with a `GOT.func` import the request did not carry.
          const planner = childImportedStatePlanner ?? options.importedStatePlanner?.();
          if (!planner) {
            throw new Error(`${request.name}: activation ${activationId} has no imported-state plan`);
          }
          return planner.savedMutableGlobalImport(
            activationId,
            moduleName,
            importName,
          );
        },
        wrapImports: (imports) => {
          if (importsWrapped) {
            throw new Error(
              `${request.name}: activation ${activationId} wrapped its imports twice`,
            );
          }
          importsWrapped = true;
          childImportedStatePlanner = options.importedStatePlanner?.() ?? null;
          if (options.isForkChild && !childImportedStatePlanner) {
            throw new Error(
              `${request.name}: child activation ${activationId} has no ` +
                "pre-instantiation imported-state plan",
            );
          }
          let resolvedImports = imports;
          if (childImportedStatePlanner) {
            resolvedImports = childImportedStatePlanner.importsForActivation(
              activationId,
              imports as unknown as ForkWasmImports,
            ) as unknown as WebAssembly.Imports;
          }
          if (!options.importedStateCapture) return resolvedImports;
          // WHY: a fresh child must become a parent-capable owner after replay.
          // Plan the copied identities first, then observe the exact Global and
          // Table objects WebAssembly binds so a later fork can publish fresh
          // provenance instead of depending on its parent's consumed arena.
          importedStatePreparation =
            options.importedStateCapture.prepareActivation(
              activationId,
              request.module,
              resolvedImports,
            );
          return importedStatePreparation.imports as unknown as WebAssembly.Imports;
        },
        register(instance) {
          // `importsWrapped`, NOT a `prepared` flag. There was one, set by the
          // coordinator's `prepareActivation`; `18762e9cb` deleted the
          // coordinator and left the flag permanently false, so this refused
          // EVERY dlopen side module from that commit until the suite could run
          // again. Nothing caught it because nothing ran.
          //
          // The precondition it was standing in for is real and is this one: an
          // activation whose imports were never wrapped has no recorded import
          // provenance, so a later capture would have nothing to say about what
          // it imported.
          if (released || registered || !importsWrapped) {
            throw new Error(
              `${request.name}: side-module activation ${activationId} ` +
                "cannot be registered before its imports are wrapped",
            );
          }
          if (options.importedStateCapture) {
            if (!importedStatePreparation) {
              throw new Error(
                `${request.name}: activation ${activationId} did not wrap its final imports`,
              );
            }
            importedStatePreparation.complete(instance);
            importedStateRegistered = true;
          }
          if (options.isForkChild && !childImportedStatePlanner) {
            throw new Error(
              `${request.name}: child activation ${activationId} did not wrap its final imports`,
            );
          }
          // Remembering it here also BINDS it (`fm_bind_activation`): its
          // drive slots, so the module can `call_indirect` this guest's
          // unwind/rewind/abort entry points, and its resume thunks, which the
          // guest places itself from the row. The drive bind used to happen in
          // one sweep during the child install, which left a parent's slots
          // unbound until it forked.
          options.activations.register({ activationId, instance });
          registered = true;
          childImportedStatePlanner?.registerInstance(activationId, instance);
          if (
            options.isPthreadReplica &&
            request.replayActivationId !== undefined
          ) {
            const threadBootstrap =
              instance.exports[WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP];
            if (typeof threadBootstrap !== "function") {
              throw new Error(
                `${request.name}: pthread replica is missing its table bootstrap`,
              );
            }
            // WHY: this Worker needs fresh instance-local element functions,
            // but process linear memory and constructors are already live.
            // The thread helper initializes only tables and drops data
            // segments; the parent bootstrap would re-run side effects.
            threadBootstrap();
          }
        },
        unregister() {
          if (released) {
            throw new Error(
              `${request.name}: side-module activation ${activationId} was released twice`,
            );
          }
          released = true;
          let failure: unknown;
          try {
            // One module release either way -- the activation's slots,
            // records and table ranges. A `dlopen` that failed part way has
            // seeds but no placed thunks. The id is not given back (see the
            // function comment).
            try {
              if (registered) options.activations.forget(activationId);
              else options.forkModuleFrameFlip?.backend.releaseResumeSlots(activationId, true);
            } catch (error) {
              failure = error;
            }
            if (!importedStateRegistered && importedStatePreparation) {
              try {
                importedStatePreparation.abort();
              } catch (error) {
                failure ??= error;
              }
            }
          } finally {
            registered = false;
            importedStatePreparation = null;
            childImportedStatePlanner = null;
            importedStateRegistered = false;
            importsWrapped = false;
          }
          if (failure !== undefined) throw failure;
        },
      };
    },
  };
}

/**
 * Wasm-owned codecs for reference hierarchies that cannot appear in a
 * JavaScript function signature.
 *
 * These are intentionally dependencies, not optional fallbacks. The
 * activation provider registry must resolve them before instantiating a module
 * that imports the corresponding ABI hook.
 */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function checkedWasmByteLength(
  value: number | bigint,
  context: string,
): number {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(
      `${context}: length is not an exact non-negative JavaScript integer`,
    );
  }
  const exact = typeof value === "bigint" ? value : BigInt(value);
  if (exact < 0n || exact > MAX_SAFE_BIGINT) {
    throw new RangeError(
      `${context}: length is not an exact non-negative JavaScript integer`,
    );
  }
  return Number(exact);
}

function checkedWasmMemoryRange(
  memory: WebAssembly.Memory,
  pointer: WasmGuestPointer,
  lengthValue: number | bigint,
  ptrWidth: 4 | 8,
  context: string,
): { offset: number; length: number } {
  const offset = checkedWasmGuestPointerOffset(pointer, ptrWidth, context);
  const length = checkedWasmByteLength(lengthValue, context);
  const memoryLength = memory.buffer.byteLength;
  if (offset > memoryLength || length > memoryLength - offset) {
    throw new RangeError(
      `${context}: memory range [${offset}, ${offset + length}) exceeds ${memoryLength} bytes`,
    );
  }
  return { offset, length };
}

/**
 * Build dlopen host imports for a process. These are called directly from
 * the user program's dlopen/dlsym/dlclose C stubs (libc/glue/dlopen.c).
 *
 * The DynamicLinker is lazily created on first use since most programs
 * don't use dlopen.
 *
 * Each successful dlopen is also persisted into a per-process archive
 * (linked list in linear memory, with control slots below the main process
 * channel's fork buffer) so the fork child can replay them via
 * `replayDlopens`. The archive anchor is deliberately independent of the
 * call-site rewind buffer: a fork issued by a pthread rewinds from that
 * thread's buffer but still inherits the one process-wide dlopen archive.
 */
/** @internal Exported so the pointer-width host import contract can be tested directly. */
export function buildDlopenImports(
  memory: WebAssembly.Memory,
  channelOffset: number,
  archiveControlAddr: number,
  getTable: () => WebAssembly.Table | undefined,
  getStackPointer: () => WebAssembly.Global | undefined,
  getInstance: () => WebAssembly.Instance | undefined,
  ptrWidth: 4 | 8,
  longjmpTag: WebAssembly.Tag | undefined,
  cppExceptionTag: WebAssembly.Tag | undefined,
  forkActivationOwner?: LoaderForkActivationOwner,
  forkActivationOwnerUnavailableReason?: string,
  forkUnwindTag?: WebAssembly.Tag,
  onTableMutation?: (
    table: WebAssembly.Table,
    firstIndex: number,
    length: number,
  ) => void,
  routeFunctionImport?: typeof guardFunctionImport,
  workerIdentity = 1,
  memoryOwnership: "copied" | "borrowed" = "copied",
  plannerModule?: WebAssembly.Module,
): DlopenSupport {
  if (
    !Number.isInteger(workerIdentity) ||
    workerIdentity <= 0 ||
    workerIdentity > 0x7fff_ffff
  ) {
    throw new RangeError(
      `invalid dynamic-loader Worker identity ${String(workerIdentity)}`,
    );
  }
  let linker: DylinkLoader | null = null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const n = (v: number | bigint): number =>
    typeof v === "bigint" ? Number(v) : v;
  const requireOwnedMemory = (operation: string): void => {
    if (memoryOwnership === "borrowed") {
      throw new Error(
        `borrowed vfork child cannot ${operation} before exec or _exit`,
      );
    }
  };

  const headOffset =
    ptrWidth === 8 ? DLOPEN_HEAD_OFFSET_WASM64 : DLOPEN_HEAD_OFFSET_WASM32;
  const lockOffset =
    ptrWidth === 8 ? DLOPEN_LOCK_OFFSET_WASM64 : DLOPEN_LOCK_OFFSET_WASM32;
  const generationOffset =
    ptrWidth === 8
      ? DLOPEN_GENERATION_OFFSET_WASM64
      : DLOPEN_GENERATION_OFFSET_WASM32;
  const ownerOffset =
    ptrWidth === 8 ? DLOPEN_OWNER_OFFSET_WASM64 : DLOPEN_OWNER_OFFSET_WASM32;
  const headSlot = archiveControlAddr - headOffset;
  const archiveLock = new Int32Array(
    memory.buffer,
    archiveControlAddr - lockOffset,
    1,
  );
  const loaderOwner = new Int32Array(
    memory.buffer,
    archiveControlAddr - ownerOffset,
    1,
  );
  const generationSlot = archiveControlAddr - generationOffset;
  const readGenerationFence = (): number => {
    const value =
      typeof SharedArrayBuffer !== "undefined" &&
      memory.buffer instanceof SharedArrayBuffer
        ? Atomics.load(new BigUint64Array(memory.buffer, generationSlot, 1), 0)
        : new DataView(memory.buffer).getBigUint64(generationSlot, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(
        "dlopen process generation exceeds exact host integers",
      );
    }
    return Number(value);
  };
  const writeGenerationFence = (generation: number): void => {
    requireOwnedMemory("publish a dynamic-loader generation");
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new RangeError(
        `invalid dlopen process generation ${String(generation)}`,
      );
    }
    if (
      typeof SharedArrayBuffer !== "undefined" &&
      memory.buffer instanceof SharedArrayBuffer
    ) {
      Atomics.store(
        new BigUint64Array(memory.buffer, generationSlot, 1),
        0,
        BigInt(generation),
      );
    } else {
      new DataView(memory.buffer).setBigUint64(
        generationSlot,
        BigInt(generation),
        true,
      );
    }
  };
  const readArchiveHead = (): number =>
    ptrWidth === 8
      ? Number(Atomics.load(new BigUint64Array(memory.buffer, headSlot, 1), 0))
      : Atomics.load(new Uint32Array(memory.buffer, headSlot, 1), 0);
  const writeArchiveHead = (value: number): void => {
    requireOwnedMemory("replace the dynamic-loader archive");
    if (ptrWidth === 8) {
      Atomics.store(
        new BigUint64Array(memory.buffer, headSlot, 1),
        0,
        BigInt(value),
      );
    } else {
      Atomics.store(new Uint32Array(memory.buffer, headSlot, 1), 0, value);
    }
  };
  const linkerAllocations = new Map<
    number,
    { rawAddr: number; length: number }
  >();
  let hostDlopenError: string | null = null;
  let mainDlopenDepth = 0;
  // Whether this Worker's fork holds the process archive READER. The fork
  // module owns that token (lane F step 3c, ruling 4); the loader asks it,
  // through `setForkReaderProbe`, before taking the writer.
  let forkReaderHeld: () => boolean = () => false;
  const ownedDlopenTransactions = new Set<number>();
  let tableMutationPending = false;
  let commitObserver:
    | ((
        linkerPublication: LoaderTableState | undefined,
        tableMutationCommitted: boolean,
      ) => void)
    | null = null;
  let writerAcquireObserver: (() => void) | null = null;
  let operationAbortObserver: (() => void) | null = null;
  const finishFreshWriterAcquisition = (): void => {
    mainDlopenDepth = 1;
    try {
      writerAcquireObserver?.();
    } catch (error) {
      releaseMainDlopenLock();
      throw error;
    }
  };
  const foreignLoaderOwner = (): number => {
    const owner = Atomics.load(loaderOwner, 0);
    return owner !== DLOPEN_OWNER_IDLE && owner !== workerIdentity
      ? owner
      : DLOPEN_OWNER_IDLE;
  };
  const releaseRawWriterLock = (): void => {
    const owner = Atomics.compareExchange(
      archiveLock,
      0,
      DLOPEN_LOCK_WRITER,
      DLOPEN_LOCK_IDLE,
    );
    if (owner !== DLOPEN_LOCK_WRITER) {
      throw new Error(
        `dlopen process lock lost writer ownership (state=${owner})`,
      );
    }
    Atomics.notify(archiveLock, 0);
  };
  const claimLoaderOwnership = (): void => {
    if (mainDlopenDepth <= 0) {
      throw new Error("dynamic-loader ownership requires the archive writer");
    }
    const owner = Atomics.compareExchange(
      loaderOwner,
      0,
      DLOPEN_OWNER_IDLE,
      workerIdentity,
    );
    if (owner !== DLOPEN_OWNER_IDLE && owner !== workerIdentity) {
      throw new Error(`dynamic-loader ownership belongs to Worker ${owner}`);
    }
  };
  const releaseLoaderOwnershipIfIdle = (): void => {
    if (ownedDlopenTransactions.size !== 0) return;
    const owner = Atomics.compareExchange(
      loaderOwner,
      0,
      workerIdentity,
      DLOPEN_OWNER_IDLE,
    );
    if (owner !== workerIdentity && owner !== DLOPEN_OWNER_IDLE) {
      throw new Error(`dynamic-loader ownership changed to Worker ${owner}`);
    }
    Atomics.notify(loaderOwner, 0);
  };
  const acquireMainDlopenLock = (): boolean => {
    // POSIX loader serialization is blocking. Imports run in process Workers,
    // so Atomics.wait can suspend only the contending pthread while the owner
    // continues its staged guest initializer in a different Worker.
    acquireArchiveWriter();
    return true;
  };
  const releaseMainDlopenLock = (): void => {
    if (mainDlopenDepth <= 0) {
      throw new Error("dlopen process lock released without ownership");
    }
    mainDlopenDepth--;
    if (mainDlopenDepth === 0) {
      releaseRawWriterLock();
    }
  };
  const withArchiveWriter = <T>(operation: () => T): T => {
    acquireArchiveWriter();
    try {
      return operation();
    } finally {
      releaseMainDlopenLock();
    }
  };
  const acquireArchiveWriter = (): void => {
    requireOwnedMemory("acquire the dynamic-loader archive writer");
    if (forkReaderHeld()) {
      throw new Error(
        "cannot acquire the process archive writer while this Worker's fork holds a reader",
      );
    }
    if (mainDlopenDepth > 0) {
      mainDlopenDepth++;
      return;
    }
    for (;;) {
      const transactionOwner = foreignLoaderOwner();
      if (transactionOwner !== DLOPEN_OWNER_IDLE) {
        Atomics.wait(loaderOwner, 0, transactionOwner);
        continue;
      }
      const owner = Atomics.compareExchange(
        archiveLock,
        0,
        DLOPEN_LOCK_IDLE,
        DLOPEN_LOCK_WRITER,
      );
      if (owner === DLOPEN_LOCK_IDLE) {
        const racedTransactionOwner = foreignLoaderOwner();
        if (racedTransactionOwner === DLOPEN_OWNER_IDLE) break;
        releaseRawWriterLock();
        Atomics.wait(loaderOwner, 0, racedTransactionOwner);
        continue;
      }
      Atomics.wait(archiveLock, 0, owner);
    }
    finishFreshWriterAcquisition();
  };
  const notifyCommit = (publication: LoaderTableState | undefined): void => {
    const mutated = tableMutationPending;
    tableMutationPending = false;
    commitObserver?.(publication, mutated);
  };
  /**
   * Publish the loader's state and report what a table replica needs from it.
   *
   * The archive's layout, its record reuse and the ORDERING of its generation
   * write are decided in `crates/dylink::archive`; this only asks for the
   * publication and reads back the table half, which is the one part of the
   * archive that is not loader state.
   */
  const publishArchive = (): LoaderTableState => {
    const loader = getLinker();
    loader.syncArchive();
    return loader.tableState();
  };
  const abortLinkerOperation = (): void => {
    tableMutationPending = false;
    operationAbortObserver?.();
  };

  const invokeChannelSyscall = (
    syscall: number,
    args: readonly (number | bigint)[],
  ): { result: number; errno: number } => {
    const view = new DataView(memory.buffer);
    const base = channelOffset;
    view.setInt32(base + CH_SYSCALL, syscall, true);
    for (let i = 0; i < 6; i++) {
      view.setBigInt64(
        base + CH_ARGS + i * CH_ARG_SIZE,
        BigInt(args[i] ?? 0),
        true,
      );
    }
    markDeferredSignalDelivery(view, base);
    const i32 = new Int32Array(memory.buffer);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
    Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
    while (
      Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok"
    ) {
      /* wait for the kernel Worker */
    }
    const result = Number(view.getBigInt64(base + CH_RETURN, true));
    const errno = view.getUint32(base + CH_ERRNO, true);
    clearDeferredSignalDelivery(view, base);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);
    return { result, errno };
  };

  // The kernel mmap allocator. Shared with the linker, but also used
  // directly by persistArchiveEntry to obtain blocks for the archive.
  const allocateMemory = (size: number, align: number): number => {
    requireOwnedMemory("allocate dynamic-loader memory");
    const requested = size + Math.max(align, 1) - 1;
    const view = new DataView(memory.buffer);
    const base = channelOffset;
    view.setInt32(base + CH_SYSCALL, SYS_MMAP_NR, true);
    view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, 0n, true);
    view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(requested), true);
    view.setBigInt64(
      base + CH_ARGS + 2 * CH_ARG_SIZE,
      BigInt(PROT_READ_WRITE),
      true,
    );
    view.setBigInt64(
      base + CH_ARGS + 3 * CH_ARG_SIZE,
      BigInt(MAP_PRIVATE_ANONYMOUS),
      true,
    );
    view.setBigInt64(base + CH_ARGS + 4 * CH_ARG_SIZE, -1n, true);
    view.setBigInt64(base + CH_ARGS + 5 * CH_ARG_SIZE, 0n, true);

    markDeferredSignalDelivery(view, base);
    const i32 = new Int32Array(memory.buffer);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
    Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
    while (
      Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok"
    ) {
      /* wait for mmap */
    }

    const result = Number(view.getBigInt64(base + CH_RETURN, true));
    const err = view.getUint32(base + CH_ERRNO, true);
    clearDeferredSignalDelivery(view, base);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

    if (err || result < 0) {
      throw new Error(
        `dlopen: mmap(${requested}) failed errno=${err || -result}`,
      );
    }
    const aligned = alignUp(n(result), Math.max(align, 1));
    linkerAllocations.set(aligned, { rawAddr: n(result), length: requested });
    return aligned;
  };

  const deallocateMemory = (
    addr: number,
    size: number,
    allowCopiedArchiveAllocation = false,
  ): void => {
    requireOwnedMemory("release dynamic-loader memory");
    const allocation = linkerAllocations.get(addr);
    if (!allocation && !allowCopiedArchiveAllocation) {
      throw new Error(
        `dlopen rollback: unknown allocation 0x${addr.toString(16)}`,
      );
    }
    const rawAddr = allocation?.rawAddr ?? addr;
    const length = allocation?.length ?? size;
    if (
      !Number.isSafeInteger(rawAddr) ||
      rawAddr <= 0 ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      rawAddr > memory.buffer.byteLength - length
    ) {
      throw new Error("dlopen archive release names an invalid copied mapping");
    }
    const view = new DataView(memory.buffer);
    const base = channelOffset;
    view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Munmap, true);
    view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, BigInt(rawAddr), true);
    view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(length), true);
    for (let i = 2; i < 6; i++) {
      view.setBigInt64(base + CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }

    markDeferredSignalDelivery(view, base);
    const i32 = new Int32Array(memory.buffer);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
    Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
    while (
      Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok"
    ) {
      /* wait */
    }

    const result = Number(view.getBigInt64(base + CH_RETURN, true));
    const err = view.getUint32(base + CH_ERRNO, true);
    clearDeferredSignalDelivery(view, base);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);
    if (err || result < 0) {
      throw new Error(`dlopen rollback: munmap failed errno=${err || -result}`);
    }
    if (allocation) linkerAllocations.delete(addr);
  };

  const describeMemoryAllocation = (
    address: number,
    size: number,
  ): Readonly<{ mappingAddress: number; mappingSize: number }> => {
    const allocation = linkerAllocations.get(address);
    if (!allocation) {
      throw new Error(
        `dlopen: allocation 0x${address.toString(16)} has no mmap owner`,
      );
    }
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      address > allocation.rawAddr + allocation.length - size
    ) {
      throw new RangeError("dlopen: logical allocation escapes its mmap owner");
    }
    return {
      mappingAddress: allocation.rawAddr,
      mappingSize: allocation.length,
    };
  };

  const adoptMemoryAllocation = (
    allocation: Readonly<{
      address: number;
      size: number;
      mappingAddress: number;
      mappingSize: number;
    }>,
  ): void => {
    const existing = linkerAllocations.get(allocation.address);
    if (existing) {
      if (
        existing.rawAddr === allocation.mappingAddress &&
        existing.length === allocation.mappingSize
      )
        return;
      throw new Error(
        `dlopen replay: allocation 0x${allocation.address.toString(16)} ` +
          "has conflicting mmap ownership",
      );
    }
    if (
      !Number.isSafeInteger(allocation.mappingAddress) ||
      allocation.mappingAddress <= 0 ||
      !Number.isSafeInteger(allocation.mappingSize) ||
      allocation.mappingSize <= 0 ||
      allocation.address < allocation.mappingAddress ||
      allocation.address + allocation.size >
        allocation.mappingAddress + allocation.mappingSize ||
      allocation.mappingAddress >
        memory.buffer.byteLength - allocation.mappingSize
    ) {
      throw new RangeError("dlopen replay: invalid copied mmap ownership");
    }
    linkerAllocations.set(allocation.address, {
      rawAddr: allocation.mappingAddress,
      length: allocation.mappingSize,
    });
  };

  // WHAT USED TO BE HERE: `forgetMemoryAllocation`, the unload half of the
  // dlopen linker-allocation bookkeeping. It has no caller: nothing in this
  // worker unloads a peer's library. Deleted rather than kept as the half of a
  // pair whose other half nobody calls either.

  const readDependencyFile = (path: string): Uint8Array | null => {
    if (path.includes("\0")) {
      throw new Error("dlopen dependency path contains NUL");
    }
    const pathBytes = encoder.encode(`${path}\0`);
    const pathAddr = allocateMemory(pathBytes.length, 1);
    let openResult: { result: number; errno: number } | undefined;
    let pathFailure: unknown;
    try {
      new Uint8Array(memory.buffer, pathAddr, pathBytes.length).set(pathBytes);
      openResult = invokeChannelSyscall(ABI_SYSCALLS.Openat, [
        -100,
        pathAddr,
        0,
        0,
      ]);
    } catch (error) {
      pathFailure = error;
    } finally {
      try {
        deallocateMemory(pathAddr, pathBytes.length);
      } catch (error) {
        pathFailure ??= error;
      }
    }
    if (pathFailure !== undefined) {
      if (openResult && openResult.errno === 0 && openResult.result >= 0) {
        try {
          invokeChannelSyscall(ABI_SYSCALLS.Close, [openResult.result]);
        } catch {
          // Preserve the path-allocation failure.
        }
      }
      throw pathFailure;
    }
    if (!openResult) {
      throw new Error(`dlopen dependency open(${path}) returned no result`);
    }
    if (openResult.errno === 2 || openResult.errno === 20) return null;
    if (openResult.errno || openResult.result < 0) {
      throw new Error(
        `dlopen dependency open(${path}) failed errno=` +
          `${openResult.errno || -openResult.result}`,
      );
    }

    const fd = openResult.result;
    const chunkSize = 64 * 1024;
    const maxBytes = 64 * 1024 * 1024;
    let chunkAddr: number | undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let failure: unknown;
    try {
      chunkAddr = allocateMemory(chunkSize, 16);
      for (;;) {
        const read = invokeChannelSyscall(ABI_SYSCALLS.Read, [
          fd,
          chunkAddr,
          chunkSize,
        ]);
        if (read.errno || read.result < 0) {
          throw new Error(
            `dlopen dependency read(${path}) failed errno=` +
              `${read.errno || -read.result}`,
          );
        }
        if (read.result === 0) break;
        if (read.result > chunkSize) {
          throw new Error(
            `dlopen dependency read(${path}) returned ${read.result} bytes`,
          );
        }
        total += read.result;
        if (total > maxBytes) {
          throw new Error(
            `dlopen dependency ${path} exceeds ${maxBytes} bytes`,
          );
        }
        chunks.push(
          new Uint8Array(new Uint8Array(memory.buffer, chunkAddr, read.result)),
        );
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (chunkAddr !== undefined) {
          deallocateMemory(chunkAddr, chunkSize);
        }
      } catch (error) {
        failure ??= error;
      }
      try {
        const close = invokeChannelSyscall(ABI_SYSCALLS.Close, [fd]);
        if ((close.errno || close.result < 0) && failure === undefined) {
          failure = new Error(
            `dlopen dependency close(${path}) failed errno=` +
              `${close.errno || -close.result}`,
          );
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  };

  // WHAT USED TO BE HERE: `resolveLibrarySync`, a candidate-path walk for a
  // dlopen dependency. No caller: resolution goes through `readDependencyFile`
  // and the resolver, which is where the search order belongs.

  const getLinker = (): DylinkLoader => {
    if (linker) return linker;
    if (!plannerModule) {
      // The planner is the loader. Without it there is no `dlopen` at all, and
      // saying so here is the truthful failure: a process that silently loaded
      // nothing would fail much later, inside a side module's own code.
      throw new Error(
        "dlopen: this process worker has no dynamic-linking planner module; " +
          "rebuild dylink_module32.wasm",
      );
    }

    const inst = getInstance();

    // A main-defined/exported tag is the process ABI authority. If the main
    // image instead imports and re-exports the host tag, the identity is the
    // same; if it has no export, retain the process-owned fallback created
    // before main instantiation. Every side module must receive this one
    // canonical identity for cross-module exception propagation.
    const exportedLongjmpTag = inst?.exports.__c_longjmp;
    const canonicalLongjmpTag =
      exportedLongjmpTag === undefined
        ? longjmpTag
        : requireLongjmpTag(exportedLongjmpTag, "main module export");
    const exportedCppExceptionTag = inst?.exports.__cpp_exception;
    const canonicalCppExceptionTag =
      exportedCppExceptionTag === undefined
        ? cppExceptionTag
        : requireCppExceptionTag(exportedCppExceptionTag, "main module export");

    const created = new DylinkLoader(
      {
        module: plannerModule,
        memory,
        ptrWidth,
        table: () => {
          const current = getTable();
          if (!current) throw new Error("dlopen: program has no table");
          return current;
        },
        stackPointer: () => {
          const current = getStackPointer();
          if (!current) throw new Error("dlopen: program has no stack pointer");
          return current;
        },
        mainInstance: getInstance,
        allocateMemory,
        deallocateMemory,
        describeMemoryAllocation,
        adoptMemoryAllocation,
        readDependencyFile,
        readArchiveHead,
        writeArchiveHead,
        readGenerationFence,
        writeGenerationFence,
        ...(forkActivationOwner ? { forkActivationOwner } : {}),
        ...(forkActivationOwnerUnavailableReason === undefined
          ? {}
          : { forkActivationUnavailableReason: forkActivationOwnerUnavailableReason }),
        onTableMutation: (mutated, firstIndex, length) => {
          onTableMutation?.(mutated, firstIndex, length);
          tableMutationPending = true;
        },
        ...(routeFunctionImport ? { routeFunctionImport } : {}),
      },
      {
        pointerWidth: ptrWidth,
        hasAllocator: true,
        forkActivationAvailable: forkActivationOwner !== undefined,
        forkActivationUnavailableReason:
          forkActivationOwnerUnavailableReason ??
          "side modules require a process activation owner",
        unresolvedPolicy: "elfStrict",
        memoryBytes: BigInt(memory.buffer.byteLength),
        sharedMemory:
          typeof SharedArrayBuffer !== "undefined" &&
          memory.buffer instanceof SharedArrayBuffer,
      },
    );
    created.adoptProcessTags(canonicalLongjmpTag, canonicalCppExceptionTag);
    // Deferred: a fork child builds a loader to READ the archive it inherited,
    // before it has instantiated anything. That read needs no scope, and
    // demanding a table and stack pointer for it named the wrong thing.
    created.setMainImage(() => {
      const current = getTable();
      if (!current) throw new Error("dlopen: program has no table");
      return describeMainImage(getInstance(), current);
    });
    linker = created;
    return linker;
  };

  const readForkState = (): readonly LoaderArchivedModule[] => {
    const loader = getLinker();
    loader.readArchive();
    return loader.archivedModules();
  };

  const replayDlopens = (
    options: { readonly memoryOwnership?: "copied" | "borrowed" } = {},
  ): void => {
    // A process that never published has nothing to reconcile, and asking the
    // module is one call rather than a second copy of the state here.
    if (linker === null && readArchiveHead() === 0) return;

    // Materialize only missing modules, then adopt the parent's handle table.
    // Pthread Workers can call this for every process generation.
    const loader = getLinker();
    try {
      loader.readArchive();
      if (loader.archiveIsEmpty()) return;
      loader.reconcile(options.memoryOwnership ?? "copied");
    } catch (error) {
      abortLinkerOperation();
      throw error;
    } finally {
      // Replay materializes a publication already owned by the archive; its
      // local table writes are not a new source mutation to republish.
      tableMutationPending = false;
    }
  };

  const resetForkChildLock = (): void => {
    requireOwnedMemory("reset the parent's dynamic-loader lock");
    Atomics.store(archiveLock, 0, 0);
    Atomics.notify(archiveLock, 0);
    const copiedOwner = Atomics.load(loaderOwner, 0);
    if (copiedOwner !== DLOPEN_OWNER_IDLE) {
      // The loader continuation belongs to the one thread that survived fork.
      // Rebind its copied process lease to the child's new Worker coordinate.
      Atomics.store(loaderOwner, 0, workerIdentity);
    }
    Atomics.notify(loaderOwner, 0);
  };

  const readDlopenRequest = (
    bytesPtr: WasmGuestPointer,
    bytesLen: number | bigint,
    namePtr: WasmGuestPointer,
    nameLen: number | bigint,
  ): { readonly name: string; readonly bytes: Uint8Array } => {
    const bytesRange = checkedWasmMemoryRange(
      memory,
      bytesPtr,
      bytesLen,
      ptrWidth,
      "__wasm_dlopen_prepare bytes",
    );
    const nameRange = checkedWasmMemoryRange(
      memory,
      namePtr,
      nameLen,
      ptrWidth,
      "__wasm_dlopen_prepare name",
    );
    const bytes = new Uint8Array(
      memory.buffer,
      bytesRange.offset,
      bytesRange.length,
    );
    const nameBytes = new Uint8Array(
      memory.buffer,
      nameRange.offset,
      nameRange.length,
    );
    // WHY: compilation may grow/detach memory, and Firefox/Chrome reject
    // TextDecoder views backed directly by SharedArrayBuffer.
    return {
      // The first Kandelo dlopen import carried only (bytes, length) and
      // historically keyed the module as `dlopen:<buffer>:<length>`. The
      // current lowering supplies an empty name range for that exact form.
      name: nameRange.length === 0 && bytesRange.length !== 0
        ? `dlopen:${bytesRange.offset}:${bytesRange.length}`
        : decoder.decode(new Uint8Array(nameBytes)),
      bytes: new Uint8Array(bytes),
    };
  };

  const imports: Record<string, WebAssembly.ExportValue> = {
    __wasm_dlopen_main: (): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      try {
        return getLinker().dlopenMain();
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlopen_prepare: (
      bytesPtr: WasmGuestPointer,
      bytesLen: number | bigint,
      namePtr: WasmGuestPointer,
      nameLen: number | bigint,
      flags: number,
    ): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      let claimedLoader = false;
      try {
        if (!Number.isInteger(flags)) {
          throw new Error(
            `__wasm_dlopen_prepare requires ABI ${ABI_VERSION} dlopen flags; rebuild the process`,
          );
        }
        if (ownedDlopenTransactions.size === 0) {
          claimLoaderOwnership();
          claimedLoader = true;
        }
        const request = readDlopenRequest(bytesPtr, bytesLen, namePtr, nameLen);
        const transaction = getLinker().begin(
          request.name,
          request.bytes,
          (flags & RTLD_GLOBAL) !== 0,
        );
        if (transaction > 0) {
          ownedDlopenTransactions.add(transaction);
        } else if (claimedLoader) {
          releaseLoaderOwnershipIfIdle();
        }
        return transaction;
      } catch (error) {
        if (claimedLoader) releaseLoaderOwnershipIfIdle();
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlopen_next: (
      transaction: number,
      handlePtr?: WasmGuestPointer,
    ): number => {
      if (!acquireMainDlopenLock()) return -1;
      hostDlopenError = null;
      try {
        const linker = getLinker();
        if (
          !ownedDlopenTransactions.has(transaction) &&
          Atomics.load(loaderOwner, 0) === workerIdentity &&
          linker.hasPending(transaction)
        ) {
          // A fresh fork child reconstructed this token from the copied
          // archive. Its loader lease was rebound before module replay.
          ownedDlopenTransactions.add(transaction);
        }
        if (handlePtr === undefined) {
          // Transitional standalone callers still use the explicit commit
          // import. ABI-43 libc always supplies the output pointer and takes
          // the atomic finish path below.
          const entry = linker.nextInitialization(transaction);
          if (entry !== 0) {
            notifyCommit(publishArchive());
          }
          if (entry < 0) {
            ownedDlopenTransactions.delete(transaction);
            releaseLoaderOwnershipIfIdle();
          }
          return entry;
        }
        const handleRange = checkedWasmMemoryRange(
          memory,
          handlePtr,
          4,
          ptrWidth,
          "__wasm_dlopen_next handle",
        );
        const { entry, handle } = linker.advance(transaction);
        new DataView(memory.buffer).setInt32(handleRange.offset, handle, true);
        if (entry > 0) {
          // Publish the exact provisional activation/stage before libc can
          // enter it. A fork from that table call can therefore reconstruct
          // both the fresh side instance and the stopped loader generator.
          notifyCommit(publishArchive());
        } else {
          // Completion opens the public handle and removes the private
          // transaction in this same host transition. Rollback likewise
          // removes the issued entry before control returns to Wasm.
          notifyCommit(publishArchive());
          ownedDlopenTransactions.delete(transaction);
          releaseLoaderOwnershipIfIdle();
        }
        return entry;
      } catch (error) {
        getLinker().abort(transaction, error);
        ownedDlopenTransactions.delete(transaction);
        releaseLoaderOwnershipIfIdle();
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlopen_commit: (transaction: number): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      try {
        const linker = getLinker();
        const handle = linker.commit(transaction);
        notifyCommit(publishArchive());
        // WHY: commit deliberately returns zero without destroying a
        // transaction whose initializer is still outstanding. Retaining the
        // process lease keeps another pthread from interleaving loader state
        // if arbitrary Wasm calls this transitional import too early.
        if (!linker.hasPending(transaction)) {
          ownedDlopenTransactions.delete(transaction);
          releaseLoaderOwnershipIfIdle();
        }
        return handle;
      } catch (error) {
        getLinker().abort(transaction, error);
        ownedDlopenTransactions.delete(transaction);
        releaseLoaderOwnershipIfIdle();
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlopen: (
      bytesPtr: WasmGuestPointer,
      bytesLen: number | bigint,
      namePtr: WasmGuestPointer,
      nameLen: number | bigint,
      flags = RTLD_GLOBAL,
    ): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      let claimedLoader = false;
      try {
        if (!Number.isInteger(flags)) {
          throw new Error("__wasm_dlopen received invalid dlopen flags");
        }
        if (ownedDlopenTransactions.size === 0) {
          claimLoaderOwnership();
          claimedLoader = true;
        }
        const bytesRange = checkedWasmMemoryRange(
          memory,
          bytesPtr,
          bytesLen,
          ptrWidth,
          "__wasm_dlopen bytes",
        );
        const nameRange = checkedWasmMemoryRange(
          memory,
          namePtr,
          nameLen,
          ptrWidth,
          "__wasm_dlopen name",
        );
        // dlopen(NULL, ...) asks for the main program's global symbol scope.
        // No module bytes are involved; return the linker's reserved opaque
        // handle while preserving the existing host-import signature.
        if (bytesRange.length === 0 && nameRange.length === 0) {
          return getLinker().dlopenMain();
        }

        const bytes = new Uint8Array(
          memory.buffer,
          bytesRange.offset,
          bytesRange.length,
        );
        // Copy bytes since memory.buffer may detach during Wasm instantiation
        const bytesCopy = new Uint8Array(bytes);
        // TextDecoder.decode() rejects views backed by SharedArrayBuffer
        // in Firefox (and recent Chrome), so copy the name bytes through
        // a non-shared Uint8Array before decoding. Same shape as
        // bytesCopy above.
        const nameBytesView = new Uint8Array(
          memory.buffer,
          nameRange.offset,
          nameRange.length,
        );
        const nameBytesCopy = new Uint8Array(nameBytesView);
        const name = decoder.decode(nameBytesCopy);
        const lk = getLinker();
        const handle = lk.dlopenSync(name, bytesCopy, (flags & RTLD_GLOBAL) !== 0);
        if (handle > 0) {
          notifyCommit(publishArchive());
        } else {
          abortLinkerOperation();
        }
        return handle;
      } catch (error) {
        abortLinkerOperation();
        throw error;
      } finally {
        if (claimedLoader) releaseLoaderOwnershipIfIdle();
        releaseMainDlopenLock();
      }
    },

    __wasm_dlsym: (
      handle: number,
      namePtr: WasmGuestPointer,
      nameLen: number | bigint,
    ): number => {
      if (!acquireMainDlopenLock()) return 0;
      hostDlopenError = null;
      try {
        // See __wasm_dlopen above: copy off the shared buffer before
        // TextDecoder.decode() touches it.
        const nameRange = checkedWasmMemoryRange(
          memory,
          namePtr,
          nameLen,
          ptrWidth,
          "__wasm_dlsym name",
        );
        const nameBytesView = new Uint8Array(
          memory.buffer,
          nameRange.offset,
          nameRange.length,
        );
        const nameBytesCopy = new Uint8Array(nameBytesView);
        const name = decoder.decode(nameBytesCopy);
        const result = getLinker().dlsym(handle, name);
        notifyCommit(undefined);
        return result === null ? 0 : (result as number);
      } catch (error) {
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlclose: (handle: number): number => {
      if (!acquireMainDlopenLock()) return -1;
      hostDlopenError = null;
      try {
        const lk = getLinker();
        const result = lk.dlclose(handle);
        if (result === 0) {
          notifyCommit(publishArchive());
        } else {
          abortLinkerOperation();
        }
        return result;
      } catch (error) {
        abortLinkerOperation();
        throw error;
      } finally {
        releaseMainDlopenLock();
      }
    },

    __wasm_dlerror: (
      bufPtr: WasmGuestPointer,
      bufMax: number | bigint,
    ): number => {
      const err = hostDlopenError ?? getLinker().dlerror();
      hostDlopenError = null;
      if (!err) return 0;
      const encoded = encoder.encode(err);
      const maxLength = checkedWasmByteLength(bufMax, "__wasm_dlerror buffer");
      const range = checkedWasmMemoryRange(
        memory,
        bufPtr,
        Math.min(encoded.length, maxLength),
        ptrWidth,
        "__wasm_dlerror buffer",
      );
      new Uint8Array(memory.buffer, range.offset, range.length).set(
        encoded.subarray(0, range.length),
      );
      return range.length;
    },
  };

  if (memoryOwnership === "borrowed") {
    // POSIX permits a vfork child to call only exec-family functions or
    // _exit(). Keep every dynamic-loader entry point fail-closed so undefined
    // guest behavior cannot mutate the suspended parent's archive or memory.
    for (const name of Object.keys(imports)) {
      imports[name] = () => {
        throw new Error(
          `borrowed vfork child cannot call ${name} before exec or _exit`,
        );
      };
    }
  }

  return {
    imports,
    readForkState,
    replayDlopens,
    resetForkChildLock,
    loader: getLinker,
    archiveGeneration: () =>
      readArchiveHead() === 0 ? 0 : readGenerationFence(),
    acquireArchiveWriter,
    releaseArchiveWriter: releaseMainDlopenLock,
    withArchiveWriter,
    setForkReaderProbe: (probe: () => boolean) => {
      forkReaderHeld = probe;
    },
    writerOwned: () => mainDlopenDepth > 0,
    setWriterAcquireObserver: (observer) => {
      writerAcquireObserver = observer;
    },
    setOperationAbortObserver: (observer) => {
      operationAbortObserver = observer;
    },
    setCommitObserver: (observer) => {
      commitObserver = observer;
    },
  };
}

/**
 * Reject process artifacts that request a kernel function outside the exact
 * channel-mode CRT contract.
 *
 * WHY: supplying a zero-returning placeholder makes an obsolete or corrupt
 * direct-kernel syscall import look like success. It also cannot safely bridge
 * the process and kernel address spaces. Fail before instantiation so stale
 * artifacts are rebuilt through the supported channel path.
 */
export function assertSupportedKernelFunctionImports(
  module: WebAssembly.Module,
  kernelImports: Record<string, WebAssembly.ExportValue>,
): void {
  for (const imp of wasmModuleImports(module)) {
    if (
      imp.kind === "function"
      && imp.module === "kernel"
      && (
        !Object.hasOwn(kernelImports, imp.name)
        || typeof kernelImports[imp.name] !== "function"
      )
    ) {
      throw new Error(
        `Unsupported kernel import kernel.${imp.name}; `
          + "rebuild this program with the current Kandelo SDK",
      );
    }
  }
}

/**
 * Build the exact import object for a channel-mode Wasm module.
 */
function buildImportObject(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  kernelImports: Record<string, WebAssembly.ExportValue>,
  channelOffset: number,
  dlopenImports?: Record<string, WebAssembly.ExportValue>,
  getInstance?: () => WebAssembly.Instance | undefined,
  ptrWidth: 4 | 8 = 4,
  longjmpTag?: WebAssembly.Tag,
  cppExceptionTag?: WebAssembly.Tag,
  forkUnwindTag?: WebAssembly.Tag,
  postVmInterruptTimer?: (
    timedOutPtr: number,
    vmInterruptPtr: number,
    seconds: number,
  ) => void,
  forkEnvImports?: Record<string, WebAssembly.ImportValue>,
): WebAssembly.Imports {
  assertSupportedKernelFunctionImports(module, kernelImports);

  const envImports: Record<string, WebAssembly.ExportValue> = { memory };
  /** Convert wasm64 BigInt pointer to number (safe since addresses < 4GB) */
  const n = (v: number | bigint): number =>
    typeof v === "bigint" ? Number(v) : v;
  /** Wrap a number as the correct return type for pointer-returning imports */
  const retPtr = (v: number): number | bigint =>
    ptrWidth === 8 ? BigInt(v) : v;

  // Provide __channel_base as a mutable wasm global if the module imports it.
  // Each instance gets its own global, immune to cross-thread shared memory corruption.
  // On wasm64, __channel_base is i64 (BigInt); on wasm32 it's i32 (number).
  const moduleImports = wasmModuleImports(module);
  const importsFunction = (name: string): boolean =>
    moduleImports.some(
      (i) => i.module === "env" && i.name === name && i.kind === "function",
    );
  const linkedFrameImports = WPK_FORK_REQUIRED_IMPORTS.filter(
    ({ module }) => module === "env",
  );
  const linkedFrameImportCount = linkedFrameImports.filter(({ name }) =>
    importsFunction(name),
  ).length;
  if (
    linkedFrameImportCount !== 0 &&
    linkedFrameImportCount !== linkedFrameImports.length
  ) {
    throw new Error(
      "incomplete linked fork instrumentation imports; rebuild the program",
    );
  }
  if (linkedFrameImportCount !== 0) {
    if (!forkEnvImports) {
      throw new Error(
        "linked fork instrumentation requested without continuation and activation-state owners",
      );
    }
    for (const imported of moduleImports) {
      if (
        imported.module !== "env" ||
        !imported.name.startsWith("__wpk_fork_") ||
        (imported.name === FORK_UNWIND_TAG_IMPORT_NAME &&
          (imported.kind as string) === "tag")
      ) {
        continue;
      }
      const value = forkEnvImports[imported.name];
      if (value === undefined) {
        throw new Error(
          `linked fork activation owner is missing env.${imported.name}`,
        );
      }
      if (
        imported.kind !== "function" &&
        imported.kind !== "global" &&
        imported.kind !== "table"
      ) {
        throw new Error(
          `linked fork activation import env.${imported.name} has invalid kind ` +
            `${imported.kind}`,
        );
      }
      envImports[imported.name] = value as WebAssembly.ExportValue;
    }
  }
  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__channel_base" &&
        i.kind === "global",
    )
  ) {
    if (ptrWidth === 8) {
      envImports.__channel_base = new WebAssembly.Global(
        { value: "i64", mutable: true },
        BigInt(channelOffset),
      );
    } else {
      envImports.__channel_base = new WebAssembly.Global(
        { value: "i32", mutable: true },
        channelOffset,
      );
    }
  }

  // LLVM/lld >= 22 import this tag for setjmp users. The process owns its
  // identity so a longjmp thrown through a side module can be caught by the
  // main image (and vice versa).
  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__c_longjmp" &&
        (i.kind as string) === "tag",
    )
  ) {
    envImports.__c_longjmp = requireLongjmpTag(
      longjmpTag,
      "process module",
    ) as unknown as WebAssembly.ExportValue;
  }

  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__cpp_exception" &&
        (i.kind as string) === "tag",
    )
  ) {
    envImports.__cpp_exception = requireCppExceptionTag(
      cppExceptionTag,
      "process module",
    ) as unknown as WebAssembly.ExportValue;
  }
  if (
    moduleImports.some(
      (i) =>
        i.module === FORK_UNWIND_TAG_IMPORT_MODULE &&
        i.name === FORK_UNWIND_TAG_IMPORT_NAME &&
        (i.kind as string) === "tag",
    )
  ) {
    envImports[FORK_UNWIND_TAG_IMPORT_NAME] = requireForkUnwindTag(
      forkUnwindTag,
      "process module",
    ) as unknown as WebAssembly.ExportValue;
  }

  // Add dlopen imports if provided
  if (dlopenImports) {
    Object.assign(envImports, dlopenImports);
  }

  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__wasm_posix_vm_interrupt_after" &&
        i.kind === "function",
    )
  ) {
    if (!postVmInterruptTimer) {
      throw new Error(
        "VM interrupt timer import requested without a host timer route",
      );
    }
    envImports.__wasm_posix_vm_interrupt_after = (
      timedOutPtr: number | bigint,
      vmInterruptPtr: number | bigint,
      seconds: number | bigint,
    ): void => {
      postVmInterruptTimer(n(timedOutPtr), n(vmInterruptPtr), n(seconds));
    };
  }

  // C++ operator new/delete fallbacks — delegate to the wasm instance's malloc/free.
  // Normally resolved by MariaDB's my_new.cc (USE_MYSYS_NEW), but kept as safety net.
  if (getInstance) {
    const cppMalloc = (size: number | bigint): number | bigint => {
      const inst = getInstance();
      const malloc = inst?.exports.malloc as
        ((n: number | bigint) => number | bigint) | undefined;
      if (!malloc) return ptrWidth === 8 ? 0n : 0;
      return malloc(size || (ptrWidth === 8 ? 1n : 1));
    };
    const cppFree = (ptr: number | bigint): void => {
      const inst = getInstance();
      const free = inst?.exports.free as
        ((p: number | bigint) => void) | undefined;
      if (free) free(ptr);
    };
    envImports._Znwm = cppMalloc; // operator new(size_t)
    envImports._Znam = cppMalloc; // operator new[](size_t)
    envImports._ZdlPv = cppFree; // operator delete(void*)
    envImports._ZdlPvm = cppFree; // operator delete(void*, size_t)
    envImports._ZdaPv = cppFree; // operator delete[](void*)
    envImports._ZdaPvm = cppFree; // operator delete[](void*, size_t)
    envImports._ZnwmRKSt9nothrow_t = cppMalloc; // operator new(size_t, nothrow)
    envImports._ZnamRKSt9nothrow_t = cppMalloc; // operator new[](size_t, nothrow)
  }

  // C++ runtime stubs — libc++/libc++abi functions that may be imported when
  // the wasm binary links against empty stub archives.
  // __cxa_guard_acquire/release: thread-safe static initialization.
  // Wasm is single-threaded per instance so no real locking needed.
  envImports.__cxa_guard_acquire = (guardPtr: number | bigint): number => {
    const view = new Uint8Array(memory.buffer);
    if (view[n(guardPtr)]) return 0; // already initialized
    return 1; // needs initialization
  };
  envImports.__cxa_guard_release = (guardPtr: number | bigint): void => {
    const view = new Uint8Array(memory.buffer);
    view[n(guardPtr)] = 1; // mark initialized
  };
  envImports.__cxa_guard_abort = (_guardPtr: number | bigint): void => {
    /* no-op */
  };
  envImports.__cxa_pure_virtual = (): void => {
    throw new Error("pure virtual method called");
  };
  envImports.__cxa_atexit = (): number => 0; // no-op, return success
  envImports.__cxa_thread_atexit = (): number => 0; // no-op, return success

  // libc++ verbose abort — called on internal library errors
  envImports._ZNSt3__122__libcpp_verbose_abortEPKcz = (
    _fmt: number | bigint,
    _args: number | bigint,
  ): void => {
    throw new Error("libc++ verbose abort");
  };

  // libc++ sort — MariaDB doesn't actually call this at runtime
  // (linked from empty stub libc++.a). Signature: sort<less<ull>, ull*>(first, last, comp)
  envImports["_ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_"] = (
    _first: number | bigint,
    _last: number | bigint,
    _comp: number | bigint,
  ): void => {
    throw new Error("libc++ sort called unexpectedly");
  };
  const dcTiClassCache = new Map<number, number>(); // typeinfo addr → metaclass (0=leaf, 1=SI, 2=VMI)
  // __dynamic_cast: Itanium C++ ABI dynamic_cast implementation.
  // Reads RTTI from the object's vtable and walks the type hierarchy to
  // check if dst_type is reachable from the object's runtime type.
  // Args: (src_ptr, src_typeinfo*, dst_typeinfo*, src2dst_hint)
  envImports.__dynamic_cast = (
    srcPtr_: number | bigint,
    _srcType: number | bigint,
    dstType_: number | bigint,
    _src2dst: number | bigint,
  ): number | bigint => {
    const srcPtr = n(srcPtr_);
    const dstType = n(dstType_);
    if (srcPtr === 0) return retPtr(0);
    const view = new DataView(memory.buffer);
    const memSize = memory.buffer.byteLength;
    const PS = ptrWidth; // pointer size in bytes
    const readPtr = (addr: number): number =>
      PS === 8
        ? Number(view.getBigUint64(addr, true))
        : view.getUint32(addr, true);
    const readSPtr = (addr: number): number =>
      PS === 8
        ? Number(view.getBigInt64(addr, true))
        : view.getInt32(addr, true);

    // Read vtable pointer from object (Itanium ABI: first word is vtable ptr)
    const vtablePtr = readPtr(srcPtr);
    if (vtablePtr === 0 || vtablePtr >= memSize) return retPtr(0);

    // Itanium ABI vtable layout:
    //   vtable[-PS*2] = offset_to_top (ptrdiff_t)
    //   vtable[-PS]   = RTTI pointer (typeinfo*)
    //   vtable[0]     = first virtual function
    if (vtablePtr < 2 * PS) return retPtr(0);
    const rttiPtr = readPtr(vtablePtr - PS);
    if (rttiPtr === 0 || rttiPtr >= memSize) return retPtr(0);
    const offsetToTop = readSPtr(vtablePtr - 2 * PS);

    // Direct match: runtime type IS the destination type
    if (rttiPtr === dstType) return retPtr(srcPtr + offsetToTop);

    // Walk the type hierarchy from the runtime type, checking if dstType
    // is a base class. typeinfo layout (pointer-sized fields):
    //   [0]      vtable ptr (for the typeinfo meta-class)
    //   [PS]     name ptr (mangled type name)
    //   -- __si_class_type_info adds:
    //   [2*PS]   base typeinfo ptr
    //   -- __vmi_class_type_info adds:
    //   [2*PS]   flags (uint32)
    //   [2*PS+4] base_count (uint32)
    //   [2*PS+8 + i*(PS+4)] base_info[i].base_type (ptr)
    //   [2*PS+8 + i*(PS+4) + PS] base_info[i].offset_flags (long)
    const TI_FIELD2 = 2 * PS; // offset of first field after (vtablePtr, namePtr)
    const BASE_INFO_STRIDE = PS + PS; // base_type(ptr) + offset_flags(long/ptr)

    const tiClassCache = dcTiClassCache;

    const isTypeAncestor = (
      ti: number,
      target: number,
      visited: Set<number>,
    ): boolean => {
      if (ti === target) return true;
      if (ti === 0 || ti >= memSize || visited.has(ti)) return false;
      visited.add(ti);

      if (ti + TI_FIELD2 + PS > memSize) return false;

      const cached = tiClassCache.get(ti);
      if (cached === 0) return false; // leaf
      if (cached === 1) {
        // SI: field at TI_FIELD2 is base typeinfo ptr
        const basePtr = readPtr(ti + TI_FIELD2);
        return isTypeAncestor(basePtr, target, visited);
      }
      if (cached === 2) {
        // VMI: flags(u32) + base_count(u32) then base_info array
        const baseCount = view.getUint32(ti + TI_FIELD2 + 4, true);
        for (let i = 0; i < baseCount; i++) {
          const baseType = readPtr(ti + TI_FIELD2 + 8 + i * BASE_INFO_STRIDE);
          if (baseType > 0 && isTypeAncestor(baseType, target, visited))
            return true;
        }
        return false;
      }

      // Not cached — classify by trying SI first, then VMI
      const field2 = readPtr(ti + TI_FIELD2);

      // Try SI: field2 is a pointer to another typeinfo
      if (field2 > 0x100 && field2 + PS <= memSize) {
        const possibleTiName = readPtr(field2 + PS);
        if (possibleTiName > 0 && possibleTiName < memSize) {
          tiClassCache.set(ti, 1);
          if (isTypeAncestor(field2, target, visited)) return true;
          tiClassCache.delete(ti);
        }
      }

      // Try VMI: field at TI_FIELD2 is flags (u32, 0-3), [TI_FIELD2+4] is base_count
      const flags32 = view.getUint32(ti + TI_FIELD2, true);
      if (flags32 <= 3 && ti + TI_FIELD2 + 8 <= memSize) {
        const baseCount = view.getUint32(ti + TI_FIELD2 + 4, true);
        if (
          baseCount > 0 &&
          baseCount < 100 &&
          ti + TI_FIELD2 + 8 + baseCount * BASE_INFO_STRIDE <= memSize
        ) {
          tiClassCache.set(ti, 2);
          for (let i = 0; i < baseCount; i++) {
            const baseType = readPtr(ti + TI_FIELD2 + 8 + i * BASE_INFO_STRIDE);
            if (baseType > 0 && isTypeAncestor(baseType, target, visited))
              return true;
          }
          return false;
        }
      }

      tiClassCache.set(ti, 0);
      return false;
    };

    if (isTypeAncestor(rttiPtr, dstType, new Set())) {
      return retPtr(srcPtr + offsetToTop);
    }
    return retPtr(0);
  };

  // libc++ sort specialization — sort uint64 array in-place
  envImports["_ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_"] = (
    begin_: number | bigint,
    end_: number | bigint,
  ): void => {
    const begin = n(begin_),
      end = n(end_);
    const view = new DataView(memory.buffer);
    const count = (end - begin) / 8;
    const arr: bigint[] = [];
    for (let i = 0; i < count; i++)
      arr.push(view.getBigUint64(begin + i * 8, true));
    arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < count; i++)
      view.setBigUint64(begin + i * 8, arr[i], true);
  };

  // Environment integrations fail at the point of use when the host does not
  // implement them. Kernel imports were validated above and are never faked.
  for (const imp of wasmModuleImports(module)) {
    if (imp.kind !== "function") continue;
    if (imp.module === "env") {
      if (!Object.hasOwn(envImports, imp.name)) {
        envImports[imp.name] = (..._args: unknown[]) => {
          throw new Error(`Unimplemented import: env.${imp.name}`);
        };
      }
    }
  }

  const importObject: WebAssembly.Imports = { env: envImports };
  if (Object.keys(kernelImports).length > 0) {
    importObject.kernel = kernelImports;
  }
  return importObject;
}

/** Legacy control-page geometry retained as the per-channel anchor location. */
const FORK_BUF_SIZE = FORK_SAVE_BUFFER_SIZE;

// Host-private control slots below the process main channel's fork buffer.
// Fork's memcpy carries the parent's dlopen archive into the child intact;
// the child walks it to replay each module before wpk_fork rewind. These are
// intentionally not relative to a pthread's rewind buffer.
const DLOPEN_HEAD_OFFSET_WASM32 = 12;
const DLOPEN_HEAD_OFFSET_WASM64 = 24;
// Atomic host-private reader/writer arbitration between process-main dlopen
// and pthread fork. A negative value is the exclusive main-worker dlopen
// writer; a positive value counts concurrent pthread forks from their
// pre-unwind archive check through memory-copy/SYS_FORK and parent rewind.
// This preserves Kandelo's existing concurrent-pthread-fork behavior while
// preventing a new archive entry from racing any fork snapshot. A fork child
// clears its copied value before replay because its memory is independent.
const DLOPEN_LOCK_OFFSET_WASM32 = 20;
const DLOPEN_LOCK_OFFSET_WASM64 = 40;
// Positive identity of the Worker whose ordinary Wasm stack owns every live
// staged loader transaction. Unlike the short archive writer, this lease spans
// guest bootstrap/relocation/constructor calls. Same-owner fork is legal;
// another pthread must wait because its child cannot inherit the owner's stack.
const DLOPEN_OWNER_OFFSET_WASM32 = 24;
const DLOPEN_OWNER_OFFSET_WASM64 = 36;
// One fixed, naturally aligned u64 fence lets instrumented Wasm detect a
// newer process table snapshot without crossing into JavaScript on the steady
// state path. The archive header remains the authoritative validated value.
const DLOPEN_GENERATION_OFFSET_WASM32 = 32;
const DLOPEN_GENERATION_OFFSET_WASM64 = 48;
const DLOPEN_MAX_CONTROL_OFFSET = Math.max(
  DLOPEN_HEAD_OFFSET_WASM32,
  DLOPEN_HEAD_OFFSET_WASM64,
  DLOPEN_LOCK_OFFSET_WASM32,
  DLOPEN_LOCK_OFFSET_WASM64,
  DLOPEN_OWNER_OFFSET_WASM32,
  DLOPEN_OWNER_OFFSET_WASM64,
  DLOPEN_GENERATION_OFFSET_WASM32,
  DLOPEN_GENERATION_OFFSET_WASM64,
);
if (
  FORK_BUF_SIZE % 16 !== 0 ||
  FORK_SAVE_CONTROL_PREFIX_SIZE + FORK_BUF_SIZE !== WASM_PAGE_SIZE ||
  DLOPEN_MAX_CONTROL_OFFSET > FORK_SAVE_CONTROL_PREFIX_SIZE
) {
  throw new Error("invalid fork-save scratch-page geometry");
}
const DLOPEN_LOCK_IDLE = 0;
const DLOPEN_LOCK_WRITER = -1;
const DLOPEN_LOCK_MAX_READERS = 0x7fff_ffff;
const DLOPEN_OWNER_IDLE = 0;
const RTLD_GLOBAL = 0x100;

/**
 * The cross-worker table mutation protocol a guest's instrumented `table.set`
 * runs through.
 *
 * Declared here rather than imported because its last home was the 2,098-line
 * activation registry, and this is the only thing that file still defined for
 * anyone else: a shape, with no behaviour attached.
 */
export interface ForkActivationTableReplication {
  /** Immutable pointer-width address of the shared generation fence. */
  readonly generationAddress: WebAssembly.Global;
}

/**
 * WHAT USED TO BE HERE: the four guest table imports (`beginMutation`,
 * `reconcile`, `commit`, `abort`), their per-worker forwarders, the
 * mutation-context stack `abortActiveMutations` unwound, and the funcref
 * patch capture/apply they drove. The fork module serves those imports, reads
 * and writes guest tables through the guest's own shims and applies every
 * published patch itself, so all of it was bound to nothing. What remains
 * here instantiates a peer's side modules and restores published table
 * checkpoints -- the half only a host can do.
 */
export interface ProcessTableReplicationOwner extends ForkActivationTableReplication {
  /** Bring this Worker to the latest complete process generation. */
  reconcileNow(): number;
  /**
   * The fork module's `__wpk_fork_host_materialize_dlopen_archive`: bring
   * this Worker up to at least `generation`, which instantiates every library
   * it lacks. 0, or EAGAIN (11) when the archive has not reached it.
   */
  materialize(generation: bigint): number;
}

/**
 * One worker's dylink table state, published for its peers and replicated from
 * them.
 *
 * Both halves are the module's work; what differs is who sequences them.
 * CAPTURE is one call because it holds an arena, a capture graph and a guest
 * drive open at once, and nothing outside the module can hold those across
 * calls. RESTORE is sequenced here, because it runs when a peer's archive
 * generation moves rather than inside any module-driven replay -- so the guest
 * table restore is an ordinary call on each activation's instance, the way
 * `wpk_fork_module_bootstrap` is.
 */
/** The guest export a peer-table restore drives, once per activation. */
const FORK_TABLE_STATE_RESTORE_EXPORT = "wpk_fork_module_table_state_restore";

interface ForkPeerTableCheckpoint {
  /** Capture this worker's tables into a fresh module-owned arena. */
  capture(): number;
  /** Replicate a peer's published checkpoint into this worker's tables. */
  restore(root: number): void;
}

function createForkPeerTableCheckpoint(
  backend: () => ForkModuleContinuationBackend,
  activations: () => ForkActivations,
  channelBase: number,
  pid: number,
): ForkPeerTableCheckpoint {
  return {
    capture: () => backend().capturePeerTables(channelBase),
    restore: (root) => {
      // Seed the driver and build the install plan: the plan drive rebuilds
      // the funcref and GC slots the guest table restore is about to read.
      const plan = backend().restoreFromArena(root, pid);
      backend().driveRestoredPlan(plan);
      for (const activation of activations().ordered()) {
        const restore =
          activation.instance.exports[FORK_TABLE_STATE_RESTORE_EXPORT];
        if (typeof restore !== "function") {
          // A guest built without dylink support exports none, and has no table
          // state for a peer to replicate either.
          continue;
        }
        (restore as (id: number) => void)(activation.activationId);
      }
    },
  };
}

function createProcessTableReplicationOwner(options: {
  readonly generationAddress: number;
  /**
   * Module-composed peer-table snapshot lifecycle (Path-A A3/A4). Owns the full
   * table checkpoint capture/restore through the co-resident fork module.
   */
  readonly tableCheckpoint: ForkPeerTableCheckpoint;
  readonly dlopen: DlopenSupport;
  readonly materializeModules: () => void;
  readonly restoreSnapshots: boolean;
  /**
   * The vfork parent holds the archive reader from capture until its parked
   * fork syscall returns, so the borrowed child's already-materialized
   * snapshot cannot change. Generation guards may observe that local
   * generation without mutating the parent's reader/writer lock words.
   */
  readonly borrowedImmutableSnapshot?: boolean;
  readonly label: string;
}): ProcessTableReplicationOwner {
  const generationAddress = new WebAssembly.Global(
    { value: "i64", mutable: false },
    BigInt(options.generationAddress),
  );
  let suppressInitialSnapshotRestore = !options.restoreSnapshots;

  // WHAT USED TO RELEASE A SUPERSEDED CHECKPOINT: a host arena attached to the
  // old root purely to free its chunks. The module maps those chunks, so
  // attaching one here was the host freeing memory it never mapped -- the
  // ownership split census 133 named, and the reason `fm_module_state_arena`
  // (since deleted) grew RELEASE and OWNED. Nothing frees a superseded
  // checkpoint today (`capture_peer_tables_impl` says why).
  const replica = new DylinkForkTableReplica(
    options.dlopen.archiveGeneration,
    options.dlopen.loader,
    (snapshot, previousGeneration) => {
      options.materializeModules();
      if (suppressInitialSnapshotRestore) {
        // WHY: a fork child restores the exact capture-time table graph from
        // its normal KFMS arena after all activations exist. The archive
        // generation is still adopted now; only this first redundant restore
        // is suppressed. Later pthread/process mutations must be applied.
        suppressInitialSnapshotRestore = false;
        return;
      }
      if (
        snapshot.tableStateRoot !== 0 &&
        snapshot.tableCheckpointGeneration > previousGeneration
      ) {
        // The archive, not this temporary validated view, owns the mappings.
        options.tableCheckpoint.restore(snapshot.tableStateRoot);
      }
      // Published funcref patches are NOT applied here: the fork module
      // applies every one, in order, on this Worker's next guarded table
      // access (`__wpk_fork_module_state_table_reconcile`).
    },
    `${options.label}: table replica`,
  );
  if (options.borrowedImmutableSnapshot) {
    // Capture holds the parent's process-archive reader until the parked
    // syscall returns. Adopt the exact immutable generation the child has
    // already materialized so side-module guards report truthful state
    // without attempting to mutate either archive lock word.
    replica.adoptPublishedGeneration(options.dlopen.archiveGeneration());
  }

  const reconcileLocked = (): number => {
    const suppressingInitialRestore = suppressInitialSnapshotRestore;
    const changed = replica.reconcile();
    if (suppressingInitialRestore && !changed) {
      // A child whose copied process has never published a dylink/table
      // archive still completed its one startup reconciliation. Do not
      // suppress the first real peer mutation published later.
      suppressInitialSnapshotRestore = false;
    }
    return replica.generation();
  };

  const publishLocked = (): LoaderTableState => {
    // The module opens, fills and seals the arena in one call, so a failure
    // here leaves no half-built arena behind for anyone to clean up.
    const root = options.tableCheckpoint.capture();
    const publication = options.dlopen.loader().publishTableState(root);
    replica.adoptPublishedGeneration(publication.state.generation);
    return publication.state;
  };

  options.dlopen.setCommitObserver(
    (linkerPublication, tableMutationCommitted) => {
      if (linkerPublication) {
        replica.adoptPublishedGeneration(linkerPublication.generation);
      }
      const hasPriorGuestOverlay =
        linkerPublication?.tableStateRoot !== undefined &&
        (linkerPublication.tableStateRoot !== 0 ||
          linkerPublication.tablePatches.length !== 0);
      // Loader-owned table entries are already deterministic module recipes in
      // the dylink archive. Until a guest/dlsym overlay exists, publishing the
      // same entries again as a typed KFMS snapshot would turn ordinary dlopen
      // into an O(table closure) operation. Once an overlay exists, a module-set
      // change still needs a fresh exact activation manifest.
      if ((!linkerPublication && tableMutationCommitted) || hasPriorGuestOverlay) {
        publishLocked();
      }
    },
  );
  options.dlopen.setWriterAcquireObserver(() => {
    // Called with exclusive process ownership. Reconcile before any linker or
    // guest mutation reads this Worker's instance-local table so the protected
    // operation cannot overwrite a newer peer publication.
    reconcileLocked();
  });

  const reconcileNow = (): number =>
    options.borrowedImmutableSnapshot
      ? replica.generation()
      : options.dlopen.withArchiveWriter(reconcileLocked);

  return {
    generationAddress,
    reconcileNow,
    materialize: (generation) =>
      BigInt(reconcileNow()) >= generation ? 0 : 11 /* EAGAIN */,
  };
}

/** @internal Exact publication-lifecycle seam; not re-exported by the host API. */
export function __testCreateProcessTableReplicationOwner(
  options: unknown,
): unknown {
  return createProcessTableReplicationOwner(
    options as Parameters<typeof createProcessTableReplicationOwner>[0],
  );
}

function hasCompleteForkInstrumentation(
  module: WebAssembly.Module,
  pid: number,
): boolean {
  const moduleExports = wasmModuleExports(module);
  const exportNames = new Set(moduleExports.map((e) => e.name));
  const legacyAsyncifyExports = [...exportNames].filter((name) =>
    name.startsWith("asyncify_"),
  );
  if (legacyAsyncifyExports.length > 0) {
    throw new Error(
      `pid=${pid}: user program exports legacy Asyncify instrumentation ` +
        `(${legacyAsyncifyExports.join(", ")}). This host requires ` +
        "wasm-fork-instrument artifacts exporting wpk_fork_*; rebuild the package for the current ABI.",
    );
  }

  const presentWpkExports = WPK_FORK_EXPORTS.filter((name) =>
    exportNames.has(name),
  );
  if (
    presentWpkExports.length > 0 &&
    presentWpkExports.length !== WPK_FORK_EXPORTS.length
  ) {
    const missing = WPK_FORK_EXPORTS.filter((name) => !exportNames.has(name));
    throw new Error(
      `pid=${pid}: incomplete wasm-fork-instrument exports; missing ${missing.join(", ")}. ` +
        "Rebuild the package for the current ABI.",
    );
  }

  const complete = presentWpkExports.length === WPK_FORK_EXPORTS.length;
  if (complete) {
    const claim = readForkInstrumentCapabilityClaim(module);
    if (
      !claim.present ||
      (claim.flags & WPK_FORK_CAP_ACTIVATION_STATE_SAFE) === 0
    ) {
      throw new Error(
        `pid=${pid}: wasm-fork-instrument artifact lacks the required ` +
          `activation-state-safe capability; rebuild it for ABI ${ABI_VERSION}.`,
      );
    }
  }
  return complete;
}

/**
 * Host a WASI Preview 1 program: a guest that was not built against
 * Kandelo's libc, served by the co-resident Rust `wasi-module`.
 *
 * A named function of its own, and listed in `WORKER_MAIN_OTHER_LANES`
 * (host/test/surface-budget.test.ts), because it is not fork work: a WASI
 * guest has no fork instrumentation and never reaches `kernel_fork`. It sat
 * inside `centralizedWorkerMain`, which counted its ~90 lines against lane
 * F's fork measure; the maintainer ruled (2026-09-25) that it be extracted
 * and excluded by name so the measure counts fork code only.
 */
async function runWasiProcess(
  port: MessagePort,
  initData: CentralizedWorkerInitMessage,
  module: WebAssembly.Module,
): Promise<void> {
  const { memory, channelOffset, pid } = initData;
  const ptrWidth = initData.ptrWidth ?? 4;
  if (wasiModuleDefinesMemory(module)) {
    throw new Error(
      "WASI module defines its own memory. Only modules that import memory " +
        "(compiled with --import-memory) are supported.",
    );
  }

  // Lazy-import the heavy shim only when we actually have a WASI
  // module to host. Native channel-syscall workers (the common
  // case) skip this import entirely.
  const { instantiateWasiModule, startWasiModule, WasiExit } = await import(
    "./wasi-module-instance"
  );

  // WASI Preview 1 is implemented by the co-resident Rust `wasi-module`,
  // the exact counterpart of `libc/glue/channel_syscall.c` for a guest
  // that was not built against Kandelo's libc. The host's job here is to
  // place and instantiate it; every WASI call is then a wasm->wasm call
  // into Rust with no JavaScript frame in between.
  const wasiModuleModule = initData.wasiModuleModule;
  if (!wasiModuleModule) {
    throw new Error(
      `pid=${pid}: this program is a WASI module, but the kernel host ` +
        "supplied no `wasi-module` to run it with. Build it with " +
        "`scripts/dev-shell.sh bash crates/wasi-module/build-wasm.sh`.",
    );
  }
  const wasiModule = instantiateWasiModule({
    module: wasiModuleModule,
    memory,
    ptrWidth,
    reserve: (size) =>
      continuationMmap(memory, channelOffset, size, `pid=${pid} wasi`),
    label: `pid=${pid}`,
    argv: initData.argv || [],
    env: initData.env || [],
  });

  // Build import object: provide wasi_snapshot_preview1 namespace + env.memory
  const importObject: WebAssembly.Imports = {
    wasi_snapshot_preview1: wasiModule.wasiImports,
    env: { memory },
  };

  // Stub any additional env imports the module needs
  const moduleImports = wasmModuleImports(module);
  for (const imp of moduleImports) {
    if (imp.module === "env" && imp.name !== "memory") {
      if (!(importObject.env as Record<string, unknown>)[imp.name]) {
        (importObject.env as Record<string, unknown>)[imp.name] =
          imp.kind === "function"
            ? (..._args: unknown[]) => {
                throw new Error(
                  `Unimplemented WASI env import: ${imp.name}`,
                );
              }
            : undefined;
      }
    }
  }

  const instance = await WebAssembly.instantiate(module, importObject);

  // Seed the module with the channel and the argv/env blob locations, then
  // open its `/` preopen. Separate from instantiation because the preopen
  // issues a syscall, and the module has to exist before the guest does.
  startWasiModule(wasiModule, { channelOffset, label: `pid=${pid}` });

  // Signal ready
  port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

  // Run _start
  let exitCode = 0;
  try {
    const start = instance.exports._start as (() => void) | undefined;
    if (start) start();
  } catch (e) {
    if (e instanceof WasiExit) {
      exitCode = e.code;
    } else {
      throw e;
    }
  }

  port.postMessage({
    type: "exit",
    pid,
    status: exitCode,
  } satisfies WorkerToHostMessage);
  return;
}

/**
 * Run a program that carries no fork instrumentation.
 *
 * Listed in `WORKER_MAIN_OTHER_LANES` for the same reason as
 * `runWasiProcess`: nothing here is fork work -- the one fork-related line
 * makes `kernel_fork` fail loud -- and the maintainer ruled (2026-09-25)
 * that it be extracted from `centralizedWorkerMain` and excluded by name.
 */
async function runUninstrumentedProcess(
  port: MessagePort,
  initData: CentralizedWorkerInitMessage,
  module: WebAssembly.Module,
  launch: {
    readonly kernelImports: KernelImports;
    readonly kernelExitStatus: () => number | null;
    readonly dlopenArchiveControlAddr: number;
    readonly longjmpTag: WebAssembly.Tag | undefined;
    readonly cppExceptionTag: WebAssembly.Tag | undefined;
  },
): Promise<void> {
  const { memory, programBytes, channelOffset, pid } = initData;
  const ptrWidth = initData.ptrWidth ?? 4;
  const { kernelImports, dlopenArchiveControlAddr } = launch;
  const processLongjmpTag = launch.longjmpTag;
  const processCppExceptionTag = launch.cppExceptionTag;
  let processInstance: WebAssembly.Instance | null = null;
  const dlopenSupport = buildDlopenImports(
    memory,
    channelOffset,
    dlopenArchiveControlAddr,
    () =>
      processInstance?.exports.__indirect_function_table as
        WebAssembly.Table | undefined,
    () =>
      processInstance?.exports.__stack_pointer as
        WebAssembly.Global | undefined,
    () => processInstance ?? undefined,
    ptrWidth,
    processLongjmpTag,
    processCppExceptionTag,
    undefined,
    `pid=${pid}: main artifact has no fork activation coordinator`,
    // NO unwind tag on this branch, and that is the point of the branch.
    // The tag is the fork-module's export, and this program has no fork
    // instrumentation, so no module was built -- asking for it throws
    // "missing valid process-owned fork unwind tag" before the program has
    // run a single instruction. It is not needed either: both binders bind
    // `env.__wpk_fork_unwind` only when the guest DECLARES that import, and
    // an uninstrumented guest declares nothing of the kind.
    undefined,
    undefined,
    undefined,
    pid,
    "copied",
    initData.dylinkModuleModule,
  );
  const importObject = buildImportObject(
    module,
    memory,
    kernelImports,
    channelOffset,
    dlopenSupport.imports,
    () => processInstance ?? undefined,
    ptrWidth,
    processLongjmpTag,
    processCppExceptionTag,
    undefined, // no fork instrumentation: see above
    (timedOutPtr, vmInterruptPtr, seconds) => {
      port.postMessage({
        type: "vm_interrupt_timer",
        pid,
        timedOutPtr,
        vmInterruptPtr,
        seconds,
      } satisfies WorkerToHostMessage);
    },
  );
  const instance = await WebAssembly.instantiate(module, importObject);
  processInstance = instance;
  setupChannelBase(
    instance,
    module,
    memory,
    channelOffset,
    programBytes as ArrayBuffer,
    ptrWidth,
  );

  port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

  let exitCode = 0;
  try {
    const start = instance.exports._start as (() => void) | undefined;
    if (start) start();
    exitCode = launch.kernelExitStatus() ?? exitCode;
  } catch (e) {
    const status = launch.kernelExitStatus();
    if (!isWasmUnreachableTrap(e) || status === null) throw e;
    exitCode = status;
  }
  if (launch.kernelExitStatus() === null) {
    kernelImports.kernel_exit(exitCode);
    exitCode = launch.kernelExitStatus() ?? exitCode;
  }

  port.postMessage({
    type: "exit",
    pid,
    status: exitCode,
  } satisfies WorkerToHostMessage);
}

/**
 * Main process worker entry point.
 */
export async function centralizedWorkerMain(
  port: MessagePort,
  initData: CentralizedWorkerInitMessage,
): Promise<void> {
  try {
    const { memory, programBytes, channelOffset, pid } = initData;
    const ptrWidth = initData.ptrWidth ?? 4;
    const artifactFailures = describeWasmArtifactPolicyFailures(programBytes, {
      expectedAbi: initData.kernelAbiVersion,
      expectedAbiContractDigest: initData.kernelAbiContractDigest,
    });
    if (artifactFailures.length > 0) {
      throw new Error(
        `pid=${pid}: refusing unsafe program artifact before execution: ` +
          artifactFailures.join("; "),
      );
    }
    // Use pre-compiled module if provided (avoids recompilation in workers)
    const module = initData.programModule
      ? initData.programModule
      : await WebAssembly.compile(programBytes);
    registerWasmModuleReflection(module, programBytes);
    // --- WASI module detection and handling ---
    if (isWasiModule(module)) {
      await runWasiProcess(port, initData, module);
      return;
    }

    // --- SDK module path ---
    const processLongjmpTag = createLongjmpTag(ptrWidth);
    const processCppExceptionTag = createCppExceptionTag(ptrWidth);
    let kernelExitStatus: number | null = null;
    const kernelImports = buildKernelImports(
      memory,
      channelOffset,
      ptrWidth,
      initData.argv || [],
      initData.env || [],
      initData.secureExec,
      (status) => {
        kernelExitStatus = status;
      },
    );

    // Check if the module has complete wpk_fork_* instrumentation exports,
    // and reject stale legacy fork artifacts before they can run.
    const hasForkInstrumentation = hasCompleteForkInstrumentation(module, pid);
    const hasDylinkForkRole = forkInstrumentRoleAvailable(
      readForkInstrumentCapabilityClaim(module),
      FORK_CAP_DYLINK_MAIN,
    );
    const forkMode: ProcessForkMode = initData.isForkChild
      ? (processForkMode(initData.forkMode ?? -1) ?? (() => {
          throw new Error(`pid=${pid}: fork child is missing a valid fork mode`);
        })())
      : PROCESS_FORK_MODE_FORK;
    const forkMemoryOwnership = initData.isForkChild
      ? (initData.forkMemoryOwnership ?? "copied")
      : "copied";
    const borrowedForkChild = forkMemoryOwnership === "borrowed";
    if (borrowedForkChild && forkMode !== PROCESS_FORK_MODE_VFORK) {
      throw new Error(`pid=${pid}: only a vfork child may borrow process memory`);
    }
    if (
      borrowedForkChild
      && !wasmModuleImports(module).some(
        (entry) =>
          entry.module === "env"
          && entry.name === "__channel_base"
          && entry.kind === "global",
      )
    ) {
      throw new Error(
        `pid=${pid}: borrowed vfork requires imported env.__channel_base`,
      );
    }
    const requiredBorrowedNumber = (
      value: number | undefined,
      name: string,
    ): number => {
      if (!Number.isSafeInteger(value) || value === undefined || value <= 0) {
        throw new Error(`pid=${pid}: borrowed vfork has invalid ${name}`);
      }
      return value;
    };
    const dlopenArchiveControlAddr = borrowedForkChild
      ? requiredBorrowedNumber(
          initData.forkOwnerControlAddr,
          "owner control address",
        )
      : channelOffset - FORK_BUF_SIZE;
    // The vfork BORROWED child's replay workspace: the one fact a host has and
    // the module cannot -- where the kernel put the region. The module carves
    // it (`fm_child_install`).
    const borrowedWorkspace = borrowedForkChild
      ? {
          prefixBase: requiredBorrowedNumber(
            initData.forkPrivatePrefixAddr,
            "private prefix address",
          ),
          prefixBytes: requiredBorrowedNumber(
            initData.forkPrivatePrefixBytes,
            "private prefix bytes",
          ),
        }
      : undefined;
    if (borrowedForkChild) {
      // A vfork child may not create another pthread owner before exec. Keep
      // the request off its channel entirely; Rust's Process marker remains a
      // second defense for malformed or direct host traffic.
      kernelImports.kernel_clone = () => -STARTUP_EAGAIN;
    }

    if (hasForkInstrumentation) {
      // A COPIED fork child INHERITS the parent's fork-module region through
      // its full memory clone (the bytes and the kernel's mapping table). It
      // MUST reuse that base: a fresh mmap would stack a second region on the
      // inherited one and grow the child's `memory.size` past its parent's,
      // breaking the fork memory-clone invariant. A borrowed (vfork) child
      // clones nothing, so it maps an on-demand region and hands it back after
      // its one replay (`ForkWorker`'s borrowed release).
      const tableGenerationAddress = dlopenArchiveControlAddr - (ptrWidth === 8
        ? DLOPEN_GENERATION_OFFSET_WASM64
        : DLOPEN_GENERATION_OFFSET_WASM32);
      const inheritedBase = initData.isForkChild && !borrowedForkChild
        ? initData.forkModuleInheritedBase
        : undefined;
      const fork = new ForkWorker({
        memory,
        ptrWidth,
        channelOffset,
        pid,
        label: `pid=${pid}`,
        forkModuleModule: initData.forkModuleModule,
        guestModule: module,
        guestBytes: programBytes,
        archiveControlAddr: dlopenArchiveControlAddr,
        generationAddress: tableGenerationAddress,
        forkChild: initData.isForkChild === true,
        borrowedChild: borrowedForkChild,
        reserve: (size) => {
          if (inheritedBase === undefined) {
            return continuationMmap(memory, channelOffset, size, `pid=${pid}: fork-module`);
          }
          // Same module, same size: a mismatch is a fork-plumbing bug, not a
          // resource condition.
          const inheritedBytes = initData.forkModuleInheritedBytes;
          if (inheritedBytes !== undefined && inheritedBytes !== size) {
            throw new Error(
              `pid=${pid}: inherited fork-module region size ${inheritedBytes} ` +
                `does not match this worker's computed size ${size}`,
            );
          }
          return inheritedBase;
        },
        // The module publishes a capture's launch root in this Worker's fork
        // control word itself; a borrowed vfork child, whose word still
        // belongs to its parked parent, may not fork at all.
      });
      // Publish the region so the kernel host hands a COPIED fork child the
      // same base (above). A borrowed child's region is temporary.
      if (!borrowedForkChild) {
        port.postMessage({
          type: "fork_module_region",
          pid,
          base: fork.instance.memoryBase,
          bytes: fork.instance.regionBytes,
        } satisfies WorkerToHostMessage);
      }
      // A fork-from-thread child resumes through `wpk_fork_resume_thread`,
      // which fork-instrument emits for every guest exporting
      // `__indirect_function_table`; a child without it is a stale artifact.
      // Read from the exact-bytes reflection, because WebKit cannot describe
      // an ABI 44 fork artifact's export types through `Module.exports`.
      const isForkFromThreadChild =
        initData.isForkChild === true && initData.forkChildThreadFnPtr != null;
      if (
        isForkFromThreadChild
        && !wasmModuleExports(module).some((entry) => entry.name === "wpk_fork_resume_thread")
      ) {
        throw new Error(
          `pid=${pid}: fork-from-thread child is missing the ` +
            "`wpk_fork_resume_thread` module resume export; rebuild the " +
            "program through the current fork-instrument path",
        );
      }
      let processInstance: WebAssembly.Instance | null = null;
      let importedStatePlanner: ForkChildImports | null = null;
      let childDylinkState: readonly LoaderArchivedModule[] | null = null;
      // A child's launch root is the kernel-validated `forkBufAddr` it was
      // handed: activation 0's continuation for a main-thread and a pthread
      // fork, COW and borrowed alike. `fm_child_install` takes it; the import
      // plan (`fm_child_plan`) takes the KFMS arena it names.
      const childLaunchRoot = initData.isForkChild
        ? (initData.forkBufAddr ?? 0)
        : 0;
      const childArenaRoot = initData.isForkChild
        ? readForkModuleStateRoot(memory, childLaunchRoot, ptrWidth)
        : 0;
      // The fork module serves `kernel.kernel_fork` itself.
      kernelImports.kernel_fork = fork.kernelForkImport();

      const dylinkForkActivationOwner = hasDylinkForkRole
        ? createProcessDylinkActivationOwner({
            activations: fork.activations,
            importedStateCapture: fork.identity,
            tableReplication: fork.tableReplication,
            importedStatePlanner: initData.isForkChild
              ? () => importedStatePlanner
              : undefined,
            isForkChild: Boolean(initData.isForkChild),
            invokeProcessFork: () => {
              const forkExport = processInstance?.exports.fork;
              if (typeof forkExport !== "function") {
                throw new Error(
                  `pid=${pid}: dylink fork role is missing the main libc fork export`,
                );
              }
              return Number((forkExport as () => number)());
            },
            forkModuleFrameFlip: fork.frameFlip(),
            label: `pid=${pid}: dylink activations`,
          })
        : undefined;

      // Build import object and instantiate
      const dlopenSupport = buildDlopenImports(
        memory,
        channelOffset,
        dlopenArchiveControlAddr,
        () =>
          processInstance?.exports.__indirect_function_table as
            WebAssembly.Table | undefined,
        () =>
          processInstance?.exports.__stack_pointer as
            WebAssembly.Global | undefined,
        () => processInstance ?? undefined,
        ptrWidth,
        processLongjmpTag,
        processCppExceptionTag,
        dylinkForkActivationOwner,
        hasDylinkForkRole
          ? undefined
          : `pid=${pid}: main artifact lacks the dylink fork role capability`,
        fork.unwindTag,
        (table, firstIndex, length) => {
          fork.tables.markTableMutation(table, firstIndex, length);
        },
        guardFunctionImport,
        pid,
        forkMemoryOwnership,
        initData.dylinkModuleModule,
      );
      const processTableReplication = createProcessTableReplicationOwner({
        generationAddress: tableGenerationAddress,
        tableCheckpoint: createForkPeerTableCheckpoint(
          () => fork.module(),
          () => fork.activations,
          channelOffset,
          pid,
        ),
        dlopen: dlopenSupport,
        materializeModules: () => {
          dlopenSupport.replayDlopens({ memoryOwnership: forkMemoryOwnership });
        },
        // The inherited fork arena restores a child process's complete
        // global/table/reference graph and preserves aliases with live frames.
        // The process table journal is for separately instantiated pthread
        // Workers and later generations, not a second initial child restore.
        restoreSnapshots: !initData.isForkChild,
        borrowedImmutableSnapshot: borrowedForkChild,
        label: `pid=${pid}`,
      });
      fork.bindArchive(dlopenSupport, processTableReplication);
      if (initData.isForkChild) {
        if (childArenaRoot === 0) {
          throw new Error(
            `pid=${pid}: fork child lost its inherited module-state arena`,
          );
        }
        if (!borrowedForkChild) {
          // A parent can be copied while the archive mutex word names its
          // now-nonexistent Worker. The validated archive bytes are immutable
          // for this child launch, so clear that private lock before creating
          // any loader state. A borrower must leave the parent's lock intact.
          dlopenSupport.resetForkChildLock();
        }
        childDylinkState = dlopenSupport.readForkState();
        const modules = new Map<number, WebAssembly.Module>([[0, module]]);
        for (const library of childDylinkState) {
          if (library.activationId === undefined) continue;
          if (modules.has(library.activationId)) {
            throw new Error(
              `pid=${pid}: archived activation ${library.activationId} ` +
                "is duplicated or aliases the main activation",
            );
          }
          const activationModule = new WebAssembly.Module(
            library.moduleBytes as unknown as BufferSource,
          );
          registerWasmModuleReflection(
            activationModule,
            library.moduleBytes,
          );
          modules.set(library.activationId, activationModule);
          // ADMITTED here, before anything instantiates: the module plans this
          // activation's imports and the child's GC, exception and resume state
          // from its admission. The dlopen replay admits it again as it
          // instantiates, which is the module's same-facts no-op.
          fork.module().admitActivation(
            library.activationId,
            activationModule,
            computeForkModuleTemplateId(library.moduleBytes),
          );
        }
        // The module is the SOLE reconstructor: it owns the whole reference
        // graph (decode, drive order, every restore data feed) and re-checks
        // what it can see itself -- GC layout validity (`EINVAL`), exnref tags
        // an activation never declared (`EINVAL`, in `fm_child_install`), and a
        // raw host externref, which the capture already refused
        // (`EOPNOTSUPP`). There is no JavaScript reconstruction behind it.
        //
        // The child's imports are planned by the module too (`fm_child_plan`):
        // which value each import of each activation gets, whether a raw
        // reference's kind fits its declared type, and the instantiation order
        // (providers first; a provider cycle is refused with EDEADLK). The host
        // turns the rows into import objects and checks the order against the
        // archive's, since the dlopen replay instantiates in archive order.
        importedStatePlanner = new ForkChildImports(
          fork.module().childPlan(childArenaRoot),
          modules,
          `pid=${pid}: child imported activation state`,
        );
        const archivedOrder = [0, ...childDylinkState.flatMap(({ activationId }) =>
          activationId === undefined ? [] : [activationId])].join(",");
        if (archivedOrder !== importedStatePlanner.order.join(",")) {
          throw new Error(`pid=${pid}: inherited activation import dependencies require order `
            + `${importedStatePlanner.order.join(",")}, but the replay archive provides ${archivedOrder}`);
        }
      }
      const importObject = buildImportObject(
        module,
        memory,
        kernelImports,
        channelOffset,
        dlopenSupport.imports,
        () => processInstance ?? undefined,
        ptrWidth,
        processLongjmpTag,
        processCppExceptionTag,
        fork.unwindTag,
        (timedOutPtr, vmInterruptPtr, seconds) => {
          port.postMessage({
            type: "vm_interrupt_timer",
            pid,
            timedOutPtr,
            vmInterruptPtr,
            seconds,
          } satisfies WorkerToHostMessage);
        },
        fork.guestImports(),
      );
      const routedImportObject = guardImportObject(programBytes, importObject);
      const reconstructedMainImports = importedStatePlanner
        ? importedStatePlanner.importsForActivation(
            0,
            routedImportObject as unknown as ForkWasmImports,
          )
        : routedImportObject;
      // WHY: reconstruction supplies copied identities; capture wraps that
      // resolved view so this child can safely become the parent of another
      // fresh instance without retaining the previous fork arena.
      const mainImportedStatePreparation =
        fork.identity.prepareActivation(
          0,
          module,
          reconstructedMainImports,
        );
      const mainInstantiationImports = mainImportedStatePreparation.imports;
      let instance: WebAssembly.Instance;
      try {
        instance = await WebAssembly.instantiate(
          module,
          mainInstantiationImports as unknown as WebAssembly.Imports,
        );
      } catch (error) {
        mainImportedStatePreparation?.abort();
        importedStatePlanner?.clear();
        throw error;
      }
      processInstance = instance;
      fork.registerMain(instance);
      mainImportedStatePreparation?.complete(instance);
      importedStatePlanner?.registerInstance(0, instance);
      if (!initData.isForkChild) {
        try {
          // Registration harvests static roots before bootstrap consumes the
          // converted active segments, and installs the dirty-table owner
          // before the original start can mutate a table.
          fork.activations.bootstrap(0);
        } catch (error) {
          fork.activations.forget(0);
          throw error;
        }
      }
      if (initData.isForkChild) {
        // Every side activation must exist before the process transaction is
        // attached: module/reference recipes name activation coordinates, not
        // whichever instance happens to load first in the child.
        try {
          if (!childDylinkState) {
            throw new Error("inherited dynamic-linker state was not prepared");
          }
          dlopenSupport.replayDlopens({
            memoryOwnership: forkMemoryOwnership,
          });
          // Ordinary children reconcile a copied archive under their private
          // lock. Borrowed children already replayed the validated snapshot;
          // taking either archive lock would mutate the suspended parent.
          if (!borrowedForkChild) processTableReplication.reconcileNow();
        } catch (error) {
          throw new Error(
            `fork-replay-dlopen failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (!importedStatePlanner) {
          throw new Error(
            `pid=${pid}: fork child lost its pre-instantiation reference plan`,
          );
        }
        // ONE install call for a COW and a vfork BORROWED child, of the main
        // thread or a pthread (`fm_child_install`): the module publishes a COW
        // child's launch root in its own control word, carves a borrowed
        // child's workspace, seeds every activation this worker bound,
        // attaches, drives the install plan, and nulls the merged static-root
        // catalog once the drive has rooted every static root in the transit.
        // It fills that catalog first, too: each activation copies its own
        // roots in with one `table.copy` (`__wpk_fork_static_root_fill`).
        fork.module().installChild(pid, childLaunchRoot, borrowedWorkspace);
        importedStatePlanner.clear();
        importedStatePlanner = null;
      }
      // A child's attach restored __tls_base/__stack_pointer for every
      // activation before any continuation frame can execute.
      setupChannelBase(
        instance,
        module,
        memory,
        channelOffset,
        programBytes as ArrayBuffer,
        ptrWidth,
      );

      // Signal ready
      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      // The module's run loop calls `_start` and `wpk_fork_resume_start`
      // through its drive table; a stale artifact fails here, by name.
      if (typeof instance.exports.wpk_fork_resume_start !== "function") {
        throw new Error(
          `pid=${pid}: fork-capable program is missing wpk_fork_resume_start`,
        );
      }
      // A fork-from-non-main-thread child re-enters through the parent
      // thread's thread function, not `_start`: `_start` is not in that
      // thread's call chain, so rewinding through it would never reach the
      // saved fork() call site. A fork child never runs the lexical entry:
      // its install left the module replaying, and `fm_run` picks the entry
      // from that.
      const outcome = isForkFromThreadChild
        ? fork.run("thread", initData.forkChildThreadFnPtr!, initData.forkChildThreadArgPtr ?? 0, () => kernelExitStatus)
        : fork.run("process", 0, 0, () => kernelExitStatus);
      let exitCode = 0;
      if ("exited" in outcome) {
        exitCode = outcome.exited;
      } else if (kernelExitStatus === null) {
        // Normal return: the program finished without calling exit.
        kernelImports.kernel_exit(0);
        exitCode = kernelExitStatus ?? 0;
      }
      fork.finish();
      port.postMessage({
        type: "exit",
        pid,
        status: exitCode,
      } satisfies WorkerToHostMessage);
    } else {
      await runUninstrumentedProcess(port, initData, module, {
        kernelImports,
        kernelExitStatus: () => kernelExitStatus,
        dlopenArchiveControlAddr,
        longjmpTag: processLongjmpTag,
        cppExceptionTag: processCppExceptionTag,
      });
    }
  } catch (err) {
    if (err instanceof ExecRetirement) {
      port.postMessage({
        type: "exec_retired",
        pid: initData.pid,
      } satisfies WorkerToHostMessage);
      return;
    }
    let errMsg: string;
    if (err instanceof Error) {
      errMsg = `${err.message}\n${err.stack}`;
    } else if (
      (WebAssembly as any).Exception &&
      err instanceof (WebAssembly as any).Exception
    ) {
      // WebAssembly.Exception isn't an Error subclass in V8, so String(err)
      // produces the useless "[object WebAssembly.Exception]". Surface
      // anything we can read off it for build-time debugging.
      const wex = err as { message?: string; stack?: string };
      errMsg = `WebAssembly.Exception: ${wex.message ?? "<no message>"}\n${wex.stack ?? "<no stack>"}`;
    } else {
      errMsg = String(err);
    }
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: `Kernel worker failed: ${errMsg}`,
    } satisfies WorkerToHostMessage);
  }
}

/**
 * Set up __channel_base in TLS so __do_syscall knows the channel offset.
 */
/**
 * Detect __channel_base's TLS offset by inspecting the Wasm binary.
 *
 * The __get_channel_base_addr function has a simple body:
 *   i32.const <offset>
 *   global.get <__tls_base>
 *   i32.add
 *   return
 *
 * We find this function by looking at the export wrapper's call target.
 * Returns the i32.const value, or -1 if detection fails.
 */
function detectChannelBaseTlsOffset(programBytes: ArrayBuffer): number {
  const src = new Uint8Array(programBytes);
  if (src.length < 8) return -1;

  function readLEB128(buf: Uint8Array, off: number): [number, number] {
    let result = 0,
      shift = 0,
      pos = off;
    for (;;) {
      const byte = buf[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return [result, pos - off];
  }

  // Parse sections to find Export and Code sections
  interface Section {
    id: number;
    contentOffset: number;
    contentSize: number;
  }
  const sections: Section[] = [];
  let numFuncImports = 0;
  let offset = 8;

  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readLEB128(src, offset + 1);
    sections.push({
      id: sectionId,
      contentOffset: offset + 1 + sizeBytes,
      contentSize: sectionSize,
    });
    offset += 1 + sizeBytes + sectionSize;
  }

  // Count function imports (section 2)
  for (const sec of sections) {
    if (sec.id === 2) {
      let pos = sec.contentOffset;
      const [importCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        const [modLen, modLenBytes] = readLEB128(src, pos);
        pos += modLenBytes + modLen;
        const [fieldLen, fieldLenBytes] = readLEB128(src, pos);
        pos += fieldLenBytes + fieldLen;
        const kind = src[pos++];
        if (kind === 0) {
          numFuncImports++;
          const [, n] = readLEB128(src, pos);
          pos += n;
        } else if (kind === 1) {
          pos++;
          const f = src[pos++];
          const [, n] = readLEB128(src, pos);
          pos += n;
          if (f & 1) {
            const [, n2] = readLEB128(src, pos);
            pos += n2;
          }
        } else if (kind === 2) {
          const f = src[pos++];
          const [, n] = readLEB128(src, pos);
          pos += n;
          if (f & 1) {
            const [, n2] = readLEB128(src, pos);
            pos += n2;
          }
        } else if (kind === 3) {
          pos += 2;
        }
      }
      break;
    }
  }

  // Find __get_channel_base_addr export
  let channelBaseExportFuncIdx = -1;
  for (const sec of sections) {
    if (sec.id === 7) {
      let pos = sec.contentOffset;
      const [exportCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readLEB128(src, pos);
        pos += nameLenBytes;
        const name = new TextDecoder().decode(src.subarray(pos, pos + nameLen));
        pos += nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readLEB128(src, pos);
        pos += idxBytes;
        if (kind === 0 && name === "__get_channel_base_addr") {
          channelBaseExportFuncIdx = idx;
          break;
        }
      }
      break;
    }
  }

  if (channelBaseExportFuncIdx < 0) return -1;

  // The export may be either:
  // 1. A direct export (no ctors): i32.const <offset>; global.get; i32.add; ...
  // 2. A wrapper: call __wasm_call_ctors; call <actual>; end
  const exportCodeEntry = channelBaseExportFuncIdx - numFuncImports;
  if (exportCodeEntry < 0) return -1;

  for (const sec of sections) {
    if (sec.id !== 10) continue;
    let pos = sec.contentOffset;
    const [, funcCountBytes] = readLEB128(src, pos);
    pos += funcCountBytes;

    // Skip to the exported function's body
    for (let i = 0; i < exportCodeEntry; i++) {
      const [bodySize, bodySizeBytes] = readLEB128(src, pos);
      pos += bodySizeBytes + bodySize;
    }
    const [, bodySizeBytes] = readLEB128(src, pos);
    pos += bodySizeBytes;
    // Skip locals
    const [localCount, lcBytes] = readLEB128(src, pos);
    pos += lcBytes;
    for (let i = 0; i < localCount; i++) {
      const [, n] = readLEB128(src, pos);
      pos += n;
      pos++;
    }

    // i32.const = 0x41, i64.const = 0x42 (wasm64 uses i64 for addresses)
    const I32_CONST = 0x41;
    const I64_CONST = 0x42;

    // Pattern 1: direct export — starts with i32.const/i64.const <offset>
    if (src[pos] === I32_CONST || src[pos] === I64_CONST) {
      pos++;
      const [tlsOffset] = readLEB128(src, pos);
      return tlsOffset;
    }

    // Pattern 3: instrumented/optimized — global.get <tls_base>; i32/i64.const <offset>; i32/i64.add
    if (src[pos] === 0x23) {
      let p3 = pos + 1;
      const [, globalIdxBytes] = readLEB128(src, p3);
      p3 += globalIdxBytes;
      if (src[p3] === I32_CONST || src[p3] === I64_CONST) {
        p3++;
        const [tlsOffset] = readLEB128(src, p3);
        return tlsOffset;
      }
    }

    // Pattern 2: wrapper — call <ctors>; call <actual>; end
    if (src[pos] !== 0x10) return -1;
    pos++;
    const [, ctorIdxBytes] = readLEB128(src, pos);
    pos += ctorIdxBytes;
    if (src[pos] !== 0x10) return -1;
    pos++;
    const [actualFuncIdx] = readLEB128(src, pos);

    const actualCodeEntry = actualFuncIdx - numFuncImports;
    if (actualCodeEntry < 0) return -1;

    let pos2 = sec.contentOffset;
    const [, fcb2] = readLEB128(src, pos2);
    pos2 += fcb2;
    for (let i = 0; i < actualCodeEntry; i++) {
      const [bs, bsb] = readLEB128(src, pos2);
      pos2 += bsb + bs;
    }
    const [, bsb2] = readLEB128(src, pos2);
    pos2 += bsb2;
    const [lc2, lcb2] = readLEB128(src, pos2);
    pos2 += lcb2;
    for (let i = 0; i < lc2; i++) {
      const [, n] = readLEB128(src, pos2);
      pos2 += n;
      pos2++;
    }

    if (src[pos2] !== I32_CONST && src[pos2] !== I64_CONST) return -1;
    pos2++;
    const [tlsOffset] = readLEB128(src, pos2);
    return tlsOffset;
  }

  return -1;
}

function setupChannelBase(
  instance: WebAssembly.Instance,
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  channelOffset: number,
  programBytes?: ArrayBuffer,
  ptrWidth: 4 | 8 = 4,
): void {
  // If the module imports env.__channel_base as a global, the channel offset was
  // already set at instantiation via WebAssembly.Global in buildImportObject.
  const moduleImports = wasmModuleImports(module);
  if (
    moduleImports.some(
      (i) =>
        i.module === "env" &&
        i.name === "__channel_base" &&
        i.kind === "global",
    )
  ) {
    return;
  }

  // Legacy TLS-based approach: write channelOffset into the TLS slot.
  const tlsBase = instance.exports.__tls_base as WebAssembly.Global | undefined;
  const view = new DataView(memory.buffer);
  const tlsAddr = tlsBase ? Number(tlsBase.value) : 0;

  if (tlsAddr > 0) {
    let detectedOffset = -1;
    if (programBytes) {
      detectedOffset = detectChannelBaseTlsOffset(programBytes);
    }
    const addr = tlsAddr + (detectedOffset >= 0 ? detectedOffset : 0);
    if (ptrWidth === 8) {
      view.setBigUint64(addr, BigInt(channelOffset), true);
    } else {
      view.setUint32(addr, channelOffset, true);
    }
  }
}

/**
 * Patch a Wasm binary for use in a thread instance (shared memory).
 *
 * In LLVM's shared-memory Wasm model:
 * - The Start function (section id=8) is `__wasm_init_memory` — it initializes
 *   passive data segments with an atomic guard. Threads must NOT re-run this.
 * - A separate constructor function (`__wasm_call_ctors`) runs C++ global
 *   constructors. LLVM inserts a `call` to this function at the beginning of
 *   every exported function. Threads must NOT re-run constructors either, as
 *   they would clobber shared global state (e.g. resetting LOGGER::file_log_handler
 *   to NULL in MariaDB).
 *
 * This function:
 * 1. Removes the Start section so `__wasm_init_memory` doesn't auto-run.
 * 2. Finds the constructor function by scanning the known LLVM helper exports
 *    for their common call target and replaces that function body with a no-op.
 */
export function patchWasmForThread(bytes: ArrayBuffer): ArrayBuffer {
  const src = new Uint8Array(bytes);
  if (src.length < 8) return bytes;

  function readLEB128(buf: Uint8Array, off: number): [number, number] {
    let result = 0;
    let shift = 0;
    let pos = off;
    for (;;) {
      const byte = buf[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return [result, pos - off];
  }

  function encodeLEB128(value: number): number[] {
    const result: number[] = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      result.push(byte);
    } while (value !== 0);
    return result;
  }

  // Parse all sections
  interface Section {
    id: number;
    offset: number;
    totalSize: number;
    contentOffset: number;
    contentSize: number;
  }
  const sections: Section[] = [];
  let numFuncImports = 0;
  let hasStartSection = false;
  let offset = 8;

  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readLEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;
    const totalSize = 1 + sizeBytes + sectionSize;
    sections.push({
      id: sectionId,
      offset,
      totalSize,
      contentOffset,
      contentSize: sectionSize,
    });
    if (sectionId === 8) hasStartSection = true;
    offset += totalSize;
  }

  if (!hasStartSection) return bytes;

  // WHY: import descriptors can contain recursive GC types, multi-byte
  // concrete references, table64 limits, and tags. Use the same exact binary
  // parser as ABI admission: WebKit can compile these modules while refusing
  // to expose their import descriptors through engine reflection.
  numFuncImports = readWasmImportDescriptors(bytes)
    .filter((entry) => entry.kind === "function").length;

  // Find the constructor function from executable linker evidence. Custom
  // name sections are optional debug metadata and cannot authorize a body
  // rewrite.
  // Plain lld output puts `call $__wasm_call_ctors` first. After
  // wasm-fork-instrument, wrappers have a rewind prolog before the original
  // body, so scan instructions and choose the call target shared by the known
  // helper exports instead of assuming opcode 0 is the constructor call.
  let ctorFuncIndex = -1;
  let exportedFuncIndices: number[] = [];
  const exportFuncIndicesByName = new Map<string, number>();

  // Collect exported function indices from Export section (id=7)
  for (const sec of sections) {
    if (sec.id === 7) {
      let pos = sec.contentOffset;
      const [exportCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readLEB128(src, pos);
        pos += nameLenBytes;
        const name = new TextDecoder().decode(src.subarray(pos, pos + nameLen));
        pos += nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readLEB128(src, pos);
        pos += idxBytes;
        if (kind === 0) {
          // function export
          exportedFuncIndices.push(idx);
          exportFuncIndicesByName.set(name, idx);
        }
      }
      break;
    }
  }

  function skipLEB(pos: number): number {
    const [, n] = readLEB128(src, pos);
    return pos + n;
  }

  function skipMemArg(pos: number): number {
    pos = skipLEB(pos); // alignment
    return skipLEB(pos); // offset
  }

  function skipValueType(pos: number): number {
    const kind = src[pos++];
    // `(ref null <heaptype>)` and `(ref <heaptype>)` carry a signed
    // heap-type/type-index LEB. Abstract shorthand references and all numeric
    // value types are single-byte encodings.
    return kind === 0x63 || kind === 0x64 ? skipLEB(pos) : pos;
  }

  function skipBlockType(pos: number): number {
    const kind = src[pos];
    if (kind === 0x40) return pos + 1; // empty
    if (
      (kind >= 0x7b && kind <= 0x7f) ||
      (kind >= 0x65 && kind <= 0x70) ||
      kind === 0x63 ||
      kind === 0x64
    ) {
      return skipValueType(pos);
    }
    return skipLEB(pos); // signed type index
  }

  function getInstructionStartAndEnd(
    codeSection: Section,
    funcIndex: number,
  ): { start: number; end: number } | null {
    const codeEntry = funcIndex - numFuncImports;
    if (codeEntry < 0) return null;

    let pos = codeSection.contentOffset;
    const [funcCount, funcCountBytes] = readLEB128(src, pos);
    pos += funcCountBytes;
    if (codeEntry >= funcCount) return null;

    for (let i = 0; i < codeEntry; i++) {
      const [bodySize, bodySizeBytes] = readLEB128(src, pos);
      pos += bodySizeBytes + bodySize;
    }

    const [bodySize, bodySizeBytes] = readLEB128(src, pos);
    pos += bodySizeBytes;
    const bodyEnd = pos + bodySize;

    const [localCount, localCountBytes] = readLEB128(src, pos);
    pos += localCountBytes;
    for (let i = 0; i < localCount; i++) {
      pos = skipLEB(pos); // count
      pos = skipValueType(pos);
    }

    return { start: pos, end: bodyEnd };
  }

  function scanCallTargets(codeSection: Section, funcIndex: number): number[] {
    const bounds = getInstructionStartAndEnd(codeSection, funcIndex);
    if (!bounds) return [];

    const calls: number[] = [];
    let pos = bounds.start;
    while (pos < bounds.end) {
      const op = src[pos++];
      if (op === 0x10) {
        // call
        const [target, n] = readLEB128(src, pos);
        pos += n;
        calls.push(target);
      } else if (op === 0x11 || op === 0x13) {
        // call_indirect / return_call_indirect
        pos = skipLEB(pos);
        pos = skipLEB(pos);
      } else if (op === 0x12 || op === 0x14 || op === 0x15) {
        pos = skipLEB(pos);
      } else if (op === 0x02 || op === 0x03 || op === 0x04) {
        pos = skipBlockType(pos);
      } else if (
        op === 0x0c ||
        op === 0x0d ||
        (op >= 0x20 && op <= 0x26) ||
        op === 0xd0 ||
        op === 0xd2
      ) {
        pos = skipLEB(pos);
      } else if (op === 0x0e) {
        // br_table
        const [count, n] = readLEB128(src, pos);
        pos += n;
        for (let i = 0; i <= count; i++) pos = skipLEB(pos);
      } else if (op >= 0x28 && op <= 0x3e) {
        pos = skipMemArg(pos);
      } else if (op === 0x3f || op === 0x40) {
        pos++;
      } else if (op === 0x41 || op === 0x42) {
        pos = skipLEB(pos);
      } else if (op === 0x43) {
        pos += 4;
      } else if (op === 0x44) {
        pos += 8;
      } else if (op === 0xfc) {
        const [subop, n] = readLEB128(src, pos);
        pos += n;
        if (subop === 8 || subop === 10 || subop === 12 || subop === 14) {
          pos = skipLEB(skipLEB(pos));
        } else if (subop >= 9 && subop <= 17) {
          pos = skipLEB(pos);
        }
      } else if (op === 0xfe) {
        pos = skipLEB(pos);
        pos = skipMemArg(pos);
      } else if (op === 0xfd) {
        // SIMD is not expected in the helper wrappers. Stop before treating
        // SIMD immediates as opcodes and collecting false call targets.
        break;
      } else {
        // Most numeric, parametric, and control opcodes have no immediates.
      }
    }
    return calls;
  }

  const ctorCandidates = new Map<number, string[]>();
  const addCtorCandidate = (index: number | undefined, source: string): void => {
    if (index === undefined) return;
    const sources = ctorCandidates.get(index) ?? [];
    sources.push(source);
    ctorCandidates.set(index, sources);
  };
  addCtorCandidate(
    exportFuncIndicesByName.get("__wasm_call_ctors"),
    "function export",
  );

  // Find the Code section and identify a call target shared by LLVM helper
  // exports. Instrumented wrappers can have a rewind prolog, so a shared
  // executable target is stronger evidence than a fixed instruction offset.
  for (const sec of sections) {
    if (sec.id === 10 && exportedFuncIndices.length > 0) {
      const helperNames = [
        "__wasm_init_tls",
        "__abi_version",
        "__get_channel_base_addr",
        "_start",
        "__wasm_thread_init",
      ];
      const counts = new Map<number, { count: number; firstOrder: number }>();
      let order = 0;
      for (const name of helperNames) {
        const funcIndex = exportFuncIndicesByName.get(name);
        if (funcIndex === undefined) continue;
        const perFunction = new Set(
          scanCallTargets(sec, funcIndex).filter(
            (target) => target >= numFuncImports,
          ),
        );
        for (const target of perFunction) {
          const entry = counts.get(target);
          if (entry) {
            entry.count++;
          } else {
            counts.set(target, { count: 1, firstOrder: order++ });
          }
        }
      }

      let best: { target: number; count: number; firstOrder: number } | null =
        null;
      for (const [target, value] of counts) {
        if (
          value.count >= 2 &&
          (!best ||
            value.count > best.count ||
            (value.count === best.count && value.firstOrder < best.firstOrder))
        ) {
          best = { target, count: value.count, firstOrder: value.firstOrder };
        }
      }

      if (best) addCtorCandidate(best.target, "shared linker wrappers");

      // A validated ABI marker is itself a linker wrapper in small legacy
      // modules. Its leading direct call is authoritative even when there is
      // no second helper export with which to intersect it.
      const abiMarkerIndex = exportFuncIndicesByName.get("__abi_version");
      if (abiMarkerIndex !== undefined && extractAbiVersion(bytes) !== null) {
        const bounds = getInstructionStartAndEnd(sec, abiMarkerIndex);
        if (bounds && src[bounds.start] === 0x10) {
          const [target] = readLEB128(src, bounds.start + 1);
          addCtorCandidate(target, "__abi_version linker wrapper");
        }
      }
      break;
    }
  }

  if (ctorCandidates.size > 1) {
    const evidence = [...ctorCandidates]
      .map(([index, sources]) => `${index} (${sources.join(", ")})`)
      .join("; ");
    throw new Error(`Conflicting __wasm_call_ctors evidence: ${evidence}`);
  }
  ctorFuncIndex = ctorCandidates.keys().next().value ?? -1;

  const ctorCodeEntry =
    ctorFuncIndex >= 0 ? ctorFuncIndex - numFuncImports : -1;
  if (ctorFuncIndex >= 0) {
    const arity = readWasmFunctionArity(bytes, ctorFuncIndex);
    if (ctorCodeEntry < 0 || arity === null) {
      throw new Error(
        `__wasm_call_ctors function ${ctorFuncIndex} has no defined function body`,
      );
    }
    if (arity.parameters !== 0 || arity.results !== 0) {
      throw new Error(
        `__wasm_call_ctors function ${ctorFuncIndex} must have type () -> (), `
          + `found ${arity.parameters} parameter(s) and ${arity.results} result(s)`,
      );
    }
  }

  // Build output: always skip Start section; optionally neuter constructor function
  const chunks: Uint8Array[] = [];
  chunks.push(src.subarray(0, 8)); // Wasm header

  for (const sec of sections) {
    if (sec.id === 8) {
      continue; // Skip start section
    }

    if (sec.id === 10 && ctorCodeEntry >= 0) {
      // Code section: replace constructor function body with no-op
      let pos = sec.contentOffset;
      // The function COUNT is skipped rather than bound: this walk locates one
      // body by index and never needs the total.
      const [, funcCountBytes] = readLEB128(src, pos);
      pos += funcCountBytes;

      // Locate the constructor function body
      let targetBodyStart = pos;
      for (let i = 0; i < ctorCodeEntry; i++) {
        const [bodySize, bodySizeBytes] = readLEB128(src, targetBodyStart);
        targetBodyStart += bodySizeBytes + bodySize;
      }
      const [origBodySize, origBodySizeBytes] = readLEB128(
        src,
        targetBodyStart,
      );
      const origBodyEnd = targetBodyStart + origBodySizeBytes + origBodySize;

      // New body: size=2, content = 0x00 (0 locals) + 0x0B (end)
      const newBody = new Uint8Array([2, 0, 0x0b]);

      // Compute new section content size
      const beforeTarget = targetBodyStart - sec.contentOffset;
      const afterTarget = sec.contentOffset + sec.contentSize - origBodyEnd;
      const newContentSize = beforeTarget + newBody.length + afterTarget;
      const newSectionSizeBytes = encodeLEB128(newContentSize);

      chunks.push(new Uint8Array([10])); // section id
      chunks.push(new Uint8Array(newSectionSizeBytes));
      chunks.push(src.subarray(sec.contentOffset, targetBodyStart)); // func count + bodies before target
      chunks.push(newBody); // patched function body
      chunks.push(
        src.subarray(origBodyEnd, sec.contentOffset + sec.contentSize),
      ); // bodies after target
    } else {
      // Copy section as-is
      chunks.push(src.subarray(sec.offset, sec.offset + sec.totalSize));
    }
  }

  // Concatenate chunks
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out.buffer;
}

/**
 * Thread worker entry point.
 *
 * Threads share the parent process's Memory. This function:
 * 1. Instantiates the same Wasm module with shared memory (start section stripped)
 * 2. Allocates TLS for the thread
 * 3. Sets the channel base and stack pointer
 * 4. Calls the thread function via the indirect function table
 * 5. On return: performs CLONE_CHILD_CLEARTID (write 0 + futex wake at ctidPtr)
 *
 * If the thread function calls fork(), this entry point drives the
 * `wpk_fork_*` unwind/SYS_FORK/rewind loop just like the main process worker,
 * but rooted at the pthread function and this thread's channel-local fork
 * buffer.
 */
/**
 * Build the JS argument list for calling an UNINSTRUMENTED wasm pthread entry
 * function through the indirect function table.
 *
 * A fork-instrumented guest does not need this: fork-instrument reads the
 * table's calling convention off the binary and emits
 * `wpk_fork_thread_entry(table_index, arg)` in it, which the fork path calls
 * (lane F step 3c, ruling 2). A guest that was never instrumented has no such
 * export, so its thread entry is still adapted here.
 *
 * Kandelo user programs are post-processed with binaryen's `--fpcast-emu` (see
 * optimize_wasm in scripts/ports/*), which rewrites every indirectly-called
 * function — including pthread entry points, which the host reaches via
 * `table.get(fnPtr)` — to a single uniform trampoline signature with N i64
 * parameters and an i64 result. Calling such a trampoline with the plain C ABI
 * (`fn(argPtr)` where argPtr is a JS number) throws
 * `TypeError: Cannot convert <n> to a BigInt`, because the first parameter is
 * i64. This surfaced as the first fork-instrumented *and* threaded program
 * (pcmanfm) crashing on its first worker thread.
 *
 * A plain (un-emulated) entry has exactly one pointer parameter, so the
 * function wrapper's parameter count distinguishes the two: `length <= 1` is the
 * plain C ABI (i32 pointer on wasm32, i64 on wasm64); `length > 1` is the
 * fpcast-emu trampoline, whose parameters are all i64 — pass the pointer arg
 * first as a BigInt and zero-fill the remaining slots.
 */
function buildThreadEntryArgs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  threadFn: (...args: any[]) => unknown,
  argPtr: number,
  ptrWidth: number,
): (number | bigint)[] {
  const argc = threadFn.length;
  if (argc <= 1) {
    const arg = ptrWidth === 8 ? BigInt(argPtr) : argPtr;
    return argc === 0 ? [] : [arg];
  }
  const args: (number | bigint)[] = new Array(argc).fill(0n);
  args[0] = BigInt(argPtr);
  return args;
}

export async function centralizedThreadWorkerMain(
  port: MessagePort,
  initData: CentralizedThreadInitMessage,
): Promise<void> {
  const {
    memory,
    processChannelOffset,
    channelOffset,
    pid,
    tid,
    fnPtr,
    argPtr,
    stackPtr,
    tlsPtr,
  } = initData;
  const tlsOffset = initData.tlsOffset;
  const ptrWidth = initData.ptrWidth ?? 4;

  // WHY: synchronize the received memory before this isolate binds any view
  // or Wasm instance to a possibly stale fixed-length view of its backing.
  synchronizeReceivedSharedWasmMemory(memory, ptrWidth);

  let threadInstance: WebAssembly.Instance | undefined;
  try {
    // Strip the start section AND neuter the constructor function body to prevent
    // constructors from re-running. Thread instances share memory with the main
    // thread; re-running constructors would clobber global state.
    let programBytes: ArrayBuffer | null = null;
    if (!initData.programModule) {
      programBytes = patchWasmForThread(initData.programBytes);
    }
    const module = initData.programModule
      ? initData.programModule
      : new WebAssembly.Module(programBytes!);
    registerWasmModuleReflection(
      module,
      programBytes ?? initData.programBytes,
    );

    const hasForkInstrumentation = hasCompleteForkInstrumentation(module, pid);
    const hasDylinkForkRole = forkInstrumentRoleAvailable(
      readForkInstrumentCapabilityClaim(module),
      FORK_CAP_DYLINK_MAIN,
    );
    // A pthread shares its PROCESS's dlopen archive, lock words and
    // table-generation fence, all below the process main channel.
    const processArchiveControlAddr = processChannelOffset - FORK_BUF_SIZE;
    const processGenerationAddress = processArchiveControlAddr - (ptrWidth === 8
      ? DLOPEN_GENERATION_OFFSET_WASM64
      : DLOPEN_GENERATION_OFFSET_WASM32);
    // A fork issued FROM this thread unwinds and seals through this thread's
    // own co-resident fork module -- the same `ForkWorker` a process Worker
    // runs. Only three facts differ: the module's region is always a fresh
    // mapping (a pthread Worker is never a fork child, so it inherits
    // nothing), the module publishes the launch root in THIS thread's fork
    // control word (the child resumes the thread's function, not `_start`),
    // and the archive it reads is the process's. The multi-activation
    // RECONSTRUCTION runs in the child, on the process path.
    const fork = hasForkInstrumentation
      ? new ForkWorker({
          memory,
          ptrWidth,
          channelOffset,
          pid,
          label: `pid=${pid} tid=${tid}`,
          forkModuleModule: initData.forkModuleModule,
          guestModule: module,
          guestBytes: initData.programBytes,
          archiveControlAddr: processArchiveControlAddr,
          generationAddress: processGenerationAddress,
          forkChild: false,
          borrowedChild: false,
          reserve: (size) =>
            continuationMmap(memory, channelOffset, size, `pid=${pid} tid=${tid}: fork-module`),
        })
      : null;

    let kernelThreadExitStatus: number | null = null;
    const kernelImports = buildKernelImports(
      memory,
      channelOffset,
      ptrWidth,
      undefined,
      undefined,
      initData.secureExec,
      (status) => {
        kernelThreadExitStatus = status;
      },
    );
    if (fork) kernelImports.kernel_fork = fork.kernelForkImport();
    const threadLongjmpTag = createLongjmpTag(ptrWidth);
    const threadCppExceptionTag = createCppExceptionTag(ptrWidth);
    // The import binders below take the unwind tag as `fork?.unwindTag`, which
    // is undefined for an uninstrumented replica, and that is right: both bind
    // `env.__wpk_fork_unwind` only when the guest DECLARES that import, and an
    // uninstrumented guest declares nothing of the kind.
    const replicaActivationOwner = hasDylinkForkRole && fork
      ? createProcessDylinkActivationOwner({
          importedStateCapture: fork.identity,
          activations: fork.activations,
          tableReplication: fork.tableReplication,
          isForkChild: false,
          isPthreadReplica: true,
          // A pthread replica's side activations need the same frame/resume
          // flip the main worker's do: the module is the only frame/journal
          // implementation, so an activation without it has no continuation.
          forkModuleFrameFlip: fork.frameFlip(),
          invokeProcessFork: () => {
            const forkExport = threadInstance?.exports.fork;
            if (typeof forkExport !== "function") {
              throw new Error(
                `pid=${pid} tid=${tid}: dylink fork role is missing ` +
                  "the main libc fork export",
              );
            }
            return Number((forkExport as () => number)());
          },
          label: `pid=${pid} tid=${tid}: dylink table activations`,
        })
      : undefined;
    const threadDlopenSupport = buildDlopenImports(
      memory,
      channelOffset,
      processArchiveControlAddr,
      () =>
        threadInstance?.exports.__indirect_function_table as
          WebAssembly.Table | undefined,
      () =>
        threadInstance?.exports.__stack_pointer as
          WebAssembly.Global | undefined,
      () => threadInstance,
      ptrWidth,
      threadLongjmpTag,
      threadCppExceptionTag,
      replicaActivationOwner,
      hasDylinkForkRole
        ? undefined
        : `pid=${pid} tid=${tid}: main artifact lacks the dylink fork role capability`,
      fork?.unwindTag,
      fork
        ? (table, firstIndex, length) => {
            fork.tables.markTableMutation(table, firstIndex, length);
          }
        : undefined,
      fork ? guardFunctionImport : undefined,
      tid,
      "copied",
      initData.dylinkModuleModule,
    );
    const threadTableReplication = fork
      ? createProcessTableReplicationOwner({
          generationAddress: processGenerationAddress,
          tableCheckpoint: createForkPeerTableCheckpoint(
            () => fork.module(),
            () => fork.activations,
            channelOffset,
            pid,
          ),
          dlopen: threadDlopenSupport,
          materializeModules: () => {
            threadDlopenSupport.replayDlopens();
          },
          restoreSnapshots: true,
          label: `pid=${pid} tid=${tid}`,
        })
      : null;
    // The fork's archive reader is the fork module's, on the loader's own
    // lock word; binding lets this Worker's loader ask the module about it.
    if (fork && threadTableReplication) {
      fork.bindArchive(threadDlopenSupport, threadTableReplication);
    }
    const importObject = buildImportObject(
      module,
      memory,
      kernelImports,
      channelOffset,
      threadDlopenSupport.imports,
      () => threadInstance,
      ptrWidth,
      threadLongjmpTag,
      threadCppExceptionTag,
      fork?.unwindTag,
      (timedOutPtr, vmInterruptPtr, seconds) => {
        port.postMessage({
          type: "vm_interrupt_timer",
          pid,
          timedOutPtr,
          vmInterruptPtr,
          seconds,
        } satisfies WorkerToHostMessage);
      },
      fork?.guestImports(),
    );
    const routedThreadImportObject = fork
      ? guardImportObject(initData.programBytes, importObject)
      : importObject;
    const threadMainImportedState = fork?.identity.prepareActivation(
      0,
      module,
      routedThreadImportObject,
    );
    const threadInstanceImports = (threadMainImportedState?.imports ??
      routedThreadImportObject) as WebAssembly.Imports;
    const instance = new WebAssembly.Instance(module, threadInstanceImports);
    threadInstance = instance;
    threadMainImportedState?.complete(instance);
    if (fork) {
      // Required by `hasCompleteForkInstrumentation`, so present here.
      const threadBootstrap = instance.exports
        .wpk_fork_module_thread_bootstrap as () => void;
      fork.registerMain(instance);
      try {
        // The pthread bootstrap consumes passive element segments, so static
        // root harvesting and table-dirty registration must precede it just as
        // they do for the process-main bootstrap.
        threadBootstrap();
      } catch (error) {
        fork.activations.forget(0);
        throw error;
      }
    }

    const threadTable = instance.exports.__indirect_function_table as
      WebAssembly.Table | undefined;
    const threadStackPointer = instance.exports.__stack_pointer as
      WebAssembly.Global | undefined;
    if (
      (!threadTable || !threadStackPointer) &&
      threadDlopenSupport.archiveGeneration() !== 0
    ) {
      throw new Error(
        `pid=${pid} tid=${tid}: process has dlopen table recipes but ` +
          "the pthread instance has no shared table/stack binding",
      );
    }
    threadTableReplication?.reconcileNow();

    // Initialize Wasm TLS for this thread in the slot's explicit TLS/control page.
    const wasmInitTls = instance.exports.__wasm_init_tls as
      ((addr: number | bigint) => void) | undefined;
    const tlsBlock = tlsOffset;

    if (wasmInitTls && tlsBlock > 0) {
      wasmInitTls(ptrWidth === 8 ? BigInt(tlsBlock) : tlsBlock);
    }

    // Set __stack_pointer
    const stackPointer = instance.exports.__stack_pointer as
      WebAssembly.Global | undefined;
    if (stackPointer) {
      stackPointer.value = ptrWidth === 8 ? BigInt(stackPtr) : stackPtr;
    }

    // Initialize musl thread pointer if available
    const wasmThreadInit = instance.exports.__wasm_thread_init as
      ((tp: number | bigint) => void) | undefined;
    if (wasmThreadInit && tlsPtr > 0) {
      wasmThreadInit(ptrWidth === 8 ? BigInt(tlsPtr) : tlsPtr);
    }

    // Set __channel_base without calling the exported helper. lld can prefix
    // exported functions with __wasm_call_ctors, and thread workers must not
    // re-run constructors in shared process memory.
    setupChannelBase(
      instance,
      module,
      memory,
      channelOffset,
      initData.programBytes,
      ptrWidth,
    );

    // Call the thread function via indirect function table
    const table = threadTable;
    if (!table) {
      throw new Error(
        "No __indirect_function_table export — cannot call thread function",
      );
    }

    // On wasm64, table indices may require BigInt (table64 extension)
    const tableIdx = ptrWidth === 8 ? BigInt(fnPtr) : fnPtr;
    const threadFn = table.get(tableIdx as number) as
      ((...args: (number | bigint)[]) => number | bigint) | null;
    if (!threadFn) {
      throw new Error(`Thread function at table index ${fnPtr} is null`);
    }

    let result = 0;
    if (fork) {
      // The fork module's run loop (`fm_run`) calls the thread function, or
      // -- once a fork from this thread has captured --
      // `wpk_fork_resume_thread`, which rewinds the parent's frames back into
      // it. Both are the guest's own fixed `(table_index, arg) -> ptr`
      // entries, emitted by fork-instrument in the calling convention the
      // guest's table actually uses (plain C, or binaryen's `--fpcast-emu`),
      // which the module calls through its drive table. Checked here so a
      // stale artifact fails by name rather than as a call through an
      // unbound slot.
      if (
        typeof instance.exports[WPK_FORK_EXPORT_THREAD_ENTRY] !== "function"
        || typeof instance.exports.wpk_fork_resume_thread !== "function"
      ) {
        throw new Error(
          `pid=${pid} tid=${tid}: fork-capable program is missing ` +
            `${WPK_FORK_EXPORT_THREAD_ENTRY} or wpk_fork_resume_thread; ` +
            "rebuild it through the current fork-instrument",
        );
      }
      const outcome = fork.run("thread", fnPtr, argPtr, () => kernelThreadExitStatus);
      // No `fork.finish()`: after `kernel_exit` this thread's channel is
      // gone, and a module release through it would park forever.
      result = "exited" in outcome ? outcome.exited : Number(outcome.returned);
    } else {
      try {
        const raw = threadFn(...buildThreadEntryArgs(threadFn, argPtr, ptrWidth));
        result = Number(raw);
      } catch (e) {
        if (isWasmUnreachableTrap(e) && kernelThreadExitStatus !== null) {
          result = kernelThreadExitStatus;
        } else {
          throw e;
        }
      }
    }

    // A normal return has not passed through libc's noreturn kernel_exit
    // import, so publish SYS_EXIT here. When kernel_exit already ran it sent
    // and completed SYS_EXIT before the compiler's trailing unreachable was
    // caught above. Publishing a second exit on that now-removed channel
    // parks this Worker forever; after slot reuse its stale atomic waiter can
    // steal the next pthread's first notify.
    if (kernelThreadExitStatus === null) {
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Exit, true);
      view.setInt32(base + CH_ARGS, result ?? 0, true);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      // Wait for kernel to process the exit. The kernel completes the channel
      // (CH_STATUS -> COMPLETE), which returns this Atomics.wait.
      while (
        Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) ===
        "ok"
      ) {
        /* */
      }
      // Intentionally do NOT reset CH_STATUS back to IDLE here. A normal syscall
      // resets to IDLE so the next syscall can set PENDING, but an exiting thread
      // issues no further syscalls — the channel is torn down and the slot is
      // re-zeroed when it is reclaimed for a future clone(). Writing here would be
      // the thread's only post-exit touch of the channel, so omitting it removes
      // any possibility of a late write landing on a reused slot's status word.
    }

    port.postMessage({
      type: "thread_exit",
      pid,
      tid,
    } satisfies WorkerToHostMessage);
  } catch (err) {
    // The fork module released any archive reader a fork held before this
    // error reached here, and reclaims its own transaction state.
    if (err instanceof ExecRetirement) {
      port.postMessage({
        type: "exec_retired",
        pid,
        tid,
      } satisfies WorkerToHostMessage);
      return;
    }
    const message =
      err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    port.postMessage({
      type: "error",
      pid,
      message: `Thread worker failed: ${message}`,
    } satisfies WorkerToHostMessage);
  }
}
