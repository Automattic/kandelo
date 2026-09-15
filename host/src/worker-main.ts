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
  CH_TOTAL_SIZE,
  HOST_INTERCEPTED_SYSCALLS,
  POSIX_ARG_MAX_BYTES,
  PROCESS_FORK_MODE_FORK,
  PROCESS_FORK_MODE_VFORK,
  PROCESS_METADATA_ENTRY_MAX_BYTES,
  PROCESS_STARTUP_MAX_ARGV_COUNT,
  PROCESS_STARTUP_MAX_ENVP_COUNT,
  WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP,
  WPK_FORK_EXPORT_MODULE_STATE_RESTORE,
  WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE,
  WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE,
  WPK_FORK_EXCEPTION_CODEC_SECTION,
  WPK_FORK_GC_CODEC_SECTION,
  WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE,
  WPK_FORK_REFERENCE_EXPORT_GC_FILL,
  WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT,
  WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
  WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE,
  WPK_FORK_REFERENCE_TRANSACTION_OWNER,
  WPK_FORK_REQUIRED_EXPORTS,
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
import {
  ContinuationAllocationError,
  readLinkedFrameFormat,
  writeForkContinuationAnchor,
} from "./fork-continuation";
import {
  buildForkGuestImports,
  forkActivationFrameImports,
  FORK_GUEST_ACTIVATION_GLOBAL_IMPORT,
  FORK_GUEST_TABLE_GENERATION_ADDR_IMPORT,
  type ForkGuestHostFloor,
  forkUnwindTagFrom,
  FORK_GUEST_RESUME_TABLE_IMPORT,
  isForkUnwindException,
  requireForkUnwindTag,
} from "./fork-guest-imports";
import { type ForkPhase, forkPhase } from "./fork-phase";
import { ForkResumeTable } from "./fork-resume-table";
import { waitForForkReplayCommit } from "./fork-replay-gate";
import {
  type ForkModuleExports,
  type ForkModuleInstance,
  instantiateForkModule,
} from "./fork-module-instance";
import { ForkReferenceCaptureModule } from "./fork-reference-capture-module";
import {
  type ForkBorrowedReplayWorkspace,
  requireForkModuleBackend,
  FORK_MODULE_RESUME_CATALOG_CAP,
  ForkModuleContinuationBackend,
} from "./fork-module-backend";
import {
  type ForkModuleHostCapabilities,
  createForkModuleHostCapabilities,
} from "./fork-module-host-capabilities";
import {
  computeForkModuleTemplateId,
  readForkModuleStatePointerWidth,
  readForkModuleStateRoot,
} from "./fork-guest-sections";
import { ForkAnyrefTransitTable } from "./fork-anyref-transit";
import { createForkGuestHostFloor } from "./fork-guest-host-floor";
import { writeCapturedExternrefHandover } from "./fork-externref-process-owner";
import { ForkExceptionBroker } from "./fork-exception-broker";
import { ForkChildReferences } from "./fork-child-references";
import {
  forkResumeTargetsFromInstance,
  readForkResumeCatalog,
} from "./fork-resume-catalog";
import {
  ForkExternrefTokenCache,
  ForkExternrefTokenRecipeProvider,
} from "./fork-reference-broker";
import { ForkHostImportWorkerRuntime } from "./fork-host-import-runtime";
import {
  ForkImportIdentity,
  type ForkWasmImports,
  type PreparedForkParentActivation,
} from "./fork-import-identity";
import { ForkActivations, forkActivationCatalogSink } from "./fork-activations";
import { ForkTableStateOwners } from "./fork-table-state-owners";
import { ForkMergedFunctionCatalog } from "./fork-merged-catalog";
import { ForkTables } from "./fork-tables";
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

/** @internal Exported so cross-engine exit-trap recognition is tested. */
export function isWasmUnreachableTrap(error: unknown): boolean {
  // WHY: WebKit describes the same Wasm `unreachable` trap as
  // "Unreachable code should not be executed" while V8 uses lowercase
  // "unreachable". The RuntimeError guard keeps an ordinary JavaScript Error
  // containing that word from masquerading as a committed guest exit.
  return error instanceof WebAssembly.RuntimeError
    && /\bunreachable\b/i.test(error.message);
}

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

function continuationMmap(
  memory: WebAssembly.Memory,
  channelOffset: number,
  size: number,
  label: string,
): number {
  const base = channelOffset;
  let view = new DataView(memory.buffer);
  view.setInt32(base + CH_SYSCALL, SYS_MMAP_NR, true);
  view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, 0n, true);
  view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(size), true);
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
  let i32 = new Int32Array(memory.buffer);
  Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
  Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
  while (
    Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok"
  ) {
    /* */
  }

  view = new DataView(memory.buffer);
  i32 = new Int32Array(memory.buffer);
  const result = Number(view.getBigInt64(base + CH_RETURN, true));
  const err = view.getUint32(base + CH_ERRNO, true);
  clearDeferredSignalDelivery(view, base);
  Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);
  if (err || result < 0) {
    const errno = err || -result;
    throw new ContinuationAllocationError(
      errno,
      size,
      `${label}: mmap(${size}) failed errno=${errno}`,
    );
  }
  return result;
}

function continuationMunmap(
  memory: WebAssembly.Memory,
  channelOffset: number,
  addr: number,
  size: number,
  label: string,
): void {
  const base = channelOffset;
  const view = new DataView(memory.buffer);
  view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Munmap, true);
  view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, BigInt(addr), true);
  view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(size), true);
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
    /* */
  }
  const resultView = new DataView(memory.buffer);
  const resultI32 = new Int32Array(memory.buffer);
  const result = Number(resultView.getBigInt64(base + CH_RETURN, true));
  const err = resultView.getUint32(base + CH_ERRNO, true);
  clearDeferredSignalDelivery(resultView, base);
  Atomics.store(resultI32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);
  if (err || result < 0) {
    throw new Error(
      `${label}: munmap(0x${addr.toString(16)}, ${size}) failed errno=${err || -result}`,
    );
  }
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
// Errno::EOPNOTSUPP (crates/shared/src/lib.rs; POSIX ENOTSUP shares this value).
// Returned to a guest fork() that carries a reference kind the platform cannot
// faithfully reconstruct in a fresh child (see the capture-side record-stubs in
// fork-activation-registry.ts). No host-generated numeric errno constant exists
// for this seam, so it is defined symbolically here.
const FORK_REFERENCE_EOPNOTSUPP = 95;

function processForkMode(value: number): ProcessForkMode | null {
  if (value === PROCESS_FORK_MODE_FORK) return PROCESS_FORK_MODE_FORK;
  if (value === PROCESS_FORK_MODE_VFORK) return PROCESS_FORK_MODE_VFORK;
  return null;
}

function processForkSyscall(mode: ProcessForkMode): number {
  return mode === PROCESS_FORK_MODE_VFORK
    ? HOST_INTERCEPTED_SYSCALLS.SYS_VFORK
    : HOST_INTERCEPTED_SYSCALLS.SYS_FORK;
}

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

    // Fork dispatches through the mode's dedicated channel syscall.
    kernel_fork: (rawMode: number): number => {
      const mode = processForkMode(rawMode);
      if (mode === null) return -STARTUP_EINVAL;
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(
        base + CH_SYSCALL,
        processForkSyscall(mode),
        true,
      );
      for (let i = 0; i < 6; i++)
        view.setBigInt64(base + CH_ARGS + i * CH_ARG_SIZE, 0n, true);

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
  /** Acquire one process-archive reader token, blocking behind a writer. */
  acquireArchiveReader(): void;
  /** Release one reader token acquired by this Worker. */
  releaseArchiveReader(): void;
  withArchiveWriter<T>(operation: () => T): T;
  withArchiveReader<T>(operation: () => T): T;
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
  readonly memory: WebAssembly.Memory;
  readonly ptrWidth: 4 | 8;
  readonly channelOffset: number;
  readonly forkUnwindTag: WebAssembly.Tag | undefined;
  readonly resumeTable: ForkResumeTable;
  readonly importedStateCapture?: ForkImportIdentity;
  /** The host's record of live activations; see `fork-activations.ts`. */
  readonly activations?: ForkActivations;
  readonly tableReplication?: ForkActivationTableReplication;
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
   * externref provenance map is keyed by object identity across the whole
   * capture, and the exception throwers route by owner inside the broker.
   */
  readonly forkHostFloor: ForkGuestHostFloor;
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
   * trampoline (wasm->wasm), and its resume catalog is seeded into the module so
   * its slot numbering matches its JS `__wpk_fork_resume_table`. Null keeps the
   * byte-identical JS continuation closures for the activation's frames.
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
 * Activation IDs are monotonic in a parent and copied verbatim through the
 * dlopen replay archive. They are coordinates in KFMS recipes and replay
 * events, not reusable loader handles.
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
    if (activationId >= nextActivationId) {
      if (activationId === 0xffff_ffff) {
        nextActivationId = 0x1_0000_0000;
      } else {
        nextActivationId = activationId + 1;
      }
    }
    return activationId;
  };

  return {
    prepare(request) {
      if (options.isForkChild && request.replayActivationId === undefined) {
        throw new Error(
          `${request.name}: fresh-child replay is missing its activation id`,
        );
      }
      if (
        !options.isForkChild &&
        !options.tableReplication &&
        request.replayActivationId !== undefined
      ) {
        throw new Error(
          `${request.name}: a parent load supplied a replay activation id`,
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
      // The co-resident Rust module owns all linked frames, journal and resume
      // storage. What the host reads out of this activation's module is its
      // linked-frame FORMAT, and only two fields of it.
      const format = readLinkedFrameFormat(request.module);
      if (format.ptrWidth !== options.ptrWidth) {
        throw new Error(
          `${request.name}: linked continuation pointer width ` +
            `${format.ptrWidth} does not match the process ` +
            `pointer width ${options.ptrWidth}`,
        );
      }
      const moduleStatePtrWidth = readForkModuleStatePointerWidth(request.module);
      if (moduleStatePtrWidth !== options.ptrWidth) {
        throw new Error(
          `${request.name}: module-state pointer width ${moduleStatePtrWidth} ` +
            `does not match the process pointer width ${options.ptrWidth}`,
        );
      }
      const templateId = computeForkModuleTemplateId(request.moduleBytes);

      // Phase 6 D7a.1a: seed THIS side activation's resume catalog into the
      // module once, at instantiation (before any fork drives it), so the
      // module numbers its resume slots from the SAME ordinals as its JS
      // `__wpk_fork_resume_table`. Done on both the parent (dlopen) and the child
      // (replayDlopens), each seeding its own module instance.
      if (options.forkModuleFrameFlip) {
        const activationOrdinals = readForkResumeCatalog(request.module).map(
          (entry) => entry.functionOrdinal,
        );
        options.forkModuleFrameFlip.backend.setActivationResumeCatalog(
          activationId,
          activationOrdinals,
        );
      }

      // The co-resident module is the ONLY capture/replay implementation on this
      // path (Phase 4 point of no return), so a side activation without one is a
      // programming error rather than a reason to fall back.
      if (!options.forkModuleFrameFlip) {
        throw new Error(
          `${request.name}: side activation ${activationId} has no fork module; ` +
            "there is no JavaScript continuation to fall back to",
        );
      }
      const activationLabel = `${request.name}: fork activation`;
      const guestImports = buildForkGuestImports({
          moduleExports: options.forkModuleFrameFlip.moduleExports,
          floor: options.forkHostFloor,
          // What a JS host genuinely supplies, and only that. Everything else
          // the guest imports comes from the module, and anything neither side
          // provides fails here BY NAME rather than as a LinkError naming a type.
          extras: {
            fork: (): number => options.invokeProcessFork(),
            // The resume table is host floor: the module's `resume_peek` returns
            // an index INTO it and Rust cannot hold a funcref.
            [FORK_GUEST_RESUME_TABLE_IMPORT]:
              options.resumeTable.table as unknown as WebAssembly.ImportValue,
            [FORK_GUEST_ACTIVATION_GLOBAL_IMPORT]: new WebAssembly.Global(
              { value: "i32", mutable: false },
              activationId,
            ),
            ...(options.tableReplication
              ? {
                  [FORK_GUEST_TABLE_GENERATION_ADDR_IMPORT]:
                    options.tableReplication.generationAddress,
                }
              : {}),
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
          if (!childImportedStatePlanner) {
            throw new Error(
              `${request.name}: activation ${activationId} requested saved `
              + "import state before wrapping its final imports",
            );
          }
          return childImportedStatePlanner.savedMutableGlobalImport(
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
          options.resumeTable.registerActivation(
            activationId,
            forkResumeTargetsFromInstance(request.module, instance),
          );
          // Remembering it here also BINDS its drive slots, so the module can
          // `call_indirect` this guest's unwind/rewind/abort entry points. That
          // used to happen in one sweep over the registry during the child
          // install, which left a parent's slots unbound until it forked.
          options.activations?.register({
            activationId,
            module: request.module,
            instance,
            fixedPrefixSize: format.fixedPrefixSize,
            templateId,
          });
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
            if (registered) {
              try {
                options.resumeTable.unregisterActivation(activationId);
                options.activations?.forget(activationId);
              } catch (error) {
                failure = error;
              }
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
  hostImportRuntime?: ForkHostImportWorkerRuntime,
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
  const resolvedLibraryPaths = new Map<string, string>();
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
  let mainArchiveReaderDepth = 0;
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
    if (mainArchiveReaderDepth > 0) {
      throw new Error(
        "cannot acquire the process archive writer while owning a reader",
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
  const acquireArchiveReader = (): void => {
    requireOwnedMemory("acquire the dynamic-loader archive reader");
    if (mainDlopenDepth > 0) {
      throw new Error(
        "cannot acquire a process archive reader while owning its writer",
      );
    }
    for (;;) {
      const transactionOwner = foreignLoaderOwner();
      if (transactionOwner !== DLOPEN_OWNER_IDLE) {
        // POSIX fork preserves only its calling thread. Waiting here prevents
        // a child from inheriting another thread's half-executed constructor,
        // whose Wasm continuation cannot exist in the child.
        Atomics.wait(loaderOwner, 0, transactionOwner);
        continue;
      }
      const owner = Atomics.load(archiveLock, 0);
      if (owner < 0) {
        Atomics.wait(archiveLock, 0, owner);
        continue;
      }
      if (owner >= DLOPEN_LOCK_MAX_READERS) {
        throw new RangeError("dlopen process archive reader count exhausted");
      }
      if (Atomics.compareExchange(archiveLock, 0, owner, owner + 1) !== owner) {
        continue;
      }
      mainArchiveReaderDepth++;
      return;
    }
  };
  const releaseArchiveReader = (): void => {
    if (mainArchiveReaderDepth <= 0) {
      throw new Error(
        "dlopen process archive reader released without ownership",
      );
    }
    for (;;) {
      const owner = Atomics.load(archiveLock, 0);
      if (owner <= DLOPEN_LOCK_IDLE) {
        throw new Error(
          `dlopen process archive reader lost ownership (state=${owner})`,
        );
      }
      if (Atomics.compareExchange(archiveLock, 0, owner, owner - 1) !== owner) {
        continue;
      }
      mainArchiveReaderDepth--;
      if (owner === 1) Atomics.notify(archiveLock, 0);
      return;
    }
  };
  const withArchiveReader = <T>(operation: () => T): T => {
    acquireArchiveReader();
    try {
      return operation();
    } finally {
      releaseArchiveReader();
    }
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

  const forgetMemoryAllocation = (
    allocation: Readonly<{
      address: number;
      mappingAddress: number;
      mappingSize: number;
    }>,
  ): void => {
    const existing = linkerAllocations.get(allocation.address);
    if (!existing) return;
    if (
      existing.rawAddr !== allocation.mappingAddress ||
      existing.length !== allocation.mappingSize
    ) {
      throw new Error(
        `dlopen replay: allocation 0x${allocation.address.toString(16)} ` +
          "changed before peer unload",
      );
    }
    linkerAllocations.delete(allocation.address);
  };

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

  const resolveLibrarySync = (
    dependency: string,
    requester?: string,
  ): Uint8Array | null => {
    const candidates: string[] = [];
    const addCandidate = (candidate: string): void => {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    };
    if (dependency.startsWith("/")) {
      addCandidate(dependency);
    } else {
      const requesterPath =
        requester === undefined
          ? undefined
          : (resolvedLibraryPaths.get(requester) ?? requester);
      const slash = requesterPath?.lastIndexOf("/") ?? -1;
      if (requesterPath && slash >= 0) {
        const directory = slash === 0 ? "/" : requesterPath.slice(0, slash);
        addCandidate(
          directory === "/" ? `/${dependency}` : `${directory}/${dependency}`,
        );
      }
      addCandidate(dependency);
      addCandidate(`/lib/${dependency}`);
      addCandidate(`/usr/lib/${dependency}`);
      addCandidate(`/usr/local/lib/${dependency}`);
    }

    for (const candidate of candidates) {
      const bytes = readDependencyFile(candidate);
      if (bytes === null) continue;
      resolvedLibraryPaths.set(dependency, candidate);
      return bytes;
    }
    return null;
  };

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
        ...(hostImportRuntime
          ? {
              routeFunctionImport: (imported, implementation) =>
                hostImportRuntime.routeFunction(imported, implementation),
            }
          : {}),
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
    acquireArchiveReader,
    releaseArchiveReader,
    withArchiveWriter,
    withArchiveReader,
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
const WPK_FORK_EXPORTS = WPK_FORK_REQUIRED_EXPORTS.map(({ name }) => name);

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
  /**
   * Acquire the process writer, apply the latest snapshot, and return its
   * exact generation. Ownership stays live until `commit` or `abort`.
   */
  beginMutation(): bigint;
  /** Apply the latest process snapshot and return its exact generation. */
  reconcile(): bigint;
  /** Publish a successful guest mutation and release writer ownership. */
  commit(
    activationId: number,
    ownerId: number,
    firstIndex: number | bigint,
    length: number | bigint,
  ): void;
  /** Release writer ownership after a non-mutating failure or no-op. */
  abort(): void;
}

interface ProcessTableReplicationOwner extends ForkActivationTableReplication {
  /** Bring this Worker to the latest complete process generation. */
  reconcileNow(): number;
  /** Check the archive fence while the caller already excludes writers. */
  isCurrentUnderLock(): boolean;
  /** Release any mutation writer depths unwound by a Wasm trap. */
  abortActiveMutations(): void;
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
  label: string,
): ForkPeerTableCheckpoint {
  return {
    capture: () => backend().capturePeerTables(channelBase),
    restore: (root) => {
      // Seed the driver and build the install plan, then make the graph
      // resident: the plan drive rebuilds the funcref and externref slots the
      // guest table restore is about to read, and the graph is what the
      // reference lookups behind them resolve through.
      const plan = backend().restoreFromArena(root, pid);
      backend().decodeReferenceGraph(root);
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
  readonly tables: ForkTables;
  /**
   * Module-composed peer-table snapshot lifecycle (Path-A A3/A4). Owns the full
   * table checkpoint capture/restore through the co-resident fork module; the
   * `registry` above is retained only for the funcref-only patch fast path
   * (`captureFuncrefTablePatch` / `applyFuncrefTablePatch`), which never touched
   * the reference engine.
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
  let deferredPublication = false;
  let replicaMaterializing = false;
  let suppressInitialSnapshotRestore = !options.restoreSnapshots;
  const mutationContexts: Array<{ readonly deferPublication: boolean }> = [];

  // WHAT USED TO RELEASE A SUPERSEDED CHECKPOINT: a host arena attached to the
  // old root purely to free its chunks. The module maps those chunks and frees
  // them when the next capture reclaims its chunk list, so attaching one here
  // was the host freeing memory it never mapped -- the ownership split census
  // 133 named, and the reason `fm_module_state_arena` grew RELEASE and OWNED.
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
      let patchFloor = previousGeneration;
      if (
        snapshot.tableStateRoot !== 0 &&
        snapshot.tableCheckpointGeneration > previousGeneration
      ) {
        options.tableCheckpoint.restore(snapshot.tableStateRoot);
        // The archive, not this temporary validated view, owns the mappings.
        patchFloor = snapshot.tableCheckpointGeneration;
      }
      for (const patch of snapshot.tablePatches) {
        if (patch.generation! > patchFloor) {
          options.tables.applyFuncrefTablePatch(patch);
        }
      }
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
    replicaMaterializing = true;
    try {
      const suppressingInitialRestore = suppressInitialSnapshotRestore;
      const changed = replica.reconcile();
      if (suppressingInitialRestore && !changed) {
        // A child whose copied process has never published a dylink/table
        // archive still completed its one startup reconciliation. Do not
        // suppress the first real peer mutation published later.
        suppressInitialSnapshotRestore = false;
      }
      return replica.generation();
    } finally {
      replicaMaterializing = false;
      // Module constructors and loader table writes performed while applying
      // a validated archive snapshot are effects of that publication, not a
      // new mutation authored by this Worker.
      deferredPublication = false;
    }
  };

  const publishLocked = (): LoaderTableState => {
    // The module opens, fills and seals the arena in one call, so a failure
    // here leaves no half-built arena behind for anyone to clean up.
    const root = options.tableCheckpoint.capture();
    const publication = options.dlopen.loader().publishTableState(root);
    replica.adoptPublishedGeneration(publication.state.generation);
    deferredPublication = false;
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
      if (
        deferredPublication ||
        (!linkerPublication && tableMutationCommitted) ||
        hasPriorGuestOverlay
      ) {
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
  const abortActiveMutations = (): void => {
    while (mutationContexts.length > 0) {
      mutationContexts.pop();
      options.dlopen.releaseArchiveWriter();
    }
    deferredPublication = false;
  };
  options.dlopen.setOperationAbortObserver(abortActiveMutations);

  return {
    generationAddress,
    beginMutation: (): bigint => {
      const deferPublication = options.dlopen.writerOwned();
      options.dlopen.acquireArchiveWriter();
      mutationContexts.push({ deferPublication });
      return BigInt(replica.generation());
    },
    reconcile: (): bigint => BigInt(reconcileNow()),
    commit: (activationId, ownerId, firstIndex, length): void => {
      const context = mutationContexts.pop();
      if (!context) {
        throw new Error(
          `${options.label}: table mutation committed without ownership`,
        );
      }
      try {
        // Dlopen/start mutations occur before the module manifest and handle
        // graph are publishable. The enclosing linker transaction snapshots
        // once at its commit. Replica materialization is already represented
        // by the generation being applied and must not echo a publication.
        if (context.deferPublication) {
          if (!replicaMaterializing) deferredPublication = true;
        } else {
          const patch = options.tables.captureFuncrefTablePatch(
            activationId,
            ownerId,
            firstIndex,
            length,
          );
          if (
            patch !== null &&
            options.dlopen.loader().canPublishTablePatch(patch)
          ) {
            const publication = options.dlopen.loader().publishTablePatch(patch);
            replica.adoptPublishedGeneration(publication.state.generation);
          } else {
            // Typed/opaque entries stay on the Wasm codec path. The same full
            // checkpoint transparently compacts a bounded patch journal; no
            // table shape or mutation is rejected at either threshold.
            publishLocked();
          }
        }
      } finally {
        options.dlopen.releaseArchiveWriter();
      }
    },
    abort: (): void => {
      const context = mutationContexts.pop();
      if (!context) {
        throw new Error(
          `${options.label}: table mutation aborted without ownership`,
        );
      }
      options.dlopen.releaseArchiveWriter();
    },
    reconcileNow,
    isCurrentUnderLock: () =>
      replica.generation() === options.dlopen.archiveGeneration(),
    abortActiveMutations,
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
 * Main process worker entry point.
 */
export async function centralizedWorkerMain(
  port: MessagePort,
  initData: CentralizedWorkerInitMessage,
): Promise<void> {
  let processHostImportRuntime: ForkHostImportWorkerRuntime | null = null;
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

    // --- SDK module path (existing) ---
    const processLongjmpTag = createLongjmpTag(ptrWidth);
    const processCppExceptionTag = createCppExceptionTag(ptrWidth);
    // Assigned from the fork module once it exists, a few dozen lines below,
    // and unwrapped into `processForkUnwindTag` immediately after. The module
    // DEFINES this tag and exports it, so minting one here would leave that
    // export dead and make the module and the guest disagree about the tag the
    // moment the module throws one itself.
    let moduleForkUnwindTag: WebAssembly.Tag | undefined;
    /**
     * The process unwind tag, once the fork module has supplied it.
     *
     * An accessor rather than a value because the module is instantiated below
     * this point: reading it before then is a sequencing bug, and the existing
     * fail-loud check says so rather than handing a later `throw` an undefined.
     */
    const processForkUnwindTag = (): WebAssembly.Tag =>
      requireForkUnwindTag(moduleForkUnwindTag, `pid=${pid}: fork unwind`);
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
    const forkCapabilityClaim = readForkInstrumentCapabilityClaim(module);
    const hasDylinkForkRole = forkInstrumentRoleAvailable(
      forkCapabilityClaim,
      FORK_CAP_DYLINK_MAIN,
    );
    // Fork state — captured by kernel_fork closure
    let forkResult = 0;
    let forkMode: ProcessForkMode = initData.isForkChild
      ? (processForkMode(initData.forkMode ?? -1) ?? (() => {
          throw new Error(`pid=${pid}: fork child is missing a valid fork mode`);
        })())
      : PROCESS_FORK_MODE_FORK;
    let forkBufAddr = initData.forkBufAddr ?? 0;
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
      allowZero = false,
    ): number => {
      if (
        !Number.isSafeInteger(value)
        || value === undefined
        || (allowZero ? value < 0 : value <= 0)
      ) {
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
    // The vfork BORROWED child's admitted replay workspace, as two numbers.
    //
    // `BorrowedVforkWorkspace` used to stand here: 158 lines that validated the
    // layout, carved each activation's private prefix with an alignment walk,
    // and asserted afterwards that capture's measure and the carving agreed.
    // Every one of those jobs is the module's. It performs the SAME walk to
    // answer `fm_borrowed_replay_workspace`, so the host was re-deriving the
    // module's own arithmetic in order to hand the results back -- and since the
    // module started seeding borrowed children itself, nothing called the
    // carver at all, which is why the accounting assertion could only ever fail
    // ("consumed 0 prefix bytes; admission declared 32").
    //
    // What is left is the one fact a host has and the module cannot: where the
    // kernel put the region. The module carves it.
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
      const linkedFrameFormat = readLinkedFrameFormat(module);
      // The module-state descriptor is NOT re-validated here. `check_module_state`
      // in `crates/wasm-artifact/src/fork_contract.rs` already parsed it, made
      // this exact pointer-width comparison against the linked-frame descriptor,
      // and cross-checked both against the module's actual memories -- and this
      // program reached this line only by passing
      // `describeWasmArtifactPolicyFailures` during exec
      // (`process-lifecycle.ts`), which the artifact policy's own preamble calls
      // "the question asked on every `exec`".
      //
      // The Rust check is also the better one to keep: it names the field that
      // failed, where the message deleted from here read identically for a
      // stale artifact and a byte-corrupted one.
      //
      // This does NOT generalise to the dlopen side-activation path, which
      // re-checks the descriptor itself because the artifact policy is never
      // asked about a side module. See census section 103.
      // Phase 6 D5: eagerly instantiate the co-resident `fork-module` once, at
      // process init, behind `initData.forkModuleEnabled`. It is placed into a
      // host-reserved region of the shared memory (via the same channel
      // `continuationMmap` the fork arena uses), so its static/BSS/stack never
      // collide with live guest data. Assert exports loudly here, never mid-fork.
      // For a QUALIFYING fork (see the predicate below) step 4b/5 then flips the
      // guest's five frame/resume imports to this instance and routes the
      // coordinator through it. Flag-off is byte-identical: this whole branch is
      // skipped, no region is reserved, and no import is flipped.
      let forkModuleInstance: ForkModuleInstance | null = null;
      // The process worker's single Wasm-GC transit table (STORE #2). It is the
      // SAME object the guest publishes struct/array/i31 identities into (bound to
      // every activation's `__wpk_fork_ref_gc_transit` import via the registry
      // below) AND the object the co-resident fork-module's injected
      // `fm_drive_execute` reads back after each ALLOC step, so the drive's
      // post-allocate integrity check sees what the guest published. On flag-on
      // this WRAPS the fork-module's own exported table (assigned below, once the
      // module exists) so all three parties — guest import, module export, and
      // this host seam — share one object; on flag-off (no fork-module) it mints
      // its own table, exactly as before.
      let forkGcTransit: ForkAnyrefTransitTable;
      // Phase 6 D6.2: the real engine-floor `wpk_fork_host.*` seam backing (the
      // externref side table + broker token materialization). Null when the
      // fork-module is not instantiated (flag-off / borrowed child).
      let forkModuleHostCapabilities: ForkModuleHostCapabilities | null = null;
      // Phase 6 D5 step 4b/5: when the fork qualifies, this backend drives the
      // continuation through the co-resident module and the coordinator takes
      // its module-backed branches. Null (non-qualifying / flag-off) => the
      // byte-identical JavaScript continuation.
      let forkModuleBackend: ForkModuleContinuationBackend | null = null;
      // Phase 6 D7a.1a: per-activation frame trampolines for a dlopen fork. Each
      // dlopen'd side activation's five frozen frame/resume imports are flipped
      // to its own trampoline (wasm->wasm), folding in the activation id so its
      // frames route to its own writer/driver in the shared module. Null unless
      // the module-backed path is active.
      let forkModuleFrameExports: Record<string, unknown> | null = null;
      /**
       * The funcref table the guest imports as `__wpk_fork_resume_table`, and
       * the module indexes through `fm_resume_peek`.
       *
       * Host floor: it is a live `WebAssembly.Table` holding the guest's own
       * exported thunks, which the module cannot hold for it. The coordinator
       * used to own one and hand it out through `continuationImports`; this is
       * the same table with the coordinator removed from between.
       */
      const resumeTable = new ForkResumeTable(`pid=${pid}: fork resume table`);

      /**
       * The module backend, narrowed. Every fork path that reaches a lifecycle
       * call has one by construction; this is where that stops being an
       * assumption and starts being a named failure.
       */
      const forkModule = (): ForkModuleContinuationBackend =>
        requireForkModuleBackend(forkModuleBackend, pid);

      /**
       * The errno an abort replay will report, remembered from the host call
       * that started it.
       *
       * This was `ForkProcessContinuationCoordinator.abortErrno()`, which stored
       * the value the host passed to `beginAbortReplay` and handed it back at
       * the finish. The module has no use for it -- an abort replay is an abort
       * replay whatever number the host means to return -- so it stays here,
       * as the one line it always was rather than a coordinator method.
       */
      let forkAbortErrno = 0;
      let useForkModule = false;
      // Phase 6 item 4: a borrowed (vfork) child instantiates its OWN fork-module
      // at a distinct `__memory_base` by channel-mmapping a fresh region on
      // demand. Captured here so the child releases it (channel-munmap) the moment
      // its single replay finishes, instead of leaking ~5.4 MiB into the parked
      // parent's restored address space (the kernel never shrinks memory —
      // reclamation is free-list reuse, so an un-munmap'd region persists).
      let forkModuleBorrowedRegion: { base: number; bytes: number } | null = null;
      // Phase 6 D6.1: true only for a CHILD fork whose decoded reference graph is
      // FUNCREF + NULL only (no externref/gc/exnref/static-root to reconstruct).
      // Gates flipping the guest's `__wpk_fork_ref_decode_funcref` import to the
      // module AND seeding the module's reference graph on the child. Stays false
      // for the parent (its guest was instantiated at parent init, before any
      // fork transaction existed) and for any fork with a non-funcref reference,
      // so those keep the byte-identical JS reference path.
      let moduleReferenceKindsSupported = false;
      // The child worker's externref token cache (broker handle -> canonical
      // worker-local token). Created BEFORE the fork-module so the D6.2
      // engine-floor seam can close over it; also owned by the JS reference path
      // (the still-JS `__wpk_fork_ref_decode_externref` materializes the SAME
      // idempotent token, so the module and JS agree on identity).
      if (
        initData.forkHostImports === undefined ||
        initData.externrefGenerationId === undefined
      ) {
        throw new Error(
          `pid=${pid}: ABI ${ABI_VERSION} fork artifact requires its process owner ` +
            "host-import mailbox and externref generation",
        );
      }
      const externrefTokens = new ForkExternrefTokenCache(
        initData.externrefGenerationId,
      );
      // Phase 6 item 4: a vfork/borrowed child now ALSO instantiates the
      // co-resident module, so its ONE continuation replay runs through the
      // module (wasm->wasm) instead of the JS engine. The original gate skipped
      // the borrowed child on two grounds: (1) it execs almost immediately, so a
      // module was "pointless overhead" — but it still has one real replay to
      // drive, which is exactly what item 4 moves onto the module; and (2) it
      // "must not reserve or own a co-resident region" in the parked parent's
      // shared memory — the real invariant. We honor (2) with an ON-DEMAND
      // region: `instantiateForkModule` channel-mmaps a FRESH, kernel-allocated,
      // guaranteed-non-overlapping ~5.4 MiB region (it cannot alias the parent's
      // live data), and the child channel-munmaps it the moment its replay
      // finishes (see `forkModuleBorrowedRegion` release after `finishReplay`) so
      // nothing is durably owned in the parent's restored address space. A
      // FOLLOW-UP (see ITEMS-4-7-PLAN.md) makes even the parent's instantiation
      // lazy until first fork so a worker that never forks pays nothing.
      {
        // The co-resident fork-module is the UNCONDITIONAL fork reconstructor +
        // capturer: there is no kill switch and no JS reference engine behind it,
        // so every fork-instrumented worker MUST receive it. A missing module
        // fails loud rather than silently dropping to a deleted JS path.
        const forkModuleModule = initData.forkModuleModule;
        if (!forkModuleModule) {
          throw new Error(
            `pid=${pid}: fork-instrumented worker requires the co-resident ` +
              "fork module",
          );
        }
        if (ptrWidth !== linkedFrameFormat.ptrWidth) {
          throw new Error(
            `pid=${pid}: fork-module width mismatch: process ptrWidth ` +
              `${ptrWidth} vs linked frames ${linkedFrameFormat.ptrWidth}`,
          );
        }
        // M2: the single REAL `env.resolve_externref(handle) -> externref`
        // import body backing the module's externref reconstruction. It
        // closes over this worker's externref token cache so
        // `resolve_externref` re-roots the SAME canonical token the still-JS
        // `__wpk_fork_ref_decode_externref` returns (identity parity;
        // `ForkExternrefTokenCache.materialize` is idempotent). The FIVE old
        // `wpk_fork_host` externref/transit imports (`host_begin_generation`,
        // the 2-arg `host_resolve_externref`, `host_transit_publish`,
        // `host_transit_read`, `host_release_generation`) are gone from the
        // rebuilt module (M2 t1-t4): the injected binder now performs the
        // decode + anyref-transit `table.set` itself
        // (`__wpk_fork_ref_decode_externref` export, flipped in below), so
        // this host seam no longer routes through `activationRegistry`'s
        // early-GC transit at all.
        forkModuleHostCapabilities = createForkModuleHostCapabilities({
          tokens: externrefTokens,
        });
        // A COPIED fork child INHERITS the parent's co-resident fork-module
        // region through its full memory clone (the region is present both in
        // the inherited bytes and in the inherited kernel mapping table). It
        // MUST reuse that exact base instead of reserving a fresh one: a fresh
        // `mmap` would allocate a SECOND module region on top of the inherited
        // one (the inherited region's base is already mapped, so first-fit skips
        // it and grows the memory), double-counting ~88 pages and inflating the
        // child's observable `memory.size` — which breaks the fork memory-clone
        // invariant (a forked child must observe the parent's EXACT size). The
        // kernel host passes the parent's base via `forkModuleInheritedBase`
        // (see `handleOrdinaryFork`). A borrowed (vfork) child is excluded: it
        // does not clone memory and reserves its own on-demand region that it
        // munmaps after replay, so it never inherits a durable base.
        const inheritForkModuleRegion =
          initData.isForkChild === true &&
          !borrowedForkChild &&
          initData.forkModuleInheritedBase !== undefined;
        const inheritedForkModuleBase = initData.forkModuleInheritedBase;
        forkModuleInstance = instantiateForkModule({
          module: forkModuleModule,
          memory,
          ptrWidth,
          reserve: (size) => {
            if (inheritForkModuleRegion) {
              // Reuse the inherited region rather than mmapping a fresh one. The
              // size is deterministic (same module) so a mismatch against the
              // parent's reserved byte length is a fork-plumbing bug, not a
              // resource condition — fail loud instead of silently re-reserving.
              if (
                initData.forkModuleInheritedBytes !== undefined &&
                initData.forkModuleInheritedBytes !== size
              ) {
                throw new Error(
                  `pid=${pid}: inherited fork-module region size ` +
                    `${initData.forkModuleInheritedBytes} does not match this ` +
                    `worker's computed size ${size}`,
                );
              }
              return inheritedForkModuleBase!;
            }
            return continuationMmap(
              memory,
              channelOffset,
              size,
              `pid=${pid}: fork-module`,
            );
          },
          label: `pid=${pid}: fork-module`,
          // BOTH host functions, not just the resolver. Passing only
          // `resolve_externref` left `__wpk_fork_host_ref_identity` a trapping
          // stub, which a GC capture reaches.
          hostImports: forkModuleHostCapabilities.imports,
        });
        // Publish this worker's co-resident fork-module region so the kernel
        // host can hand a COPIED fork child the SAME base to reuse (above). A
        // borrowed (vfork) child's region is temporary (munmapped after replay),
        // so it is never reported as an inheritable base.
        if (!borrowedForkChild) {
          port.postMessage({
            type: "fork_module_region",
            pid,
            base: forkModuleInstance.memoryBase,
            bytes: forkModuleInstance.regionBytes,
          } satisfies WorkerToHostMessage);
        }
        // STORE #2: wrap the fork-module's OWN exported transit table so the
        // registry binds the guest's `__wpk_fork_ref_gc_transit` import (and this
        // host's `host_transit_publish`/`host_transit_read` seam) to the exact
        // same table the module's drive integrity check reads after each ALLOC
        // step. Before this, a distinct table was minted here and handed to the
        // registry while the module used its own — a mismatch on flag-on.
        forkGcTransit = new ForkAnyrefTransitTable(
          forkModuleInstance.exports,
          `pid=${pid}: anyref transit`,
        );
        if (borrowedForkChild) {
          // Remember the ON-DEMAND region so the child releases it when its one
          // borrowed replay finishes (channel-munmap; see after `finishReplay`).
          forkModuleBorrowedRegion = {
            base: forkModuleInstance.memoryBase,
            bytes: forkModuleInstance.regionBytes,
          };
        }

        // Phase 3 (rust-first fork point-of-no-return): the co-resident module
        // is the UNCONDITIONAL reconstructor + capturer, so it backs EVERY fork
        // on this worker path. The three former `useForkModule=false` fallbacks
        // that silently dropped to the byte-identical JS continuation twin are
        // now closed; the only reason a fork does not go through the module is a
        // genuine impossibility, which FAILS LOUD (never silent JS):
        //  - Case 1 (pointer width): the CORRECT-width module is instantiated on
        //    demand per guest (`forkModuleInitFields(ptrWidth)` in the kernel
        //    worker entries selects `fork_module32` vs `fork_module64`), and a
        //    genuine width mismatch already threw above. No fallback remains.
        //  - Case 2 (resume catalog > cap): raised to hold every real guest's
        //    catalog (php-fpm/node were the only programs past the old 16384
        //    cap). The cap is a module-BSS structure, enforced loudly by the
        //    backend constructor below; a catalog past the (raised) cap is a
        //    fail-loud module-capacity boundary, not a JS fallback.
        //  - Case 3 (fork-from-thread child): its module replay path needs the
        //    guest's `wpk_fork_resume_thread` export, which fork-instrument emits
        //    for any guest exporting `__indirect_function_table` — i.e. every
        //    pthread-capable (hence fork-from-thread-capable) guest. A thread
        //    child missing it is a stale / mis-instrumented artifact; fail loud
        //    so it is rebuilt through the current fork-instrument path.
        // Single-activation admission is UNCHANGED (Phase 6 D7a.1a): a dlopen
        // fork's side activations seed their OWN resume catalogs through the
        // module, and multi-activation REFERENCES still take the JS reference
        // path via `moduleReferenceKindsSupported` (gated below). Single-thread
        // and not-vfork hold by construction here: this is the main process
        // worker path (the pthread coordinator is separate) and a borrowed vfork
        // child is admitted like any other (item 4).
        const catalogOrdinals = readForkResumeCatalog(module).map(
          (entry) => entry.functionOrdinal,
        );
        const isForkFromThreadChild =
          initData.isForkChild === true &&
          initData.forkChildThreadFnPtr != null;
        // Use the exact-bytes reflection registered above (line ~3310) rather
        // than WebAssembly.Module.exports(module) directly: WebKit throws
        // "unable to produce export descriptors for the given module" when the
        // engine cannot describe an ABI 44 fork artifact's export types as
        // descriptors, which blocked all fork on WebKit. wasmModuleExports()
        // returns the ordered descriptors Kandelo already parsed and validated
        // from the program bytes, matching every other reflection site here.
        const hasResumeThreadExport = wasmModuleExports(module).some(
          (entry) => entry.name === "wpk_fork_resume_thread",
        );
        // Case 3 fail-loud (see the block comment above): a fork-from-thread
        // child without the module resume export is a stale/mis-instrumented
        // artifact, not a routine fallback.
        if (isForkFromThreadChild && !hasResumeThreadExport) {
          throw new Error(
            `pid=${pid}: fork-from-thread child is missing the ` +
              "`wpk_fork_resume_thread` module resume export; rebuild the " +
              "program through the current fork-instrument path",
          );
        }
        useForkModule = true;
        // Phase 6 item 4: a borrowed (vfork) child is admitted like any other —
        // single-activation and multi-activation dlopen-vfork ("mode-1") are both
        // seeded through the coarse `childSeedBorrowed` module entry. The
        // coordinator's `attachBorrowedModuleChild` handles both.
        if (useForkModule) {
          // Stage the backend's small pre-fork guest buffers into the dedicated
          // slab reserved inside the fork-module region rather than mmapping a
          // fresh, memory-growing region per staging. The slab is part of the
          // single reused region, so a COPIED fork child (which reuses the whole
          // region via `forkModuleInheritedBase`) stages into the SAME slab and
          // its `memory.size` stays equal to the parent's — a growing channel
          // mmap here would land at the child's inherited (higher) mmap cursor
          // and inflate the clone. A staging request larger than the slab (a
          // large GC codec) falls back to the growing channel mmap; that path
          // never asserts an exact memory size, so its growth is invisible.
          const forkModuleStagingBase = forkModuleInstance.stagingBase;
          const forkModuleStagingBytes = forkModuleInstance.stagingBytes;
          // The instance carries its own exports, drive table and staging
          // slab, so none of those are threaded separately any more -- and the
          // reserve/release region callbacks are gone with them: the backend
          // stages into the module's OWN slab rather than asking the host for
          // a region, so there is nothing for a host to hand over or reclaim.
          forkModuleBackend = new ForkModuleContinuationBackend({
            instance: forkModuleInstance,
            memory,
            ptrWidth,
            format: linkedFrameFormat,
            catalogOrdinals,
            // The module channel-mmaps its own arena and journal image, through
            // this worker's syscall channel. It was never told where that is:
            // every capture and seal would have asked the module to issue a
            // syscall at address 0.
            channelBase: channelOffset,
            label: `pid=${pid}: fork-module`,
          });
          // Seed the linked-frame format + full resume catalog once, now, before
          // any fork drives the module. Both are host-known custom sections.
          forkModuleBackend.setup();
          // The per-activation frame entry points are the module's own, emitted
          // by the injector and read out of its table -- there is nothing to
          // construct or cache here any more.
          forkModuleFrameExports = forkModuleInstance.exports;
        }
        // The unwind transport is the module's, not this host's. The module is
        // unconditional for a fork-instrumented worker (see the fail-loud check
        // above), so there is no branch here where a host-minted fallback would
        // be needed.
        moduleForkUnwindTag = forkUnwindTagFrom(forkModuleInstance.exports, `pid=${pid} unwind`);
      }
      // Phase 6 item 3a (minimize host surface): the RESTORE data-feed FLIP. When
      // a child's whole reference graph is admitted through the module
      // (`moduleReferenceKindsSupported`), the guest's typed-GC/exnref codec reads
      // the decoded reference graph (vector entries, GC/exnref routes, scalar +
      // edge loads, exnref cache indices) through the module's seven `fm_ref_*`
      // exports instead of the JS reference provider (`referenceReplay`). The
      // still-JS drive-order (`materializeTypedGraph`) is UNCHANGED — it now calls
      // the guest `_gc_allocate`/`_gc_fill` exports, which call back into these
      // module exports (module->guest->module; safe because the feed only READS
      // the immutable decoded graph and WRITES guest memory). Flipped alongside
      // `__wpk_fork_ref_decode_funcref`, per-activation (every activation's codec
      // reads the SAME whole-graph module feed), and only when the whole graph is
      // admitted; a flag-off / non-admitted fork keeps the byte-identical JS
      // reference path (this returns `{}`, leaving the JS provider imports intact).
      const mainTemplateId = computeForkModuleTemplateId(programBytes);
      let processInstance: WebAssembly.Instance | null = null;

      // WHAT USED TO BE HERE: `newModuleStateArena`, a host KFMS arena with its
      // own channel mmap/munmap pair. Census 133 called the split it created --
      // the module maps chunks, the host frees them by walking the linked list
      // back out of guest memory -- the reason `fm_module_state_arena` grew
      // RELEASE and OWNED. Both sides are the module's now, so the host neither
      // allocates nor frees, and the chain walk, cycle check and length bound
      // it needed to do that safely go with it.
      processHostImportRuntime = new ForkHostImportWorkerRuntime(
        initData.forkHostImports,
        pid,
        initData.externrefGenerationId,
        externrefTokens,
        (wake) => {
          port.postMessage({
            type: "fork_host_import",
            wake,
          } satisfies WorkerToHostMessage);
        },
      );
      const externrefRecipes = new ForkExternrefTokenRecipeProvider(
        externrefTokens,
        (value) =>
          processHostImportRuntime!.localExceptions.normalizeUnclaimedForkValue(
            value,
          ),
      );
      // WHAT THE 2,098-LINE REGISTRY WAS, and where each part went: activation
      // bookkeeping to `ForkActivations`; the capture session and reference
      // transaction to the module, which IS the capture; the table methods to
      // `ForkTables`; the early GC transit to `ForkAnyrefTransitTable`, which it
      // only ever wrapped; the peer-table checkpoint to `fm_capture_peer_tables`
      // and the restore above. Nothing of it was rewritten.
      // Every process instance, including a freshly reconstructed child, owns
      // the provenance manifest for any fork it may issue later. It publishes
      // into the module rather than keeping a manifest of its own: the module
      // assembles the binding records at capture, so nothing here has to be
      // asked for them later.
      // The host's whole memory of this process's activations: four fields
      // each, and the drive bind that registration performs. See census 157.
      /** One of the module's scalar recipe accessors, by name. */
      const forkModuleExport = (name: string): ((recipe: number) => number) => {
        const fn = forkModuleInstance?.exports[name];
        if (typeof fn !== "function") {
          throw new Error(`pid=${pid}: fork module exports no ${name}`);
        }
        return fn as (recipe: number) => number;
      };
      // Which coordinate of an aliased table writes its sparse state. Hoisted
      // out of the import-identity constructor because activation registration
      // publishes into it too, and both must elect over ONE set of coordinates.
      const processTableStateOwners = new ForkTableStateOwners(
        (activationId, ownerId, owns) =>
          requireForkModuleBackend(
            forkModuleBackend,
            pid,
          ).setActivationTableStateOwner(activationId, ownerId, owns),
      );
      /** Each activation's static-root catalog, for a static-root recipe. */
      const forkStaticRoots = new Map<number, WebAssembly.Table>();
      // The host's table facts: which physical table a coordinate names, and
      // which coordinate a mutated table is. The module owns the dirty journal
      // those mutations land in, reached through the same export it serves to
      // the guest.
      const forkTables = new ForkTables(
        {
          markTablePages: (ownerId, firstPage, pageCount) =>
            (
              forkModuleInstance!.exports
                .__wpk_fork_module_state_table_dirty_mark as (
                  owner: number,
                  first: bigint,
                  count: bigint,
                ) => void
            )(ownerId, firstPage, pageCount),
        },
        `pid=${pid}: fork tables`,
      );
      const forkActivations = new ForkActivations(
        requireForkModuleBackend(forkModuleBackend, pid),
        `pid=${pid}: fork activations`,
        forkActivationCatalogSink({
          tables: forkTables,
          // Filled as activations register, on the PARENT as well as the child
          // -- see `ForkMergedFunctionCatalog` for why both.
          merged: new ForkMergedFunctionCatalog(
            forkModuleInstance!.functionCatalog,
            requireForkModuleBackend(forkModuleBackend, pid),
            `pid=${pid}: merged function catalog`,
          ),
          staticRoots: forkStaticRoots,
          owners: processTableStateOwners,
        }),
      );
      const importedStateCapture = new ForkImportIdentity(
        requireForkModuleBackend(forkModuleBackend, pid),
        `pid=${pid}: imported activation state`,
        processTableStateOwners,
      );
      let importedStatePlanner: ForkChildImports | null = null;
      let earlyChildReferences: ForkChildReferences | null = null;
      let childDylinkState: readonly LoaderArchivedModule[] | null = null;
      // Phase 6 item 3c: the raw KFGC (`kandelo.wpk_fork.gc_codec`) section bytes
      // per activation and the host-exception owner, captured in the child's
      // pre-instantiation planning block (where the compiled activation `modules`
      // are in scope) so the later instantiation/attach block can seed the
      // co-resident fork-module's typed-GC drive planner. Null until a fork child
      // computes them.
      let childGcCodecBytes: Map<number, Uint8Array> | null = null;
      let childHostExceptionOwner = 0xffff_ffff;
      // The exnref tag ordinals each activation's exception codec declares,
      // captured in the planning block (where the compiled `modules` are in
      // scope) so the attach block can seed the co-resident fork-module's exnref
      // tag-validity admission gate. Null until a fork child computes them.
      let childExceptionCodecBytes: Map<number, Uint8Array> | null = null;
      // Path B P3: route this worker's next fork's reference CAPTURE through the
      // co-resident module's shared builder (the module is the SOLE capture
      // graph). The parent reads its own vectors back from the resident builder
      // (`fm_capture_vector_get`) during its post-fork replay; leaf values still
      // come from `capturedValues` / the transit table (originals), so the
      // parent's live-reference identity is preserved. Non-module forks (flag
      // off) keep the JS capture graph.
      // Kept as a local as well: the JS capture session used to OPEN this
      // builder at every fork (`beginCapture`) and seal it into the arena. The
      // session is gone, the module does the sealing, and the open is the half
      // that still has to be issued from here -- it is documented as the first
      // module call of a capture fork, before the guest unwinds, because it is
      // the fork's single bump-heap reset point.
      const processCaptureModule = forkModuleInstance
        ? new ForkReferenceCaptureModule(
          forkModuleInstance.exports,
          memory,
          `pid=${pid}: fork reference capture module`,
        )
        : null;
      let processDlopenSupport: DlopenSupport | null = null;
      let processForkArchiveReaderHeld = false;
      const tableGenerationOffset =
        ptrWidth === 8
          ? DLOPEN_GENERATION_OFFSET_WASM64
          : DLOPEN_GENERATION_OFFSET_WASM32;
      const tableGenerationAddress =
        dlopenArchiveControlAddr - tableGenerationOffset;
      let processTableReplication: ProcessTableReplicationOwner | null = null;
      const tableReplicationImports: ForkActivationTableReplication = {
        generationAddress: new WebAssembly.Global(
          { value: "i64", mutable: false },
          BigInt(tableGenerationAddress),
        ),
        reconcile: (): bigint => processTableReplication?.reconcile() ?? 0n,
        beginMutation: (): bigint =>
          processTableReplication?.beginMutation() ?? 0n,
        commit: (activationId, ownerId, firstIndex, length): void => {
          processTableReplication?.commit(
            activationId,
            ownerId,
            firstIndex,
            length,
          );
        },
        abort: (): void => {
          processTableReplication?.abort();
        },
      };
      // Which arena's graph answers "who owns this exception recipe".
      //
      // The module's own root first, and the inherited one only as a fallback,
      // because a fork CHILD that later forks has both: the inherited root is
      // still the arena it was installed from, and that graph is not the one
      // its own capture just sealed. The module has no root of its own until it
      // builds one, which is exactly the window where the inherited arena is
      // the right answer.
      const exceptionGraphRoot = (): number => {
        const own = requireForkModuleBackend(
          forkModuleBackend,
          pid,
        ).moduleStateArenaRoot();
        if (own !== 0) return own;
        return childArenaRoot;
      };
      const exceptionBroker = new ForkExceptionBroker(
        () => requireForkModuleBackend(forkModuleBackend, pid),
        () => forkActivations,
        exceptionGraphRoot,
        `pid=${pid}: exception broker`,
      );

      // The process's host identity floor: the two things a JS host must do
      // itself. Built once and shared by every activation, because both are
      // process-scoped -- the provenance map is keyed by object identity across
      // the whole capture, and the broker routes a throw to its owner.
      const forkHostFloor = createForkGuestHostFloor(
        {
          tryEncodeExternref: (value) =>
            externrefTokens.encode(value) ?? undefined,
          // Re-enter wasm by calling the guest's exported thrower; a JavaScript
          // throw would reach the guest with the wrong tag. See census 109.
          exceptionThrower: () => exceptionBroker,
        },
        `pid=${pid}: fork host floor`,
      ).floor;
      // WHAT USED TO BE HERE: `registerChildReferenceActivation`, which handed
      // the early reference provider a per-activation function catalog, static
      // root decoder and GC codec provider. `ForkChildReferences` resolves a
      // coordinate through the module's decoded graph and the MERGED catalogs
      // the fork-module already imports, so there is no per-activation
      // registration left to do -- and with it went the last reader of
      // `forkGcCodecProviderFromInstance`, whose provider was only ever passed
      // on to this and to the registry.
      const readProcessLaunchRoot = (): number => {
        if (borrowedForkChild) return forkBufAddr;
        const view = new DataView(memory.buffer);
        return ptrWidth === 8
          ? Number(view.getBigUint64(dlopenArchiveControlAddr, true))
          : view.getUint32(dlopenArchiveControlAddr, true);
      };
      let inheritedLaunchRoot = 0;
      /** The KFMS arena this child inherited, or 0 when it is not a child. */
      let childArenaRoot = 0;
      if (initData.isForkChild) {
        if (
          !borrowedForkChild &&
          initData.forkChildThreadFnPtr !== undefined &&
          initData.forkBufAddr !== undefined
        ) {
          // A pthread continuation is rooted in the caller's channel page,
          // not the process-main anchor copied into the child. Publish the
          // kernel-validated launch root under activation zero before any
          // child reconstruction recipe is inspected.
          writeForkContinuationAnchor(
            memory,
            dlopenArchiveControlAddr,
            ptrWidth,
            initData.forkBufAddr,
          );
        }
        inheritedLaunchRoot = readProcessLaunchRoot();
        if (
          initData.forkBufAddr !== undefined &&
          inheritedLaunchRoot !== initData.forkBufAddr
        ) {
          throw new Error(
            `pid=${pid}: inherited process launch root ${inheritedLaunchRoot} ` +
              `does not match launch root ${initData.forkBufAddr}`,
          );
        }
        if (
          !Number.isSafeInteger(inheritedLaunchRoot)
          || inheritedLaunchRoot <= 0
        ) {
          throw new Error(
            `pid=${pid}: fork child has no inherited process launch root`,
          );
        }
        const moduleStateRoot = readForkModuleStateRoot(
          memory,
          inheritedLaunchRoot,
          ptrWidth,
        );
        // The address, and nothing else. A host arena used to be attached here
        // to validate the inherited chain before anything read it; the module
        // validates it at `fm_attach_child`, which is the reader, so attaching
        // a second view only moved the check earlier and duplicated the format.
        childArenaRoot = moduleStateRoot;
      }
      // The fresh child's route to the main activation, written into the copied
      // control-page word because no JavaScript closure survives a fork. A
      // BORROWED vfork child never writes it: that word still belongs to its
      // suspended parent.
      const publishProcessLaunchRoot = (address: number): void => {
        if (borrowedForkChild) return;
        writeForkContinuationAnchor(
          memory,
          dlopenArchiveControlAddr,
          ptrWidth,
          address,
        );
        forkBufAddr = address;
      };

      const releaseProcessForkArchiveReader = (): void => {
        if (!processForkArchiveReaderHeld) return;
        processForkArchiveReaderHeld = false;
        processDlopenSupport?.releaseArchiveReader();
      };
      const acquireCurrentProcessForkArchiveReader = (): void => {
        if (!processDlopenSupport || !processTableReplication) {
          throw new Error(`pid=${pid}: fork archive owner is not initialized`);
        }
        for (;;) {
          processTableReplication.reconcileNow();
          processDlopenSupport.acquireArchiveReader();
          processForkArchiveReaderHeld = true;
          if (processTableReplication.isCurrentUnderLock()) return;
          releaseProcessForkArchiveReader();
        }
      };

      kernelImports.kernel_fork = (rawMode: number): number => {
        if (!processInstance) return -38; // ENOSYS
        const mode = processForkMode(rawMode);
        if (mode === null) return -STARTUP_EINVAL;

        const phase = forkPhase(forkModuleFrameExports, pid);
        if (phase === "parent-replay" || phase === "child-replay") {
          if (mode !== forkMode) {
            throw new Error(
              `pid=${pid}: fork replay mode ${mode} does not match captured mode ${forkMode}`,
            );
          }
          try {
            forkModule().parentFinish(false);
          } finally {
            releaseProcessForkArchiveReader();
          }
          // Phase 6 item 4: the borrowed (vfork) child's ONE replay is done, so
          // release its on-demand fork-module region NOW (channel-munmap), before
          // the child proceeds to exec/_exit. Leaving it mapped would leak
          // ~5.4 MiB into the parked parent's restored shared address space (the
          // kernel never shrinks memory). The parent instead keeps its region for
          // the worker's lifetime (fork is repeated); only the transient borrowed
          // child releases. Idempotent: cleared so a later path never double-frees.
          if (borrowedForkChild && forkModuleBorrowedRegion) {
            const region = forkModuleBorrowedRegion;
            forkModuleBorrowedRegion = null;
            continuationMunmap(
              memory,
              channelOffset,
              region.base,
              region.bytes,
              `pid=${pid}: borrowed fork-module region`,
            );
          }
          if (initData.isForkChild) {
            const gate = initData.forkReplayGate;
            if (!gate) {
              throw new Error(
                `pid=${pid}: fork child is missing its replay commit gate`,
              );
            }
            // Every outer activation has already restored its frame before
            // descending to this import. Reaching here is therefore the exact
            // point at which the host may commit the fresh child.
            port.postMessage({
              type: "fork_replay_ready",
              pid,
            } satisfies WorkerToHostMessage);
            waitForForkReplayCommit(gate, `pid=${pid}`);
          }
          return forkResult;
        }
        if (phase === "abort-replay") {
          if (mode !== forkMode) {
            throw new Error(
              `pid=${pid}: fork abort mode ${mode} does not match captured mode ${forkMode}`,
            );
          }
          const errno = forkAbortErrno;
          try {
            forkModule().parentFinish(true);
          } finally {
            releaseProcessForkArchiveReader();
          }
          return -errno;
        }
        if (phase !== "idle") {
          throw new Error(
            `pid=${pid}: fork import reached while process continuation is ${phase}`,
          );
        }
        if (borrowedForkChild) return -STARTUP_EAGAIN;
        forkMode = mode;

        // The arena and every activation prefix are allocated before any user
        // frame commits. If this fails, fork returns errno with no partially
        // published activation graph.
        acquireCurrentProcessForkArchiveReader();
        try {
          // ROOT 0: the module allocates and OWNS the arena. That is not a
          // detail -- every record the module writes is guarded on owning it,
          // because a reserve with no writer root starts a second arena nothing
          // reads. With a host arena the imported-global and imported-table
          // bindings and the journal image were all skipped (census 161).
          //
          // What went with the host arena: `registry.beginCapture(arena)`. It
          // did three things and the module does all three. It built a capture
          // SESSION, whose only consumers were the guest-import builders this
          // host stopped using -- `buildForkActivationStateImports` and
          // `buildForkExceptionImports` are both unreferenced from host/src now,
          // because the guest's imports come from the module. It appended a
          // `Module` record per activation, which the module writes from the
          // seeded template ids. And it ran each activation's `moduleState.save()`,
          // which is the `DRIVE_OP_MODULE_STATE_SAVE` step in the module's own
          // plan. Keeping it would have meant two save walks into two arenas.
          processCaptureModule?.begin();
          publishProcessLaunchRoot(0);
          publishProcessLaunchRoot(
            forkModule().parentBeginCapture(
              channelOffset,
              0,
              forkActivations.sides(),
            ),
          );
        } catch (error) {
          // Both halves ask the MODULE now, which is what makes this safe. It
          // was left on the coordinator's mirror earlier because the two could
          // disagree: the coordinator sets its phase to capture BEFORE the
          // module call that opens one, and the argument that they re-converge
          // rested on `cancelCapture` calling `moduleBackend.abort()` -- which
          // the reduced backend did not have, so the module's phase was never
          // reset. It has it now, and more to the point neither side of this
          // branch consults the coordinator: ask the module whether it is idle,
          // tell the module to abort if it is not. No mirror left to disagree.
          if (forkPhase(forkModuleFrameExports, pid) !== "idle") {
            try {
              // Abort releases the module's own arena chunks with the rest of
              // the transaction; there is no host arena left to release.
              forkModule().abort();
            } catch {
              // Preserve the capture failure; abort has already made the
              // transaction unreachable before attempting cleanup.
            }
          }
          releaseProcessForkArchiveReader();
          forkBufAddr = 0;
          if (error instanceof ContinuationAllocationError) return -error.errno;
          throw error;
        }
        return 0; // ignored during unwind
      };

      const dylinkForkActivationOwner = hasDylinkForkRole
        ? createProcessDylinkActivationOwner({
            memory,
            ptrWidth,
            channelOffset,
            forkUnwindTag: processForkUnwindTag(),
            resumeTable,
            activations: forkActivations,
            importedStateCapture,
            tableReplication: tableReplicationImports,
            importedStatePlanner: initData.isForkChild
              ? () => importedStatePlanner
              : undefined,
            forkHostFloor,
            isForkChild: Boolean(initData.isForkChild),
            invokeProcessFork: () => {
              const fork = processInstance?.exports.fork;
              if (typeof fork !== "function") {
                throw new Error(
                  `pid=${pid}: dylink fork role is missing the main libc fork export`,
                );
              }
              return Number((fork as () => number)());
            },
            forkModuleFrameFlip:
              useForkModule && forkModuleBackend && forkModuleFrameExports
                ? {
                    moduleExports: forkModuleFrameExports,
                    backend: forkModuleBackend,
                  }
                : undefined,
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
        processForkUnwindTag(),
        (table, firstIndex, length) => {
          forkTables.markTableMutation(table, firstIndex, length);
        },
        processHostImportRuntime,
        pid,
        forkMemoryOwnership,
        initData.dylinkModuleModule,
      );
      processDlopenSupport = dlopenSupport;
      processTableReplication = createProcessTableReplicationOwner({
        generationAddress: tableGenerationAddress,
        tables: forkTables,
        tableCheckpoint: createForkPeerTableCheckpoint(
          () => requireForkModuleBackend(forkModuleBackend, pid),
          () => forkActivations,
          channelOffset,
          pid,
          `pid=${pid}: peer table checkpoint`,
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
        }
        // Each activation's identity, with no descriptor DECODED here. Both
        // codecs are module-owned formats; the host locates their sections and
        // hands over the raw bytes, and the module decodes them on seed.
        const declarations = [...modules]
          .sort(([left], [right]) => left - right)
          .map(([activationId]) => ({ activationId }));
        // Phase 6 item 3c: capture each activation's raw KFGC section bytes and
        // the host-exception owner HERE, where the compiled `modules` (and their
        // custom sections) are in scope, so the later instantiation/attach block
        // can seed the co-resident fork-module's drive planner. The
        // host-exception owner is the smallest activation that declared an
        // exception codec descriptor — the JS `directOwner` for a host exnref —
        // or 0xffff_ffff (the JS `null`) if none did.
        const gcCodecBytes = new Map<number, Uint8Array>();
        for (const [activationId, activationModule] of modules) {
          const sections = WebAssembly.Module.customSections(
            activationModule,
            WPK_FORK_GC_CODEC_SECTION,
          );
          if (sections.length !== 1) {
            throw new Error(
              `pid=${pid}: activation ${activationId} has ${sections.length} ` +
                "GC codec sections; expected exactly one",
            );
          }
          gcCodecBytes.set(activationId, new Uint8Array(sections[0]!));
        }
        childGcCodecBytes = gcCodecBytes;
        // Capture each activation's RAW exception codec section for the module's
        // exnref tag-validity admission gate. The module derives the declared tag
        // ordinals from the section itself -- decoding it here to hand over a
        // `u32` array made this host a second decoder of a module-owned format.
        const exceptionCodecBytes = new Map<number, Uint8Array>();
        for (const [activationId, activationModule] of modules) {
          const sections = WebAssembly.Module.customSections(
            activationModule,
            WPK_FORK_EXCEPTION_CODEC_SECTION,
          );
          if (sections.length === 1) {
            exceptionCodecBytes.set(activationId, new Uint8Array(sections[0]!));
          }
        }
        childExceptionCodecBytes = exceptionCodecBytes;
        // The host-exception owner is the smallest activation that DECLARED an
        // exception codec -- which is exactly the set that has a section, so it
        // falls out of the scan above rather than out of a decoded descriptor.
        childHostExceptionOwner =
          [...exceptionCodecBytes.keys()].sort((left, right) => left - right)[0]
            ?? 0xffff_ffff;
        // P2 (Path B): the co-resident module is the SOLE reconstructor whenever
        // it is active for this fork — there is no longer a per-kind host
        // admission gate, and no JS reconstruction fallback behind it. The former
        // all-or-nothing predicate iterated every graph node and, on a single
        // unadmitted node (e.g. an exnref whose activation lacked a matching
        // exception descriptor, or a struct/array whose layout the host could not
        // pre-validate), routed the WHOLE fork onto the JS reference engine. That
        // fallback is deleted: native proves the shared module admits and
        // reconstructs the entire reference kind set (null / funcref / externref /
        // i31 / exnref / struct / array / static-root; see
        // `fork-module/src/lib.rs` "the whole reference kind set the module
        // reconstructs"). The kind-set the module admits is NOT a fresh
        // engine-floor callback per kind; the module re-checks most kinds and
        // fails loud where IT can see the fault — GC layout validity in
        // `GcCodecHints::require_layout` (`EINVAL`) and externref
        // production-provenance in `fm_begin_reference_replay`. The exnref
        // tag-validity check the module ALSO now re-checks itself: the host seeds
        // each activation's declared exnref tag ordinals
        // (`fm_set_activation_exception_tags`), and the child-install entry
        // (`fm_attach_child`, COW and borrowed alike) fails loud with `EINVAL`
        // on an exnref recipe whose tag its owning activation never declared,
        // BEFORE the DRIVE_OP_EXN step materializes it — the fail-loud boundary
        // that formerly lived here as `assertForkModuleExnrefTagsDeclared`. The one
        // validity check that remains a module-internal gate over host-seeded
        // facts is the GC-descriptor layout gate (`GcCodecHints::require_layout`,
        // `EINVAL`). Whenever the module instantiated for this child it owns the
        // whole reference graph: wire decode (module-internal
        // `fork_codec::reference_segments`, seeded from the KFMS arena by
        // `fm_begin_reference_replay`), the full topological drive-order
        // (`fm_build_gc_plan` + `fm_drive_execute` over `drive_plan` Phase
        // 0/0b/3-5 — static-root publish, EVERY externref transit publish, then
        // typed allocate/fill/exn), and every `fm_ref_*` restore data feed. The
        // The host's own decode of this arena is GONE. It was last held for
        // the reconstruction wiring it fed; that wiring reads the module's
        // `fm_decoded_*` accessors now, over the graph the module decodes from
        // the same bytes. Multi-activation (dlopen) forks are covered
        // identically: the merged, activation-namespaced funcref and
        // static-root catalogs resolve each node against its owning activation.
        moduleReferenceKindsSupported =
          useForkModule && forkModuleInstance !== null;
        // Make the MODULE's decoded reference graph resident for the merged
        // static-root catalog mirror seeding below, which reads node kinds +
        // coordinates from the module's `fm_decoded_*` accessors instead of
        // walking the JS `decodeSegmentedForkReferenceTransaction` structure. The
        // resident graph survives the later attach (which seeds the replay
        // DRIVER, not this read-only graph).
        //
        // The exnref tag-validity ADMISSION gate that formerly walked this graph
        // here MOVED into the co-resident module (its child-install entry
        // `fm_attach_child` (COW and borrowed alike) re-checks every captured
        // exnref recipe against each activation's seeded exception tags before
        // building the reconstruction drive plan, and fails loud with `EINVAL` on
        // an undeclared tag — see `fm_set_activation_exception_tags` +
        // `assert_exnref_tags_admissible` in `crates/fork-module`). The host now
        // only SEEDS those tags (in the drive block below), so the fail-loud
        // boundary lives inside reconstruction rather than as a separate host
        // pre-walk.
        if (moduleReferenceKindsSupported && forkModuleBackend) {
          forkModuleBackend.decodeReferenceGraph(childArenaRoot);
        }
        // The child's pre-instantiation reference view. Every fact comes from
        // the graph the module just made resident; what the host adds is the
        // turn from coordinate to live reference, which is the identity floor.
        //
        // WHAT WENT WITH THE 1,619-LINE PROVIDER: its own wire decode of the
        // same arena, a scratch allocator, the GC transit staging, the
        // per-activation function/static-root/codec registration, and the
        // one-shot poisoning that existed to unwind all of it. This allocates
        // nothing, so a failure leaves nothing to release.
        earlyChildReferences = new ForkChildReferences(
          {
            decodedNodeKind: (index) =>
              requireForkModuleBackend(forkModuleBackend, pid)
                .decodedNodeKind(index),
            decodedNodeModuleActivation: (index) =>
              requireForkModuleBackend(forkModuleBackend, pid)
                .decodedNodeModuleActivation(index),
            funcrefOrdinal: (recipeId) =>
              forkModuleExport("fm_funcref_ordinal")(recipeId),
            externrefHandle: (recipeId) =>
              forkModuleExport("fm_externref_handle")(recipeId),
            staticRootSlot: (recipeId) =>
              forkModuleExport("fm_static_root_slot")(recipeId),
          },
          {
            functionCatalog: forkModuleInstance!.functionCatalog,
            staticRootCatalog: forkModuleInstance!.staticRootCatalog,
            resolveExternref: (handle) => externrefTokens.materialize(handle),
          },
          `pid=${pid}: early child references`,
        );
        importedStatePlanner = new ForkChildImports(
          requireForkModuleBackend(forkModuleBackend, pid),
          importedStateCapture,
          modules,
          childArenaRoot,
          earlyChildReferences,
          `pid=${pid}: child imported activation state`,
        );
        const archivedOrder = [
          0,
          ...childDylinkState.flatMap(({ activationId }) =>
            activationId === undefined ? [] : [activationId],
          ),
        ];
        const plannedOrder = importedStatePlanner.instantiationOrder();
        if (
          archivedOrder.length !== plannedOrder.length ||
          archivedOrder.some(
            (activationId, index) => activationId !== plannedOrder[index],
          )
        ) {
          throw new Error(
            `pid=${pid}: inherited activation import dependencies require order ` +
              `${plannedOrder.join(",")}, but the replay archive provides ` +
              archivedOrder.join(","),
          );
        }
      }
      if (!forkModuleInstance) {
        throw new Error(
          `pid=${pid}: fork-instrumented process has no co-resident module; ` +
            "there is no JavaScript continuation to fall back to",
        );
      }
      const forkEnvImports: Record<string, WebAssembly.ImportValue> = {
        // Everything the module serves plus the host floor, with the three
        // object imports a JS host genuinely supplies. Anything neither side
        // provides fails HERE by name instead of as a LinkError naming a type.
        ...(buildForkGuestImports({
          moduleExports: forkModuleInstance.exports as Record<string, unknown>,
          floor: forkHostFloor,
          extras: {
            // `continuationImports` contributes only the host-owned
            // `__wpk_fork_resume_table` funcref table the module's
            // `resume_peek` indexes.
            [FORK_GUEST_RESUME_TABLE_IMPORT]:
              resumeTable.table as unknown as WebAssembly.ImportValue,
            [FORK_GUEST_ACTIVATION_GLOBAL_IMPORT]: new WebAssembly.Global(
              { value: "i32", mutable: false },
              0,
            ),
            [FORK_GUEST_TABLE_GENERATION_ADDR_IMPORT]:
              tableReplicationImports.generationAddress,
          },
          guestModule: module,
          label: `pid=${pid}: fork imports`,
        }) as Record<string, WebAssembly.ImportValue>),
        // Phase 6 D5 IMPORT FLIP: the guest calls the co-resident module's
        // frame/resume exports directly (wasm->wasm over shared memory); the
        // module is the ONLY frame/journal implementation. Guest ABI names and
        // signatures are unchanged; no guest re-instrumentation.
        ...(useForkModule && forkModuleInstance
          ? {
              // MODULE-MODE PARTIAL-CAPTURE ABORT: the module reserve returns 0
              // (no throw, no JS callback) when a mid-unwind frame allocation
              // fails. The guest's reserve==0 contract then branches into its
              // abort restart loop EXPECTING the host to have already moved to
              // abort replay (fork-instrument `__wpk_fork_select_unwind_frame`).
              // Wrap the raw module export so that, exactly like the JS
              // `onReservationAbort` above, a 0 result synchronously drives the
              // module-mode partial-capture abort — reading the module errno
              // FIRST (before any further module call overwrites it) so the
              // guest's re-entry into `kernel_fork` finds the coordinator in
              // `abort-replay` and `fork()` returns `-errno` with the parent
              // intact. A successful reserve is byte-identical to the raw export.
              __wpk_fork_frame_reserve: (size: number | bigint) => {
                const payload = (
                  forkModuleInstance.exports
                    .__wpk_fork_frame_reserve as (s: number | bigint) => number | bigint
                )(size);
                if (payload === 0 || payload === 0n) {
                  const moduleErrno = forkModuleBackend
                    ? forkModuleBackend.lastErrno()
                    : STARTUP_ENOMEM;
                  // Mid-unwind reserve failure: seal the partial capture
                  // WITHOUT driving the guest's unwind-end (it is still
                  // mid-unwind), then replay the frames that did commit as an
                  // abort so the parent survives and fork() returns -errno.
                  forkAbortErrno =
                    moduleErrno > 0 ? moduleErrno : STARTUP_ENOMEM;
                  forkModule().parentAbortSeal();
                  forkModule().parentReplay(true);
                }
                return payload;
              },
            }
          : {}),
        // Phase 6 item 3a REFERENCE DATA-FEED FLIP: replace the seven JS RESTORE
        // data-feed imports (supplied by `buildForkGuestImports` above) with
        // the module exports for an
        // admitted graph. Placed AFTER those builders so these keys win. Flag-off
        // / non-admitted forks get `{}` and keep the JS reference path.
      };
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
        processForkUnwindTag(),
        (timedOutPtr, vmInterruptPtr, seconds) => {
          port.postMessage({
            type: "vm_interrupt_timer",
            pid,
            timedOutPtr,
            vmInterruptPtr,
            seconds,
          } satisfies WorkerToHostMessage);
        },
        forkEnvImports,
      );
      const routedImportObject = processHostImportRuntime.routeImportObject(
        programBytes,
        importObject,
      );
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
        importedStateCapture.prepareActivation(
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
        earlyChildReferences = null;
        importedStatePlanner?.clear();
        throw error;
      }
      processInstance = instance;
      forkActivations.register({
        activationId: 0,
        module,
        instance,
        fixedPrefixSize: linkedFrameFormat.fixedPrefixSize,
        templateId: mainTemplateId,
      });
      mainImportedStatePreparation?.complete(instance);
      resumeTable.registerActivation(
        0,
        forkResumeTargetsFromInstance(module, instance),
      );
      importedStatePlanner?.registerInstance(0, instance);
      if (!initData.isForkChild) {
        try {
          // Registration harvests static roots before bootstrap consumes the
          // converted active segments, and installs the dirty-table owner
          // before the original start can mutate a table.
          forkActivations.bootstrap(0);
        } catch (error) {
          processTableReplication.abortActiveMutations();
          resumeTable.unregisterActivation(0);
          throw error;
        }
      }
      if (!initData.isForkChild) {
        setupChannelBase(
          instance,
          module,
          memory,
          channelOffset,
          programBytes as ArrayBuffer,
          ptrWidth,
        );
      } else {
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
        if (childArenaRoot === 0) {
          throw new Error(
            `pid=${pid}: fork child lost its inherited module-state arena`,
          );
        }
        if (!importedStatePlanner || !earlyChildReferences) {
          throw new Error(
            `pid=${pid}: fork child lost its pre-instantiation reference plan`,
          );
        }
        // WHAT USED TO BE HERE: `bindTableDirtyTrackers`, joining the child's
        // per-activation table journals so aliases of one physical table shared
        // a tracker. It is not ported, because both halves of it have moved.
        // The dirty-page journal is the module's
        // (`__wpk_fork_module_state_table_dirty_*`), and deciding WHICH
        // coordinate of an aliased table writes sparse state is exactly what
        // `ForkTableStateOwners` does -- by comparing table object identity,
        // the part of it that genuinely cannot leave the host. See census 157.
        // WHAT `adoptEarlyReferences` DID: hand the early view's materialized
        // roots to the replay transaction, so the two did not resolve the same
        // recipe to different objects. `fm_attach_child` seeds the driver from
        // the arena itself now, and the early view retains nothing to hand
        // over -- it resolves each coordinate through the module and keeps no
        // table of its own.
        if (moduleReferenceKindsSupported && forkModuleInstance) {
          // The merged funcref catalog was filled as each activation registered
          // (see `mirrorFunctionCatalog`), parent and child alike, so nothing
          // mirrors here any more.
          //
          // Ascending by id, from the host's own record rather than the
          // registry: every loop below needs the same order the module drives
          // activations in, and the record already answers in it.
          const sortedActivations = forkActivations.ordered();
          // Phase 6 item 3b/3c: bind each activation's guest
          // `_gc_allocate`/`_gc_fill`/`_exception_materialize` exports into the
          // module's imported drive table at
          // `fm_drive_table_base(act) + {ALLOC, FILL, EXN}`, so the injected
          // `fm_drive_execute` shim can `call_indirect` them. The module could not
          // import the guest exports directly — it is instantiated BEFORE the
          // guests to supply the frame-flip imports. The absolute slot numbers
          // match the ones the Rust drive PLAN encodes (`fork_codec::drive_plan`).
          //
          // Item 3c makes this LIVE: the module now drives the typed
          // allocate/fill/exn topological order (`fm_build_gc_plan` +
          // `fm_drive_execute`) in place of the JS `materializeAllTyped` sub-loop
          // for a flag-on qualifying child. A flag-off fork skips this entirely.
          // The module-backed reference replay path always carries a backend (it
          // was set up alongside `forkModuleInstance` and `enableModuleReferenceReplay`
          // below drives through it). Assert it so the seed calls are well-typed
          // and a missing backend fails loudly rather than silently skipping the
          // drive seed.
          if (!forkModuleBackend) {
            throw new Error(
              `pid=${pid}: fork-module reference replay requires a backend`,
            );
          }
          // Bind every activation's guest exports into the module's drive
          // table so `fm_drive_execute` can `call_indirect` them. The module is
          // instantiated BEFORE the guests -- it supplies their frame-flip
          // imports -- so it cannot import them directly; the host's whole job
          // here is to put them somewhere the module can reach.
          //
          // This was two loops binding five of the thirteen slots between them,
          // and that is why the JS host could drive typed reconstruction and
          // nothing else: the unwind/rewind/abort quartet the entire fork
          // lifecycle runs on was never bound at all. An unbound slot is a
          // `call_indirect` on null, not a missing feature, so the gap could
          // only ever have surfaced as a trap. The binding table now lives
          // beside the module wrapper, covers the full stride, and is pinned
          // slot by slot against `fork_codec::drive_plan` by
          // `host/test/fork-module-backend.test.ts` -- including a test that no
          // slot in the stride is left unbound.
          // Phase 6 item 3c: seed the module's typed-GC drive planner from the
          // raw KFGC section bytes captured in the pre-instantiation planning
          // block (`childGcCodecBytes`). Each activation's codec supplies the
          // per-recipe layout facts (constructor deps, defaultable shells, the i31
          // owner) `fm_build_gc_plan` needs to reproduce the JS drive-order. Seeded
          // here — once per worker — so the coordinator's per-fork drive seam only
          // builds + executes the plan. Re-seeding an activation would fail
          // `EINVAL`, and this worker seeds each exactly once.
          if (!childGcCodecBytes) {
            throw new Error(
              `pid=${pid}: fork-module drive lost the captured GC codec bytes`,
            );
          }
          for (const activation of sortedActivations) {
            const bytes = childGcCodecBytes.get(activation.activationId);
            if (!bytes) {
              throw new Error(
                `pid=${pid}: fork-module drive seed lost activation ` +
                  `${activation.activationId}'s GC codec bytes`,
              );
            }
            forkModuleBackend.setActivationGcCodec(
              activation.activationId,
              bytes,
            );
          }
          // The host-exception owner (the JS `directOwner` for a host exnref) was
          // captured alongside the codec bytes: the smallest activation that
          // declared an exception codec descriptor, or 0xffff_ffff if none.
          forkModuleBackend.setHostExceptionOwner(childHostExceptionOwner);
          // Seed each activation's declared exnref tag ordinals so the module's
          // child-install entry can re-check every captured exnref recipe against
          // them (the exnref tag-validity admission gate, moved out of the host).
          // A recipe naming an undeclared tag then fails loud (`EINVAL`) from
          // inside `fm_attach_child` BEFORE the DRIVE_OP_EXN step materializes it.
          // Seeded here — once per worker — alongside the GC codec; a COW child
          // re-seed is an idempotent no-op in the module. An activation that
          // declares no exnref tags is not seeded (nothing to declare).
          if (!childExceptionCodecBytes) {
            throw new Error(
              `pid=${pid}: fork-module drive lost the captured exception codecs`,
            );
          }
          for (const activation of sortedActivations) {
            const bytes = childExceptionCodecBytes.get(activation.activationId);
            if (bytes !== undefined) {
              forkModuleBackend.setActivationExceptionCodec(
                activation.activationId,
                bytes,
              );
            }
          }
          // Static-root binder: populate the merged anyref catalog mirror the
          // module's injected `fm_drive_execute` reads on a DRIVE_OP_STATIC_ROOT
          // step. The child's static roots were harvested + registered during
          // activation registration (above), so `decodeStaticRoot` derefs the live
          // child root here; publishing it into the transit stays in wasm (the
          // binder), replacing the JS `publishTransit` for static roots. Only the
          // REFERENCED ordinals are pinned into the mirror, so an unreferenced
          // (and possibly collected) root is never derefed. Each static-root-
          // bearing activation gets a contiguous slice `[base, base + width)`
          // (`width` = its max referenced ordinal + 1); the module's
          // `fm_static_root_slot` returns `base(activation) + ordinal`. A single
          // static-root activation seeds NO base (module defaults base 0),
          // byte-identical to the raw-ordinal mapping. The mirror is cleared right
          // after the attach drives the plan so it never pins a child root past
          // replay.
          // `moduleReferenceKindsSupported` (this block's guard) is only true on
          // the module path, where the exnref gate above already made the module's
          // decoded reference graph resident. Read the static-root nodes from the
          // module's `fm_decoded_*` accessors (node index == canonical node id)
          // instead of walking the JS `decodeSegmentedForkReferenceTransaction`
          // structure. The resident graph survived the intervening guest
          // instantiation + attach (which seed the replay DRIVER, not this
          // read-only graph). WireNodeKind.StaticRoot (`fork-reference-recipes.ts`)
          // is 7 — the same discriminant the JS `entry.node.kind === "static-root"`
          // filter selected.
          const WIRE_NODE_KIND_STATIC_ROOT = 7;
          const decodedNodeCount = forkModuleBackend.decodedNodeCount();
          const staticRootNodes: { activation: number; ordinal: number }[] = [];
          for (let index = 0; index < decodedNodeCount; index += 1) {
            if (
              forkModuleBackend.decodedNodeKind(index) !==
              WIRE_NODE_KIND_STATIC_ROOT
            ) {
              continue;
            }
            staticRootNodes.push({
              activation: forkModuleBackend.decodedNodeModuleActivation(index),
              ordinal: forkModuleBackend.decodedNodeOrdinal(index),
            });
          }
          if (staticRootNodes.length > 0) {
            const mirror = forkModuleInstance.staticRootCatalog;
            const maxOrdinalByActivation = new Map<number, number>();
            for (const entry of staticRootNodes) {
              maxOrdinalByActivation.set(
                entry.activation,
                Math.max(
                  maxOrdinalByActivation.get(entry.activation) ?? 0,
                  entry.ordinal,
                ),
              );
            }
            const staticRootActivations = [
              ...maxOrdinalByActivation.keys(),
            ].sort((left, right) => left - right);
            const staticRootBase = new Map<number, number>();
            let staticRootWidth = 0;
            for (const activation of staticRootActivations) {
              staticRootBase.set(activation, staticRootWidth);
              staticRootWidth += maxOrdinalByActivation.get(activation)! + 1;
            }
            if (mirror.length < staticRootWidth) {
              mirror.grow(staticRootWidth - mirror.length, null);
            }
            for (const entry of staticRootNodes) {
              mirror.set(
                staticRootBase.get(entry.activation)! + entry.ordinal,
                forkStaticRoots.get(entry.activation)?.get(entry.ordinal) ?? null,
              );
            }
            // Seed bases only for a multi-activation static-root fork; a single
            // static-root activation keeps the empty base map (module base 0).
            if (staticRootActivations.length > 1) {
              for (const activation of staticRootActivations) {
                forkModuleBackend.setActivationStaticRootBase(
                  activation,
                  staticRootBase.get(activation)!,
                );
              }
            }
          }
        }
        // ONE install call for both child shapes. A COW child and a vfork
        // BORROWED child share an identical plan in the module; the only
        // borrowed-specific work is the host-side child-private replay-prefix
        // reservation, which is raw memory placement carrying no reference
        // values and never entered the module.
        //
        // This is the first production caller `fm_attach_child` has ever had.
        // It went unwired long enough that census section 128 went looking for
        // why and found a child's `record_find` answering from a writer root
        // that is always 0, so every lookup missed silently.
        // `ModuleStateWriter::adopt` closes that; whether it was the ONLY thing
        // missing is what running this will say.
        earlyChildReferences = null;
        exceptionBroker.invalidate();
        // Seed the child's module state BEFORE attaching. Without it the module
        // has no state at all, so every `record_find` the guest's restore makes
        // answers 0 and the guest traps reading a page header from address 0.
        // The coordinator did this; deleting it took the call with no caller
        // left to notice. Census 183.
        //
        // Activation 0's root is the launch anchor this child already read. Each
        // side activation contributes only its `fixedPrefix`; its continuation
        // root is a per-fork address the parent recorded in the arena, which the
        // module reads back itself.
        const installPlan = forkModule().installChild(
          childArenaRoot,
          inheritedLaunchRoot,
          pid,
          forkActivations.sides(),
          borrowedWorkspace,
        );
        forkModule().driveRestoredPlan(installPlan);
        // Static-root binder: the attach synchronously drove the plan, so the
        // static roots are now rooted in the anyref transit (and the child
        // instance holds them as immutable roots). Null the merged catalog mirror
        // so it never extends a child root's lifetime past replay — the same
        // no-leak contract the harvest-table clear and `finishReplay` transit
        // clear keep for the JS path.
        if (moduleReferenceKindsSupported && forkModuleInstance) {
          const mirror = forkModuleInstance.staticRootCatalog;
          for (let slot = 0; slot < mirror.length; slot += 1) {
            mirror.set(slot, null);
          }
        }
        importedStatePlanner.clear();
        importedStatePlanner = null;
        forkResult = 0;

        // Child attach restores __tls_base/__stack_pointer for every
        // activation before any continuation frame can execute.
        setupChannelBase(
          instance,
          module,
          memory,
          channelOffset,
          programBytes as ArrayBuffer,
          ptrWidth,
        );
      }

      // Signal ready
      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      // Run with wpk_fork_* instrumentation
      let exitCode = 0;
      try {
        const start = instance.exports._start as () => void;
        const resumeStart = instance.exports.wpk_fork_resume_start as
          (() => void) | undefined;
        if (typeof resumeStart !== "function") {
          throw new Error(
            `pid=${pid}: fork-capable program is missing wpk_fork_resume_start`,
          );
        }

        // Choose entry: normal _start, or — for a fork-from-non-main-thread
        // child — call the parent thread's thread function directly. _start
        // is not in the thread's fork-path call chain, so rewinding through
        // it would never reach the saved fork() call site. The thread
        // function's instrumented body sees state==REWINDING on entry and
        // replays the saved frames back to fork().
        let lexicalEntry: () => void;
        let replayEntry: () => void;
        if (initData.isForkChild && initData.forkChildThreadFnPtr != null) {
          const fnIdx = initData.forkChildThreadFnPtr;
          const childArgPtr = initData.forkChildThreadArgPtr ?? 0;
          const threadArg = ptrWidth === 8 ? BigInt(childArgPtr) : childArgPtr;
          const resumeThread = instance.exports.wpk_fork_resume_thread as
            | ((tableIndex: number, arg: number | bigint) => number | bigint)
            | undefined;
          if (typeof resumeThread !== "function") {
            throw new Error(
              "Fork-from-thread child: missing wpk_fork_resume_thread",
            );
          }
          // A fork child never executes the lexical pthread entry. Keep the
          // two closures structurally complete so the loop can select solely
          // from coordinator phase below.
          lexicalEntry = () => {
            throw new Error(
              "Fork-from-thread child entered lexical thread path",
            );
          };
          replayEntry = () => {
            resumeThread(fnIdx, threadArg);
          };
        } else {
          lexicalEntry = start;
          replayEntry = resumeStart;
        }

        for (;;) {
          let transportedForkUnwind = false;
          try {
            const phaseBeforeEntry = forkPhase(forkModuleFrameExports, pid);
            const entry =
              phaseBeforeEntry === "idle" ? lexicalEntry : replayEntry;
            entry();
          } catch (e) {
            if (isForkUnwindException(e, processForkUnwindTag())) {
              transportedForkUnwind = true;
            } else if (isWasmUnreachableTrap(e)) {
              if (kernelExitStatus !== null) {
                exitCode = kernelExitStatus;
                break; // Normal exit via kernel_exit -> unreachable trap
              }
              throw e;
            } else {
              throw e;
            }
          }

          const phase = forkPhase(forkModuleFrameExports, pid);
          if (transportedForkUnwind && phase !== "capture") {
            throw new Error(
              `pid=${pid}: private fork-unwind exception escaped while ` +
                `process continuation is ${phase}`,
            );
          }
          if (phase === "capture") {
            try {
              // The module seals its own capture now. What the coordinator did
              // around this call has all moved or evaporated: it bound
              // `wpk_fork_unwind_end` per activation, which `bindActivationDrive`
              // does for the whole stride; it wrote the JournalImage record from
              // the returned (ptr, len), which the module writes itself; and it
              // called `arena.seal()`, which a module-built arena does not need
              // -- `chunk_with_room` sets SEALED on every chunk and ROOT on the
              // first, so the arena is born in the state a child's attach
              // demands. The returned image location is no longer the host's to
              // carry anywhere.
              forkModule().sealCaptureAndSerialize();
              // The parent's own graph is now the one that answers an exnref
              // recipe's owner during the replay below. Cheap: it only marks
              // the broker's cached decode stale, so a fork that throws no
              // exception decodes nothing.
              exceptionBroker.invalidate();
            } catch (sealError) {
              // SEAL-TIME TRUTHFUL FAILURE (Phase 2 carry / Phase 4): the unwind
              // completed but the module could not channel-mmap the
              // child-inheritable journal image. The coordinator sealed to
              // `sealed-parent` WITHOUT launching a child; replay the parent's
              // already-committed frames and return `-errno` (parent intact, no
              // child). This is the seal-time sibling of the mid-unwind
              // `beginModuleCaptureAbort` reserve==0 path, so NO module failure
              // site traps once the JS continuation fallback is gone.
              if (sealError instanceof ContinuationAllocationError) {
                const errno =
                  sealError.errno > 0 ? sealError.errno : STARTUP_ENOMEM;
                forkResult = -errno;
                forkAbortErrno = errno;
                forkModule().parentReplay(true);
                if (forkModuleBackend && !initData.isForkChild) {
                  port.postMessage({
                    type: "fork_module_frames",
                    pid,
                    frames: Number(forkModuleBackend.stat("framesCommitted")),
                  } satisfies WorkerToHostMessage);
                }
                continue;
              }
              throw sealError;
            }
            // GATED REFERENCE KIND: a capture-side record-stub in
            // the reference transaction marked this fork as carrying a
            // reference kind the platform cannot faithfully reconstruct in a
            // fresh child (e.g. a live externref or typed Wasm-GC value). Abort
            // the fork cleanly with EOPNOTSUPP instead of launching a child:
            // the guest's `kernel_fork` re-enters in `abort-replay` and returns
            // `-EOPNOTSUPP`. This reaches the exact post-abort handling the
            // `childPid < 0` branch below uses; it never throws (a throw cannot
            // unwind an errno through the Wasm fork save walk) and never
            // silently succeeds.
            const unsupportedKind: string | null = null;
            if (unsupportedKind !== null) {
              // Make the platform boundary VISIBLE to a developer (Platform
              // Values: truthful failure over silent illusion). Marker-gated:
              // this fires ONLY when a capture-side record-stub marked an
              // unsupported reference kind, never on a supported (funcref /
              // exnref / simple) fork. One concise line per aborted fork.
              console.warn(
                `[worker] pid=${pid}: fork aborted with EOPNOTSUPP — carried a ` +
                  `live '${unsupportedKind}' reference across the fork boundary, ` +
                  `which the platform cannot reconstruct in a fresh child yet. ` +
                  `No child was spawned; the parent continues. ` +
                  `See docs/fork-reference-support.md.`,
              );
              forkResult = -FORK_REFERENCE_EOPNOTSUPP;
              forkAbortErrno = FORK_REFERENCE_EOPNOTSUPP;
              forkModule().parentReplay(true);
              // Path B P4 proof-of-use: when the co-resident module is enabled,
              // `beginAbortReplay` above routed through the module's OWN abort
              // path (`beginModuleAbortReplay` -> `fm_begin_abort`), replaying
              // the parent's committed frames rather than the JS engine that P6
              // deletes. Emit the committed-frame count INLINE here — symmetric
              // with the success branch's inline emission below — so the proof
              // is deterministic for a gated parent that spawns no child and
              // may exit immediately (its worker-tail emission can race the
              // `kernel_exit` teardown). A silent JS-only abort (no module
              // backend) constructs no backend and emits nothing.
              if (forkModuleBackend && !initData.isForkChild) {
                port.postMessage({
                  type: "fork_module_frames",
                  pid,
                  frames: Number(forkModuleBackend.stat("framesCommitted")),
                } satisfies WorkerToHostMessage);
              }
              continue;
            }
            // Hand the kernel worker the externref handles this capture
            // interned, so it does not have to decode this parked worker's
            // arena to re-derive them. Written AFTER the seal (the set is
            // complete) and BEFORE the syscall (the kernel reads it while
            // handling the fork). See `fork-externref-process-owner`.
            if (forkModuleBackend) {
              const captured = forkModuleBackend.capturedExternrefHandles();
              const staged = captured.length === 0
                ? 0
                : forkModuleBackend.stageExternrefHandover(captured);
              writeCapturedExternrefHandover(
                memory,
                channelOffset - FORK_SAVE_BUFFER_SIZE,
                staged,
                captured.length,
              );
            }
            const borrowedReplay = Number(forkMode) === PROCESS_FORK_MODE_VFORK
              ? forkModule().borrowedReplayWorkspace()
              : undefined;
            const childPid = sendForkSyscall(
              memory,
              channelOffset,
              forkMode,
              borrowedReplay,
            );
            forkResult = childPid;
            if (childPid < 0) {
              forkAbortErrno = -childPid;
              forkModule().parentReplay(true);
            } else {
              forkModule().parentReplay(false);
              // Phase 6 D5/D7a.1a proof-of-use, emitted from the PARENT's active
              // run loop (not the worker tail). A fork parent stays alive and its
              // channel is drained normally, so this reaches the host reliably
              // even in main-thread hosts where the fork parent's worker tail is
              // torn down before it runs (the tail-scoped `fork_module_frames`
              // below is the worker-thread-host mirror). A nonzero committed
              // count here proves the module drove THIS fork's unwind; a silent
              // JS fallback (`useForkModule === false`) never constructs the
              // backend and emits nothing.
              if (forkModuleBackend && !initData.isForkChild) {
                port.postMessage({
                  type: "fork_module_frames",
                  pid,
                  frames: Number(forkModuleBackend.stat("framesCommitted")),
                } satisfies WorkerToHostMessage);
              }
            }
            continue;
          }
          if (phase !== "idle") {
            throw new Error(
              `pid=${pid}: process entry returned while continuation is ${phase}`,
            );
          }

          // Normal return — program finished
          if (kernelExitStatus === null) {
            kernelImports.kernel_exit(0);
            exitCode = kernelExitStatus ?? 0;
          }
          break;
        }
      } catch (e) {
        processTableReplication.abortActiveMutations();
        releaseProcessForkArchiveReader();
        if (isWasmUnreachableTrap(e) && kernelExitStatus !== null) {
          exitCode = kernelExitStatus;
        } else {
          // Same shape as the capture-path guard above: both halves ask the module.
          if (forkPhase(forkModuleFrameExports, pid) !== "idle") {
            try {
              forkModule().abort();
            } catch {
              // Preserve the execution failure; abort already made its
              // transaction state unreachable before attempting deallocation.
            }
          }
          throw e;
        }
      }

      // Phase 6 D5 proof-of-use: a parent worker that ran a qualifying fork
      // through the co-resident module reports how many frames the module
      // committed. Only the parent commits (a replay-only child never does), so
      // scope this to the non-child worker. A silent JS fallback would leave
      // the counter at zero and fail the flag-on proof test.
      if (forkModuleBackend && !initData.isForkChild) {
        port.postMessage({
          type: "fork_module_frames",
          pid,
          frames: Number(forkModuleBackend.stat("framesCommitted")),
        } satisfies WorkerToHostMessage);
      }

      // Phase 6 D6.5 proof-of-use: a fresh fork CHILD whose carried references
      // were reconstructed through the co-resident module reports the count. The
      // reference decode runs in the CHILD (the flipped
      // `__wpk_fork_ref_decode_funcref` / `fm_begin_reference_replay`), so —
      // unlike the parent-committed frame count above — scope this to the child
      // worker. Emitted ONLY when the module actually reconstructed a reference
      // (count > 0): a reference-free fork (the common case, e.g. `d_01`) leaves
      // the counter at zero and must stay silent, so it does not add a second
      // `fork-module` diagnostic that could race a consumer waiting for the
      // parent's frame count. A nonzero value is the positive proof the module
      // drove the reconstruction rather than the JS reference fallback.
      if (forkModuleBackend && initData.isForkChild) {
        // Per-kind proof-of-use (Phase 6 D6.5): report each reference kind the
        // module reconstructed — funcref/null, externref, exnref, and typed-GC.
        // A graph can mix kinds (an exnref whose payload is an externref advances
        // both), so all four ride one message. Emitted ONLY when at least one is
        // positive: a reference-free fork (the common case, e.g. `d_01`) leaves
        // every counter at zero and must stay silent, so it does not add a second
        // `fork-module` diagnostic that could race a consumer waiting for the
        // parent's frame count. A nonzero value is the positive proof the module
        // drove that kind's reconstruction rather than the JS reference fallback.
        const references = Number(forkModuleBackend.stat("referencesReconstructed"));
        const externrefs = Number(forkModuleBackend.stat("externrefsResolved"));
        const exnrefs = Number(forkModuleBackend.stat("exnrefsReconstructed"));
        const gcNodes = Number(forkModuleBackend.stat("gcNodesReconstructed"));
        // Phase 6 item 3c DRIVE proof-of-use: the module executed the typed-GC
        // drive plan (`fm_drive_execute`) rather than falling back to the JS
        // `materializeAllTyped` order. Distinct from `gcNodes`, which advances
        // merely by admitting the graph.
        const driveSteps = Number(forkModuleBackend.stat("driveStepsExecuted"));
        // Static-root binder proof-of-use: the module republished an immutable
        // static root into the anyref transit (`fm_static_root_slot`) rather than
        // the JS `publishTransit` fallback.
        const staticRoots = Number(forkModuleBackend.stat("staticRootsPublished"));
        if (
          references > 0 ||
          externrefs > 0 ||
          exnrefs > 0 ||
          gcNodes > 0 ||
          driveSteps > 0 ||
          staticRoots > 0
        ) {
          port.postMessage({
            type: "fork_module_references",
            pid,
            references,
            externrefs,
            exnrefs,
            gcNodes,
            driveSteps,
            staticRoots,
          } satisfies WorkerToHostMessage);
        }
        // Phase 6 D7b replay-side proof-of-use: a fork CHILD (crucially a
        // fork-from-thread child, which carries no references) drives its rewind
        // through the module's flipped `__wpk_fork_frame_next`, but never commits
        // a frame — so `framesCommitted()` is 0 on a child and the parent-scoped
        // `fork_module_frames` above cannot prove the child ran through the
        // module. Report the module's REPLAYED frame count instead. A nonzero
        // value is the positive proof the child rewound through the module rather
        // than the JS fallback; a reference-free non-thread child that fell back
        // would leave this at 0 and stay silent.
        const replayed = Number(forkModuleBackend.stat("framesReplayed"));
        if (replayed > 0) {
          port.postMessage({
            type: "fork_module_child_frames",
            pid,
            frames: replayed,
          } satisfies WorkerToHostMessage);
        }
      }

      forkModule().abort();
      resumeTable.clear();
      releaseProcessForkArchiveReader();
      externrefTokens.clear();
      processHostImportRuntime.clear();
      port.postMessage({
        type: "exit",
        pid,
        status: exitCode,
      } satisfies WorkerToHostMessage);
    } else {
      // No fork instrumentation: fork cannot be represented safely because
      // the child cannot resume at the fork call site. Fail loudly if the
      // program reaches kernel_fork instead of silently degrading.
      kernelImports.kernel_fork = (_mode: number): number => {
        throw new Error(
          `pid=${pid}: kernel_fork reached without complete wasm-fork-instrument ` +
            "exports. Rebuild the program with scripts/run-wasm-fork-instrument.sh.",
        );
      };

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
        if (kernelExitStatus !== null) {
          exitCode = kernelExitStatus;
        }
      } catch (e) {
        if (isWasmUnreachableTrap(e)) {
          if (kernelExitStatus !== null) {
            exitCode = kernelExitStatus;
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
      if (kernelExitStatus === null) {
        kernelImports.kernel_exit(exitCode);
        exitCode = kernelExitStatus ?? exitCode;
      }

      port.postMessage({
        type: "exit",
        pid,
        status: exitCode,
      } satisfies WorkerToHostMessage);
    }
  } catch (err) {
    processHostImportRuntime?.clear();
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
 * Send SYS_FORK through the channel and wait for the result.
 * Returns child pid on success, or -errno on failure.
 */
function sendForkSyscall(
  memory: WebAssembly.Memory,
  channelOffset: number,
  mode: ProcessForkMode,
  borrowedReplay?: ForkBorrowedReplayWorkspace,
): number {
  const view = new DataView(memory.buffer);
  view.setInt32(
    channelOffset + CH_SYSCALL,
    processForkSyscall(mode),
    true,
  );
  for (let i = 0; i < 6; i++) {
    view.setBigInt64(channelOffset + CH_ARGS + i * CH_ARG_SIZE, 0n, true);
  }
  if (mode === PROCESS_FORK_MODE_VFORK) {
    if (!borrowedReplay) {
      throw new Error("vfork capture is missing borrowed replay workspace");
    }
    view.setBigInt64(
      channelOffset + CH_ARGS,
      BigInt(borrowedReplay.prefixBytes),
      true,
    );
    view.setBigInt64(
      channelOffset + CH_ARGS + CH_ARG_SIZE,
      BigInt(borrowedReplay.scratchBytes),
      true,
    );
  }

  markDeferredSignalDelivery(view, channelOffset);
  const i32 = new Int32Array(memory.buffer);
  Atomics.store(i32, (channelOffset + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
  Atomics.notify(i32, (channelOffset + CH_STATUS) / 4, 1);
  while (
    Atomics.wait(
      i32,
      (channelOffset + CH_STATUS) / 4,
      CHANNEL_STATUS_PENDING,
    ) === "ok"
  ) {
    /* */
  }

  const result = Number(view.getBigInt64(channelOffset + CH_RETURN, true));
  const err = view.getUint32(channelOffset + CH_ERRNO, true);
  clearDeferredSignalDelivery(view, channelOffset);
  Atomics.store(i32, (channelOffset + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

  if (err) return -err;
  return result;
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
      const [funcCount, funcCountBytes] = readLEB128(src, pos);
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
 * Build the JS argument list for calling a wasm pthread entry function through
 * the indirect function table.
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
    ctidPtr,
  } = initData;
  const tlsOffset = initData.tlsOffset ?? initData.tlsAllocAddr;
  const ptrWidth = initData.ptrWidth ?? 4;

  // WHY: synchronize the received memory before this isolate binds any view
  // or Wasm instance to a possibly stale fixed-length view of its backing.
  synchronizeReceivedSharedWasmMemory(memory, ptrWidth);

  let threadInstance: WebAssembly.Instance | undefined;
  // Visible to the worker-tail teardown, which runs outside the block the
  // registry is built in.
  let threadTableReplication: ProcessTableReplicationOwner | null = null;
  let threadHostImportRuntime: ForkHostImportWorkerRuntime | null = null;
  let threadExternrefTokens: ForkExternrefTokenCache | null = null;
  let processDlopenLock: Int32Array | undefined;
  let processDlopenOwner: Int32Array | undefined;
  let pthreadForkLockHeld = false;
  const acquirePthreadForkLock = (): boolean => {
    if (!processDlopenLock || !processDlopenOwner) {
      throw new Error(
        `pid=${pid} tid=${tid}: missing process dlopen ownership`,
      );
    }
    if (pthreadForkLockHeld) {
      throw new Error(`pid=${pid} tid=${tid}: pthread fork lock already held`);
    }
    for (;;) {
      const transactionOwner = Atomics.load(processDlopenOwner, 0);
      if (transactionOwner !== DLOPEN_OWNER_IDLE && transactionOwner !== tid) {
        Atomics.wait(processDlopenOwner, 0, transactionOwner);
        continue;
      }
      const owner = Atomics.load(processDlopenLock, 0);
      if (owner < DLOPEN_LOCK_IDLE) {
        // dlopen is finite and publishes the archive generation before
        // releasing this writer token. Waiting preserves ordinary pthread
        // fork/dlopen semantics instead of exposing a scheduler race as
        // ENOTSUP.
        Atomics.wait(processDlopenLock, 0, owner);
        continue;
      }
      if (owner >= DLOPEN_LOCK_MAX_READERS) {
        throw new Error(
          `pid=${pid} tid=${tid}: process dlopen lock reader overflow`,
        );
      }
      if (
        Atomics.compareExchange(processDlopenLock, 0, owner, owner + 1) ===
        owner
      ) {
        pthreadForkLockHeld = true;
        return true;
      }
    }
  };
  const releasePthreadForkLock = (): void => {
    if (!pthreadForkLockHeld || !processDlopenLock) return;
    for (;;) {
      const owner = Atomics.load(processDlopenLock, 0);
      if (owner <= DLOPEN_LOCK_IDLE) {
        pthreadForkLockHeld = false;
        throw new Error(
          `pid=${pid} tid=${tid}: pthread fork lost reader ownership ` +
            `(state=${owner})`,
        );
      }
      if (
        Atomics.compareExchange(processDlopenLock, 0, owner, owner - 1) ===
        owner
      ) {
        pthreadForkLockHeld = false;
        if (owner === 1) Atomics.notify(processDlopenLock, 0);
        return;
      }
    }
  };

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
    if (hasForkInstrumentation) {
      if (
        initData.forkHostImports === undefined ||
        initData.externrefGenerationId === undefined
      ) {
        throw new Error(
          `pid=${pid} tid=${tid}: ABI ${ABI_VERSION} fork artifact requires its process ` +
            "owner host-import mailbox and externref generation",
        );
      }
      threadExternrefTokens = new ForkExternrefTokenCache(
        initData.externrefGenerationId,
      );
      threadHostImportRuntime = new ForkHostImportWorkerRuntime(
        initData.forkHostImports,
        pid,
        initData.externrefGenerationId,
        threadExternrefTokens,
        (wake) => {
          port.postMessage({
            type: "fork_host_import",
            wake,
          } satisfies WorkerToHostMessage);
        },
      );
    }
    const threadForkCapabilityClaim = readForkInstrumentCapabilityClaim(module);
    const hasDylinkForkRole = forkInstrumentRoleAvailable(
      threadForkCapabilityClaim,
      FORK_CAP_DYLINK_MAIN,
    );
    let forkBufAddr = 0;
    const forkAnchorAddr = channelOffset - FORK_BUF_SIZE;
    const threadTemplateId = hasForkInstrumentation
      ? computeForkModuleTemplateId(initData.programBytes)
      : null;
    // The host thread arena is gone for the reason the process one is: the
    // module maps the KFMS chunks and frees them, so nothing here allocates or
    // releases a chunk it never owned.
    const threadForkTables = new ForkTables(
      {
        markTablePages: (ownerId, firstPage, pageCount) =>
          (
            threadForkModuleInstance!.exports
              .__wpk_fork_module_state_table_dirty_mark as (
                owner: number,
                first: bigint,
                count: bigint,
              ) => void
          )(ownerId, firstPage, pageCount),
      },
      `pid=${pid} tid=${tid}: fork tables`,
    );
    const threadActivationRegistry = hasForkInstrumentation;
    // One election per physical table for this replica, shared by the imported
    // identity capture and by the activation record's table registration -- two
    // separate owner sets would let two coordinates both believe they own one
    // table's sparse state.
    const threadTableStateOwners = new ForkTableStateOwners(
      (activationId, ownerId, owns) =>
        requireForkModuleBackend(threadForkModuleBackend, pid)
          .setActivationTableStateOwner(activationId, ownerId, owns),
    );
    let threadImportedStateCapture: ForkImportIdentity | null = null;
    let threadForkActivations: ForkActivations | null = null;
    let threadCaptureModule: ForkReferenceCaptureModule | null = null;
    const threadResumeTable = new ForkResumeTable(
      `pid=${pid} tid=${tid}: fork resume table`,
    );
    // The frame format is read where the fork-module is built, which is a
    // narrower block than the registration below.
    let threadFixedPrefixSize = 0;
    // Keyed on fork instrumentation rather than on the activation registry:
    // that was always the real predicate (the registry is built from the same
    // flag), and the broker no longer reads the registry for anything.
    const threadExceptionBroker = hasForkInstrumentation
      ? new ForkExceptionBroker(
          () => requireForkModuleBackend(threadForkModuleBackend, pid),
          () => {
            if (!threadForkActivations) {
              throw new Error(
                `pid=${pid} tid=${tid}: exception broker ran before this ` +
                  `thread registered any activation`,
              );
            }
            return threadForkActivations;
          },
          // A pthread worker never installs a fork child, so its module's own
          // arena is the only one it can be asked about.
          () =>
            requireForkModuleBackend(
              threadForkModuleBackend,
              pid,
            ).moduleStateArenaRoot(),
          `pid=${pid} tid=${tid}: exception broker`,
        )
      : null;
    // The fork-from-thread launch anchor, as two plain functions. They were
    // options on `prepareActivation`, whose other argument -- the continuation
    // whose entry points the module drives -- has no reader left.
    const publishThreadLaunchRoot = (address: number): void => {
      writeForkContinuationAnchor(memory, forkAnchorAddr, ptrWidth, address);
      forkBufAddr = address;
    };
    // Phase 6 D7b: wire the co-resident fork-module into the PTHREAD PARENT
    // worker so a fork issued FROM a thread unwinds/serializes/parent-replays
    // through the module — the parent SIDE of a fork-from-thread. Without this
    // the parent would journal through the JS closures while the child (admitted
    // above on the main worker path) expects to read the MODULE-serialized KFRE
    // journal image from the frame arena; the two sides must move together. This
    // mirrors the main process worker's instantiate + backend + enableModuleBacking
    // block (width match + catalog fits the cap). The co-resident module is now
    // the UNCONDITIONAL fork engine (no JS reference fallback), so a pthread
    // parent MUST capture through it — including one in a dlopen-capable program
    // (`hasDylinkForkRole`): the pthread parent only unwinds + serializes, and
    // the multi-activation RECONSTRUCTION runs in the fresh child on the main
    // worker path. (The earlier `!hasDylinkForkRole` single-activation gate would
    // now leave a dlopen pthread with no capture module and hang its fork.) The
    // pthread parent never reconstructs references (that happens in the child),
    // so `resolve_externref` is wired (below, for identity parity) but expected
    // to stay idle here. (The `wpk_fork_host.*` seam this comment used to
    // describe was deleted, H3, 2026-09-06 — the module no longer declares those
    // imports at all.) Phase 3: a catalog past the (raised) module cap now FAILS
    // LOUD here — the cap is a module-BSS structure that holds every real guest's
    // catalog, so an overflow is a genuine module-capacity boundary, never a
    // silent drop to the (Phase 4: to-be-deleted) JS continuation twin.
    let threadForkModuleInstance: ForkModuleInstance | null = null;
    // The MODULE owns the unwind tag and exports it; a host that mints its own
    // leaves that export dead and makes the two disagree the moment the module
    // throws one. Read from the module below, exactly as the process path has
    // since `forkUnwindTagFrom` landed.
    let threadModuleUnwindTag: WebAssembly.Tag | undefined;
    let threadForkModuleBackend: ForkModuleContinuationBackend | null = null;
    if (hasForkInstrumentation && threadActivationRegistry) {
      const forkModuleModule = initData.forkModuleModule;
      if (!forkModuleModule) {
        throw new Error(
          `pid=${pid} tid=${tid}: fork-instrumented worker requires the ` +
            "co-resident fork module",
        );
      }
      const linkedFrameFormat = readLinkedFrameFormat(module);
      if (ptrWidth !== linkedFrameFormat.ptrWidth) {
        throw new Error(
          `pid=${pid} tid=${tid}: fork-module width mismatch: process ptrWidth ` +
            `${ptrWidth} vs linked frames ${linkedFrameFormat.ptrWidth}`,
        );
      }
      const catalogOrdinals = readForkResumeCatalog(module).map(
        (entry) => entry.functionOrdinal,
      );
      if (catalogOrdinals.length > FORK_MODULE_RESUME_CATALOG_CAP) {
        throw new Error(
          `pid=${pid} tid=${tid}: resume catalog of ${catalogOrdinals.length} ` +
            `exceeds the fork-module cap ${FORK_MODULE_RESUME_CATALOG_CAP}`,
        );
      }
      {
        // M2: wire the same `resolve_externref` body as the process/parent
        // path (using this pthread's own externref token cache, established
        // above alongside `threadHostImportRuntime`). The pthread-parent
        // module never actually reconstructs references (that happens on the
        // fork CHILD side, in the process worker's module instance) — it only
        // drives the frame/KFRE journal — so this seam is expected to stay
        // idle here, but it is wired for real rather than left on the
        // fail-loud default so identity stays consistent if that ever
        // changes.
        threadForkModuleInstance = instantiateForkModule({
          module: forkModuleModule,
          memory,
          ptrWidth,
          reserve: (size) =>
            continuationMmap(
              memory,
              channelOffset,
              size,
              `pid=${pid} tid=${tid}: fork-module`,
            ),
          label: `pid=${pid} tid=${tid}: fork-module`,
          // The registry itself, so reference identity is derived alongside
          // the resolver instead of being left a trapping stub.
          tokens: threadExternrefTokens!,
        });
        // STORE #2: on this path the thread registry is created BEFORE the
        // fork-module (unlike the process path), and its `enableModuleBacking`
        // gate below requires `threadActivationRegistry` — itself built from
        // the registry — to already exist, so the registry cannot simply be
        // constructed after the module. Instead, ADOPT the module's own
        // exported transit table into the already-built registry so the
        // guest's `__wpk_fork_ref_gc_transit` import (bound later by
        // `buildForkGuestImports`, well below) and the module's
        // drive integrity check read the exact same table. This happens
        // before any activation import is built and before any fork capture.
        // The registry used to adopt this table so its capture session and the
        // module read the same one. There is one reader now -- the module owns
        // the transit table and exports it -- so adopting it into a second
        // owner is the mirroring census 157 removed.
        // Stage into the dedicated slab inside this thread's fork-module region
        // rather than a growing channel mmap (see the process-worker path for
        // the full rationale): keeps the staging from permanently growing the
        // shared process memory a fork-from-thread child would clone.
        const threadForkModuleStagingBase = threadForkModuleInstance.stagingBase;
        const threadForkModuleStagingBytes =
          threadForkModuleInstance.stagingBytes;
        threadForkModuleBackend = new ForkModuleContinuationBackend({
          instance: threadForkModuleInstance,
          memory,
          ptrWidth,
          format: linkedFrameFormat,
          catalogOrdinals,
          channelBase: channelOffset,
          label: `pid=${pid} tid=${tid}: fork-module`,
        });
        threadForkModuleBackend.setup();
        threadModuleUnwindTag = forkUnwindTagFrom(
          threadForkModuleInstance.exports,
          `pid=${pid} tid=${tid} unwind`,
        );
        // Built here rather than beside the registry above, because it publishes
        // straight into this thread's module and there is no module before this
        // point. Nothing reads it earlier.
        if (threadActivationRegistry) {
          const backend = threadForkModuleBackend;
          // A pthread replica runs its OWN fork-module instance, so it needs
          // its own merged catalog and its own bases -- and, like every other
          // worker, its own activation record.
          threadForkActivations = new ForkActivations(
            backend,
            `pid=${pid} tid=${tid}: fork activations`,
            forkActivationCatalogSink({
              tables: threadForkTables,
              merged: new ForkMergedFunctionCatalog(
                threadForkModuleInstance.functionCatalog,
                backend,
                `pid=${pid} tid=${tid}: merged function catalog`,
              ),
              staticRoots: new Map(),
              owners: threadTableStateOwners,
            }),
          );
          threadFixedPrefixSize = linkedFrameFormat.fixedPrefixSize;
          threadImportedStateCapture = new ForkImportIdentity(
            backend,
            `pid=${pid} tid=${tid}: imported activation state`,
            threadTableStateOwners,
          );
        }
        // Path-A A4 parity: route this pthread worker's peer-table CAPTURE
        // through the co-resident module (the process path does this at
        // `setCaptureModule` above). Peer-table replication is module-only now,
        // so a pthread that publishes a full table checkpoint needs the capture
        // module just as the process parent does.
        threadCaptureModule = new ForkReferenceCaptureModule(
          threadForkModuleInstance.exports,
          memory,
          `pid=${pid} tid=${tid}: fork reference capture module`,
        );
      }
    }
    const processArchiveHeadOffset =
      ptrWidth === 8 ? DLOPEN_HEAD_OFFSET_WASM64 : DLOPEN_HEAD_OFFSET_WASM32;
    const processArchiveHeadAddr =
      processChannelOffset - FORK_BUF_SIZE - processArchiveHeadOffset;
    const processArchiveLockOffset =
      ptrWidth === 8 ? DLOPEN_LOCK_OFFSET_WASM64 : DLOPEN_LOCK_OFFSET_WASM32;
    const processArchiveLockAddr =
      processChannelOffset - FORK_BUF_SIZE - processArchiveLockOffset;
    const processArchiveOwnerOffset =
      ptrWidth === 8 ? DLOPEN_OWNER_OFFSET_WASM64 : DLOPEN_OWNER_OFFSET_WASM32;
    const processArchiveOwnerAddr =
      processChannelOffset - FORK_BUF_SIZE - processArchiveOwnerOffset;
    if (
      !Number.isSafeInteger(processArchiveHeadAddr) ||
      processArchiveHeadAddr <= 0 ||
      processArchiveHeadAddr + ptrWidth > memory.buffer.byteLength ||
      !Number.isSafeInteger(processArchiveLockAddr) ||
      processArchiveLockAddr <= 0 ||
      processArchiveLockAddr + 4 > memory.buffer.byteLength ||
      !Number.isSafeInteger(processArchiveOwnerAddr) ||
      processArchiveOwnerAddr <= 0 ||
      processArchiveOwnerAddr + 4 > memory.buffer.byteLength
    ) {
      throw new Error(
        `pid=${pid} tid=${tid}: invalid process dlopen archive anchor ` +
          `${String(processArchiveHeadAddr)}`,
      );
    }
    processDlopenLock = new Int32Array(
      memory.buffer,
      processArchiveLockAddr,
      1,
    );
    processDlopenOwner = new Int32Array(
      memory.buffer,
      processArchiveOwnerAddr,
      1,
    );
    const processArchiveControlAddr = processChannelOffset - FORK_BUF_SIZE;
    const processGenerationOffset =
      ptrWidth === 8
        ? DLOPEN_GENERATION_OFFSET_WASM64
        : DLOPEN_GENERATION_OFFSET_WASM32;
    const processGenerationAddress =
      processArchiveControlAddr - processGenerationOffset;
    const threadTableReplicationImports: ForkActivationTableReplication = {
      generationAddress: new WebAssembly.Global(
        { value: "i64", mutable: false },
        BigInt(processGenerationAddress),
      ),
      reconcile: (): bigint => threadTableReplication?.reconcile() ?? 0n,
      beginMutation: (): bigint =>
        threadTableReplication?.beginMutation() ?? 0n,
      commit: (activationId, ownerId, firstIndex, length): void => {
        threadTableReplication?.commit(
          activationId,
          ownerId,
          firstIndex,
          length,
        );
      },
      abort: (): void => {
        threadTableReplication?.abort();
      },
    };
    let forkResult = 0;
    // What a fork-from-thread abort will report. The coordinator used to hold
    // this next to its phase mirror; the module holds a phase and nothing else,
    // so the errno rides here, exactly as the process path carries it.
    let threadForkAbortErrno = 0;
    // Resolved per call rather than captured: the backend is built later, in the
    // block that instantiates this thread's fork-module.
    const threadForkModule = () =>
      requireForkModuleBackend(threadForkModuleBackend, pid);
    let forkMode: ProcessForkMode = PROCESS_FORK_MODE_FORK;

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
    if (hasForkInstrumentation) {
      kernelImports.kernel_fork = (rawMode: number): number => {
        if (!threadInstance || !threadActivationRegistry) return -38; // ENOSYS
        const mode = processForkMode(rawMode);
        if (mode === null) return -STARTUP_EINVAL;

        const phase = forkPhase(threadForkModuleInstance?.exports ?? null, pid);
        if (phase === "parent-replay") {
          if (mode !== forkMode) {
            throw new Error(
              `pid=${pid} tid=${tid}: fork replay mode ${mode} does not ` +
                `match captured mode ${forkMode}`,
            );
          }
          try {
            threadForkModule().parentFinish(false);
          } finally {
            releasePthreadForkLock();
          }
          return forkResult;
        }
        if (phase === "abort-replay") {
          if (mode !== forkMode) {
            throw new Error(
              `pid=${pid} tid=${tid}: fork abort mode ${mode} does not ` +
                `match captured mode ${forkMode}`,
            );
          }
          const errno = threadForkAbortErrno;
          try {
            threadForkModule().parentFinish(true);
          } finally {
            releasePthreadForkLock();
          }
          return -errno;
        }
        if (phase !== "idle") {
          throw new Error(
            `pid=${pid} tid=${tid}: fork import reached while process ` +
              `continuation is ${phase}`,
          );
        }
        forkMode = mode;

        try {
          // Reconciliation may instantiate a missing side module and execute
          // its start function, so it requires writer ownership. Afterward,
          // acquire the long-lived fork reader and verify no publication won
          // the handoff race before capturing activation state.
          for (;;) {
            threadTableReplication?.reconcileNow();
            acquirePthreadForkLock();
            if (
              !threadTableReplication ||
              threadTableReplication.isCurrentUnderLock()
            ) {
              break;
            }
            releasePthreadForkLock();
          }
        } catch (error) {
          releasePthreadForkLock();
          throw error;
        }

        try {
          threadCaptureModule?.begin();
          publishThreadLaunchRoot(0);
          publishThreadLaunchRoot(
            threadForkModule().parentBeginCapture(
              channelOffset,
              0,
              threadForkActivations?.sides() ?? [],
            ),
          );
        } catch (error) {
          // The module owns this thread's arena too, and its abort releases it.
          if (forkPhase(threadForkModuleInstance?.exports ?? null, pid) !== "idle") {
            try {
              threadForkModule().abort();
            } catch {
              // Preserve the capture failure.
            }
          }
          releasePthreadForkLock();
          if (error instanceof ContinuationAllocationError) return -error.errno;
          throw error;
        }
        return 0;
      };
    } else {
      kernelImports.kernel_fork = (_mode: number): number => {
        throw new Error(
          `pid=${pid} tid=${tid}: kernel_fork reached without complete ` +
            "wasm-fork-instrument exports. Rebuild the program with " +
            "scripts/run-wasm-fork-instrument.sh.",
        );
      };
    }
    const threadLongjmpTag = createLongjmpTag(ptrWidth);
    const threadCppExceptionTag = createCppExceptionTag(ptrWidth);
    // This called a function that no longer exists, so a fork-instrumented
    // pthread worker failed at startup with a ReferenceError.
    const threadForkUnwindTag = (): WebAssembly.Tag =>
      requireForkUnwindTag(
        threadModuleUnwindTag,
        `pid=${pid} tid=${tid}: fork unwind`,
      );
    // The two import binders below take `threadModuleUnwindTag` RAW rather than
    // through the asserting accessor above, and that is the whole fix for an
    // uninstrumented pthread replica. The tag is the fork-module's export,
    // assigned only inside `hasForkInstrumentation`; the accessor is right
    // where a fork path needs it and wrong at the binders, which run for EVERY
    // replica -- so an uninstrumented one threw "missing valid process-owned
    // fork unwind tag" before its guest ran a single instruction. Both binders
    // bind `env.__wpk_fork_unwind` only when the guest DECLARES that import,
    // and an uninstrumented guest declares nothing of the kind. The process
    // worker had the same defect and the same fix.
    const replicaActivationOwner =
      hasDylinkForkRole &&
      threadActivationRegistry &&
      threadActivationRegistry &&
      threadExceptionBroker
        ? createProcessDylinkActivationOwner({
            memory,
            ptrWidth,
            channelOffset,
            forkUnwindTag: threadForkUnwindTag(),
            resumeTable: threadResumeTable,
            // A pthread replica gets its own floor over ITS token cache and
            // broker: externref identity is per-worker (the generation id
            // differs), so sharing the process floor here would key provenance
            // against tokens this worker never minted.
            forkHostFloor: createForkGuestHostFloor(
              {
                tryEncodeExternref: (value) =>
                  threadExternrefTokens?.encode(value) ?? undefined,
                exceptionThrower: () => threadExceptionBroker,
              },
              `pid=${pid} tid=${tid}: fork host floor`,
            ).floor,
            importedStateCapture: threadImportedStateCapture ?? undefined,
            activations: threadForkActivations ?? undefined,
            tableReplication: threadTableReplicationImports,
            isForkChild: false,
            isPthreadReplica: true,
            // A pthread replica instantiates its OWN co-resident fork-module
            // (`threadForkModuleInstance`, above), and its side activations need
            // the same frame/resume flip the main worker's do: the module is the
            // only frame/journal implementation on this path too, so an
            // activation without the flip has no continuation at all. Omitting
            // it here is what made a dlopen from a pthread fail with "side
            // activation N has no fork module" even though the module was
            // sitting right there.
            forkModuleFrameFlip: threadForkModuleBackend
              ? {
                  moduleExports: threadForkModuleInstance!.exports,
                  backend: threadForkModuleBackend,
                }
              : undefined,
            invokeProcessFork: () => {
              const fork = threadInstance?.exports.fork;
              if (typeof fork !== "function") {
                throw new Error(
                  `pid=${pid} tid=${tid}: dylink fork role is missing ` +
                    "the main libc fork export",
                );
              }
              return Number((fork as () => number)());
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
      threadModuleUnwindTag,
      (table, firstIndex, length) => {
        threadForkTables.markTableMutation(table, firstIndex, length);
      },
      threadHostImportRuntime ?? undefined,
      tid,
      "copied",
      initData.dylinkModuleModule,
    );
    if (threadActivationRegistry) {
      threadTableReplication = createProcessTableReplicationOwner({
        generationAddress: processGenerationAddress,
        tables: threadForkTables,
        tableCheckpoint: createForkPeerTableCheckpoint(
          () => requireForkModuleBackend(threadForkModuleBackend, pid),
          () => {
            if (!threadForkActivations) {
              throw new Error(
                `pid=${pid} tid=${tid}: peer table checkpoint ran before this ` +
                  `thread registered any activation`,
              );
            }
            return threadForkActivations;
          },
          channelOffset,
          pid,
          `pid=${pid} tid=${tid}: peer table checkpoint`,
        ),
        dlopen: threadDlopenSupport,
        materializeModules: () => {
          threadDlopenSupport.replayDlopens();
        },
        restoreSnapshots: true,
        label: `pid=${pid} tid=${tid}`,
      });
    }
    const threadForkEnvImports =
      threadActivationRegistry && threadExceptionBroker
        ? {
            // Everything the module serves plus this worker's floor, with the
            // three object imports a JS host supplies. Fails by NAME here if
            // anything is unbound, rather than as an opaque LinkError.
            ...(threadForkModuleInstance
              ? (buildForkGuestImports({
                  moduleExports: threadForkModuleInstance.exports as Record<
                    string,
                    unknown
                  >,
                  floor: createForkGuestHostFloor(
                    {
                      tryEncodeExternref: (value) =>
                        threadExternrefTokens?.encode(value) ?? undefined,
                      exceptionThrower: () => threadExceptionBroker,
                    },
                    `pid=${pid} tid=${tid}: fork host floor`,
                  ).floor,
                  extras: {
                    [FORK_GUEST_RESUME_TABLE_IMPORT]:
                      threadResumeTable.table as unknown as WebAssembly.ImportValue,
                    [FORK_GUEST_ACTIVATION_GLOBAL_IMPORT]:
                      new WebAssembly.Global(
                        { value: "i32", mutable: false },
                        0,
                      ),
                    [FORK_GUEST_TABLE_GENERATION_ADDR_IMPORT]:
                      threadTableReplicationImports.generationAddress,
                  },
                  guestModule: module,
                  label: `pid=${pid} tid=${tid}: fork imports`,
                }) as Record<string, WebAssembly.ImportValue>)
              : {
                  [FORK_GUEST_RESUME_TABLE_IMPORT]:
                    threadResumeTable.table as unknown as WebAssembly.ImportValue,
                }),
            // Phase 6 D7b IMPORT FLIP (mirrors the main worker path): when the
            // fork-module is wired into this pthread parent, the thread's guest
            // calls the module's frame/resume exports directly (wasm->wasm over
            // shared memory), replacing exactly the five per-frame JS closures.
            // The coordinator's module-backed capture then journals through the
            // module, and it serializes the KFRE image the fork-from-thread child
            // reads. Everything else stays JS. Guest ABI names/signatures are
            // unchanged; no re-instrumentation. Flag-off skips this entirely.
            ...(threadForkModuleInstance
              ? {
                  // MODULE-MODE PARTIAL-CAPTURE ABORT (mirrors the main worker
                  // path): a 0 result from the module reserve synchronously drives
                  // the module-mode partial-capture abort so the guest's reserve==0
                  // contract finds the thread coordinator already in `abort-replay`.
                  __wpk_fork_frame_reserve: (size: number | bigint) => {
                    const payload = (
                      threadForkModuleInstance!.exports
                        .__wpk_fork_frame_reserve as (
                        s: number | bigint,
                      ) => number | bigint
                    )(size);
                    if (payload === 0 || payload === 0n) {
                      const moduleErrno = threadForkModuleBackend
                        ? threadForkModuleBackend.lastErrno()
                        : STARTUP_ENOMEM;
                      threadForkAbortErrno =
                        moduleErrno > 0 ? moduleErrno : STARTUP_ENOMEM;
                      threadForkModule().parentAbortSeal();
                      threadForkModule().parentReplay(true);
                    }
                    return payload;
                  },
                }
              : {}),
          }
        : undefined;
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
      threadModuleUnwindTag,
      (timedOutPtr, vmInterruptPtr, seconds) => {
        port.postMessage({
          type: "vm_interrupt_timer",
          pid,
          timedOutPtr,
          vmInterruptPtr,
          seconds,
        } satisfies WorkerToHostMessage);
      },
      threadForkEnvImports,
    );
    const routedThreadImportObject = threadHostImportRuntime
      ? threadHostImportRuntime.routeImportObject(
          initData.programBytes,
          importObject,
        )
      : importObject;
    const threadMainImportedState =
      threadImportedStateCapture?.prepareActivation(
        0,
        module,
        routedThreadImportObject,
      );
    const threadInstanceImports = (threadMainImportedState?.imports ??
      routedThreadImportObject) as WebAssembly.Imports;
    const instance = new WebAssembly.Instance(module, threadInstanceImports);
    threadInstance = instance;
    threadMainImportedState?.complete(instance);
    if (
      hasForkInstrumentation &&
      threadActivationRegistry &&
      threadActivationRegistry &&
      threadTemplateId
    ) {
      const threadBootstrap = instance.exports
        .wpk_fork_module_thread_bootstrap as (() => void) | undefined;
      if (!threadBootstrap) {
        throw new Error(
          `pid=${pid} tid=${tid}: fork module is missing thread bootstrap`,
        );
      }
      threadResumeTable.registerActivation(
        0,
        forkResumeTargetsFromInstance(module, instance),
      );
      threadForkActivations?.register({
        activationId: 0,
        module,
        instance,
        fixedPrefixSize: threadFixedPrefixSize,
        templateId: threadTemplateId!,
      });
      try {
        // The pthread bootstrap consumes passive element segments, so static
        // root harvesting and table-dirty registration must precede it just as
        // they do for the process-main bootstrap.
        threadBootstrap();
      } catch (error) {
        threadTableReplication?.abortActiveMutations();
        threadResumeTable.unregisterActivation(0);
        threadForkActivations?.forget(0);
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

    const threadArg = ptrWidth === 8 ? BigInt(argPtr) : argPtr;
    const threadArgs = buildThreadEntryArgs(threadFn, argPtr, ptrWidth);
    const resumeThread = hasForkInstrumentation
      ? (instance.exports.wpk_fork_resume_thread as
          | ((tableIndex: number, arg: number | bigint) => number | bigint)
          | undefined)
      : undefined;
    if (hasForkInstrumentation && typeof resumeThread !== "function") {
      throw new Error(
        `pid=${pid} tid=${tid}: fork-capable program is missing ` +
          "wpk_fork_resume_thread",
      );
    }
    let result = 0;
    if (hasForkInstrumentation && threadActivationRegistry) {
      for (;;) {
        let transportedForkUnwind = false;
        try {
          const raw =
            forkPhase(threadForkModuleInstance?.exports ?? null, pid) === "idle"
              ? threadFn(...threadArgs)
              : resumeThread!(fnPtr, threadArg);
          result = Number(raw);
        } catch (e) {
          if (isForkUnwindException(e, threadForkUnwindTag())) {
            transportedForkUnwind = true;
          } else if (
            isWasmUnreachableTrap(e) && kernelThreadExitStatus !== null
          ) {
            result = kernelThreadExitStatus;
            break;
          } else {
            throw e;
          }
        }

        const phase = forkPhase(threadForkModuleInstance?.exports ?? null, pid);
        if (transportedForkUnwind && phase !== "capture") {
          throw new Error(
            `pid=${pid} tid=${tid}: private fork-unwind exception escaped ` +
              `while process continuation is ${phase}`,
          );
        }
        if (phase === "capture") {
          try {
            // The module seals its own capture, as the process path does: it
            // writes the JournalImage record from its own (ptr, len) and a
            // module-built arena needs no separate seal, because every chunk is
            // born SEALED and the first born ROOT.
            threadForkModule().sealCaptureAndSerialize();
            threadExceptionBroker?.invalidate();
          } catch (sealError) {
            // SEAL-TIME TRUTHFUL FAILURE (fork-from-thread mirror of the main
            // run loop): the unwind completed but the module could not
            // channel-mmap the child-inheritable journal image. The coordinator
            // sealed to `sealed-parent` without launching a child; replay the
            // parent's committed frames and return `-errno` (parent intact).
            if (sealError instanceof ContinuationAllocationError) {
              const errno =
                sealError.errno > 0 ? sealError.errno : STARTUP_ENOMEM;
              forkResult = -errno;
              threadForkAbortErrno = errno;
              threadForkModule().parentReplay(true);
              continue;
            }
            throw sealError;
          }
          // GATED REFERENCE KIND (fork-from-thread mirror of the main run
          // loop): abort cleanly with EOPNOTSUPP when a capture-side record-stub
          // marked an unsupported reference kind, instead of launching a child.
          // The guest fork() re-enters in `abort-replay` and returns
          // `-EOPNOTSUPP`.
          // The capture-side marker the registry latched. The module refuses an
          // unadmitted reference kind with `EOPNOTSUPP` at the call that meets
          // it, so the signal is the errno rather than a flag read afterwards.
          const unsupportedKind: string | null = null;
          if (unsupportedKind !== null) {
            // Make the platform boundary VISIBLE to a developer (Platform
            // Values: truthful failure over silent illusion). Marker-gated:
            // fires ONLY when a capture-side record-stub marked an unsupported
            // reference kind, never on a supported fork. One line per abort.
            console.warn(
              `[worker] pid=${pid} tid=${tid}: fork aborted with EOPNOTSUPP — ` +
                `carried a live '${unsupportedKind}' reference across the fork ` +
                `boundary, which the platform cannot reconstruct in a fresh ` +
                `child yet. No child was spawned; the parent continues. ` +
                `See docs/fork-reference-support.md.`,
            );
            forkResult = -FORK_REFERENCE_EOPNOTSUPP;
            threadForkAbortErrno = FORK_REFERENCE_EOPNOTSUPP;
            threadForkModule().parentReplay(true);
            continue;
          }
          const borrowedReplay = Number(forkMode) === PROCESS_FORK_MODE_VFORK
            ? threadForkModule().borrowedReplayWorkspace()
            : undefined;
          const childPid = sendForkSyscall(
            memory,
            channelOffset,
            forkMode,
            borrowedReplay,
          );
          forkResult = childPid;
          if (childPid < 0) {
            threadForkAbortErrno = -childPid;
            threadForkModule().parentReplay(true);
          } else {
            threadForkModule().parentReplay(false);
          }
          continue;
        }
        if (phase !== "idle") {
          throw new Error(
            `pid=${pid} tid=${tid}: pthread entry returned while process ` +
              `continuation is ${phase}`,
          );
        }
        break;
      }
    } else {
      try {
        const raw = threadFn(...threadArgs);
        result = Number(raw);
      } catch (e) {
        if (isWasmUnreachableTrap(e) && kernelThreadExitStatus !== null) {
          result = kernelThreadExitStatus;
        } else {
          throw e;
        }
      }
    }

    // Phase 6 D7b proof-of-use: a pthread PARENT worker that ran a fork through
    // the co-resident module reports how many frames the module committed during
    // its unwind. This is the PARENT side of a fork-from-thread; the child posts
    // its replay-side `fork_module_child_frames`. A silent JS fallback would
    // leave the counter at zero and fail the flag-on proof.
    if (threadForkModuleBackend) {
      port.postMessage({
        type: "fork_module_frames",
        pid,
        frames: Number(threadForkModuleBackend.stat("framesCommitted")),
      } satisfies WorkerToHostMessage);
    }

    // A well-formed replay releases its reader token from the inherited fork
    // import above. Keep normal-return cleanup defensive so an unexpected
    // execution exit cannot strand the process-wide writer lock.
    releasePthreadForkLock();
    threadExternrefTokens?.clear();
    threadHostImportRuntime?.clear();

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
    threadTableReplication?.abortActiveMutations();
    releasePthreadForkLock();
    // The registry's `clear()` released its capture transaction's roots here.
    // The module holds them now and reclaims them with its bump heap on the
    // next fork, so there is no host-side transaction left to unwind.
    threadExternrefTokens?.clear();
    threadHostImportRuntime?.clear();
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
