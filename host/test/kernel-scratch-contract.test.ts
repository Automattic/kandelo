import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOST_INTERCEPTED_SYSCALLS,
  POSIX_ARG_MAX_BYTES,
  POSIX_IOV_MAX,
  POSIX_PATH_MAX_BYTES,
  SELECT_FD_SET_BYTES,
  SELECT_FD_SETSIZE,
  SPAWN_ATTR_RESETIDS,
  SPAWN_ATTR_SETPGROUP,
  SPAWN_ATTR_SETSCHEDPARAM,
  SPAWN_ATTR_SETSCHEDULER,
  SPAWN_ATTR_SETSID,
  SPAWN_ATTR_SETSIGDEF,
  SPAWN_ATTR_SETSIGMASK,
  SPAWN_ATTR_USEVFORK,
  SPAWN_MAX_ACTION_COUNT,
  SPAWN_MAX_ARGV_COUNT,
  SPAWN_MAX_ENVP_COUNT,
  SPAWN_WIRE_ACTION_FD_OFFSET,
  SPAWN_WIRE_ACTION_MODE_OFFSET,
  SPAWN_WIRE_ACTION_NEWFD_OFFSET,
  SPAWN_WIRE_ACTION_OFLAG_OFFSET,
  SPAWN_WIRE_ACTION_OP_OFFSET,
  SPAWN_WIRE_ACTION_PATH_LEN_OFFSET,
  SPAWN_WIRE_ACTION_PATH_OFF_OFFSET,
  SPAWN_WIRE_ACTION_RECORD_BYTES,
  SPAWN_WIRE_HEADER_ACTION_COUNT_OFFSET,
  SPAWN_WIRE_HEADER_ARGC_OFFSET,
  SPAWN_WIRE_HEADER_ATTR_FLAGS_OFFSET,
  SPAWN_WIRE_HEADER_BYTES,
  SPAWN_WIRE_HEADER_ENVC_OFFSET,
  SPAWN_WIRE_HEADER_PAD_OFFSET,
  SPAWN_WIRE_HEADER_PGRP_OFFSET,
  SPAWN_WIRE_HEADER_SIGDEF_OFFSET,
  SPAWN_WIRE_HEADER_SIGMASK_OFFSET,
  SPAWN_WIRE_MAX_BYTES,
  SPAWN_WIRE_OP_CHDIR,
  SPAWN_WIRE_OP_CLOSE,
  SPAWN_WIRE_OP_DUP2,
  SPAWN_WIRE_OP_FCHDIR,
  SPAWN_WIRE_OP_OPEN,
  SPAWN_WIRE_STRING_OFFSET_BYTES,
} from "../src/generated/abi";
import {
  KERNEL_SCRATCH_EXPORT_NAMES,
  kernelScratchNullablePointerArguments,
  kernelScratchRequiredPointerArguments,
  type KernelScratchExportName,
} from "../src/kernel-scratch";
import {
  auditWasmMemoryWrites,
  formatAuditFailures,
  repositoryRuntimeSourceFiles,
  type AuditAllowance,
  type OwnershipSeed,
} from "./support/wasm-memory-write-audit";
import {
  auditKernelEntryContext,
  formatKernelEntryContextViolations,
} from "./support/kernel-entry-context-audit";
const platformLimitsHeader = readFileSync(
  new URL(
    "../../libc/musl-overlay/include/bits/kandelo_limits.h",
    import.meta.url,
  ),
  "utf8",
);
const publicLimitsHeader = readFileSync(
  new URL("../../libc/musl-overlay/include/limits.h", import.meta.url),
  "utf8",
);
const muslSelectHeader = readFileSync(
  new URL("../../libc/musl/include/sys/select.h", import.meta.url),
  "utf8",
);
const spawnContractHeader = readFileSync(
  new URL(
    "../../libc/musl-overlay/src/process/wasm32posix/spawn_contract.h",
    import.meta.url,
  ),
  "utf8",
);
const buildMuslSource = readFileSync(
  new URL("../../scripts/build-musl.sh", import.meta.url),
  "utf8",
);
const installOverlayHeadersSource = readFileSync(
  new URL("../../scripts/install-overlay-headers.sh", import.meta.url),
  "utf8",
);
const muslSpawnSource = readFileSync(
  new URL(
    "../../libc/musl-overlay/src/process/wasm32posix/posix_spawn.c",
    import.meta.url,
  ),
  "utf8",
);
const kernelSpawnSource = readFileSync(
  new URL("../../crates/kernel/src/spawn.rs", import.meta.url),
  "utf8",
);
const kernelWasmApiSource = readFileSync(
  new URL("../../crates/kernel/src/wasm_api.rs", import.meta.url),
  "utf8",
);
const legacySyscallImportsSource = readFileSync(
  new URL("../../libc/glue/syscall_imports.h", import.meta.url),
  "utf8",
);
const legacySyscallGlueSource = readFileSync(
  new URL("../../libc/glue/syscall_glue.c", import.meta.url),
  "utf8",
);
const abiSnapshotSource = readFileSync(
  new URL("../../abi/snapshot.json", import.meta.url),
  "utf8",
);
function kernelExportNamesFromSnapshot(source: string): Set<string> {
  const snapshot = JSON.parse(source) as unknown;
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    !("kernel_exports" in snapshot) ||
    !Array.isArray(snapshot.kernel_exports)
  ) {
    throw new Error("ABI snapshot kernel_exports must be an array");
  }
  const names = snapshot.kernel_exports.map((entry, index) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0
    ) {
      throw new Error(
        `ABI snapshot kernel_exports[${index}] has no exact name`,
      );
    }
    return entry.name;
  });
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) {
    throw new Error("ABI snapshot kernel_exports contains duplicate names");
  }
  return uniqueNames;
}
const abiKernelExportNames = kernelExportNamesFromSnapshot(abiSnapshotSource);
const hostKernelWorkerSource = readFileSync(
  new URL("../src/kernel-worker.ts", import.meta.url),
  "utf8",
);
const hostKernelSource = readFileSync(
  new URL("../src/kernel.ts", import.meta.url),
  "utf8",
);
const kernelScratchSource = readFileSync(
  new URL("../src/kernel-scratch.ts", import.meta.url),
  "utf8",
);
const kernelEntryGateSource = readFileSync(
  new URL("../src/kernel-entry-gate.ts", import.meta.url),
  "utf8",
);
const hostIndexSource = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

interface RustKernelExportParameter {
  readonly name: string;
  readonly type: string;
}

function rustKernelExportParameters(
  source: string,
  exportName: string,
): RustKernelExportParameter[] {
  const declaration = `pub extern "C" fn ${exportName}`;
  const declarationOffsets: number[] = [];
  let searchOffset = 0;
  while (searchOffset < source.length) {
    const candidateOffset = source.indexOf(declaration, searchOffset);
    if (candidateOffset < 0) break;
    const afterName = source[candidateOffset + declaration.length];
    if (afterName === "(" || /\s/.test(afterName)) {
      declarationOffsets.push(candidateOffset);
    }
    searchOffset = candidateOffset + declaration.length;
  }
  if (declarationOffsets.length === 0) {
    throw new Error(`missing Rust declaration for ${exportName}`);
  }
  if (declarationOffsets.length !== 1) {
    throw new Error(`duplicate Rust declaration for ${exportName}`);
  }
  const declarationOffset = declarationOffsets[0];
  const open = source.indexOf("(", declarationOffset + declaration.length);
  if (open < 0) throw new Error(`missing parameter list for ${exportName}`);

  let close = -1;
  let depth = 0;
  for (let offset = open; offset < source.length; offset++) {
    const char = source[offset];
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) {
      close = offset;
      break;
    }
  }
  if (close < 0)
    throw new Error(`unterminated parameter list for ${exportName}`);

  const parameters: string[] = [];
  let parameterStart = open + 1;
  let nested = 0;
  for (let offset = parameterStart; offset <= close; offset++) {
    const char = source[offset];
    if (char === "(" || char === "[" || char === "{" || char === "<") nested++;
    if (char === ")" || char === "]" || char === "}" || char === ">") nested--;
    if ((char === "," && nested === 0) || offset === close) {
      const parameter = source.slice(parameterStart, offset).trim();
      if (parameter) parameters.push(parameter);
      parameterStart = offset + 1;
    }
  }

  return parameters.map((parameter) => {
    const match = parameter.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/);
    if (!match) {
      throw new Error(
        `cannot parse ${exportName} Rust parameter ${JSON.stringify(parameter)}`,
      );
    }
    return { name: match[1], type: match[2].trim() };
  });
}

function rustKernelScratchPointerIndexes(
  source: string,
  exportName: KernelScratchExportName,
): number[] {
  const parameters = rustKernelExportParameters(source, exportName);
  const pointerIndexes: number[] = [];
  parameters.forEach((parameter, index) => {
    const rawPointer = /^\*(?:const|mut)\s+/.test(parameter.type);
    const namedPointer = parameter.name.endsWith("_ptr");
    if (rawPointer && !namedPointer) {
      throw new Error(
        `${exportName} raw pointer parameter ${parameter.name} must use ` +
          "the _ptr suffix consumed by this drift contract",
      );
    }
    if (!namedPointer) return;
    if (!rawPointer && parameter.type !== "usize") {
      throw new Error(
        `${exportName} pointer parameter ${parameter.name} has ` +
          `unsupported Rust type ${parameter.type}`,
      );
    }
    const capacity = parameters[index + 1];
    if (
      capacity === undefined ||
      !/(?:len|capacity)$/.test(capacity.name) ||
      (capacity.type !== "u32" && capacity.type !== "usize")
    ) {
      throw new Error(
        `${exportName} pointer parameter ${parameter.name} must be ` +
          "followed by an explicit u32/usize length or capacity",
      );
    }
    pointerIndexes.push(index);
  });
  return pointerIndexes;
}

function assertKernelScratchPointerRoleContract(
  source: string,
  exportName: KernelScratchExportName,
): void {
  const required = [...kernelScratchRequiredPointerArguments(exportName)];
  const nullable = [...kernelScratchNullablePointerArguments(exportName)];
  const hostPointerIndexes = [...required, ...nullable].sort(
    (left, right) => left - right,
  );
  if (new Set(hostPointerIndexes).size !== hostPointerIndexes.length) {
    throw new Error(`${exportName} host pointer roles are not unique`);
  }
  const rustPointerIndexes = rustKernelScratchPointerIndexes(
    source,
    exportName,
  );
  if (
    hostPointerIndexes.length !== rustPointerIndexes.length ||
    hostPointerIndexes.some(
      (pointerIndex, index) => pointerIndex !== rustPointerIndexes[index],
    )
  ) {
    throw new Error(
      `${exportName} Rust/host pointer-role drift: Rust has ` +
        `[${rustPointerIndexes.join(", ")}], host has ` +
        `[${hostPointerIndexes.join(", ")}]`,
    );
  }
}

const ownershipSeeds: OwnershipSeed[] = [
  {
    declaration: "host/src/kernel.ts::WasmPosixKernel.#memory",
    target: "value",
    owner: "kernel",
    form: "memory",
    why: "This private field is the kernel WebAssembly linear memory.",
  },
  {
    declaration: "host/src/kernel.ts::WasmPosixKernel.#instance",
    target: "value",
    owner: "kernel",
    form: "instance",
    why: "This private field is the instantiated kernel module whose exported memory aliases the kernel linear memory.",
  },
  {
    declaration: "host/src/kernel.ts::WasmPosixKernel.#createKernelMemory",
    target: "return",
    owner: "kernel",
    form: "memory",
    why: "This factory creates only the kernel WebAssembly linear memory.",
  },
  {
    declaration:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.#kernelMemory",
    target: "value",
    owner: "kernel",
    form: "memory",
    why: "This worker field aliases only the dedicated kernel memory.",
  },
  {
    declaration:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.#kernelInstance",
    target: "value",
    owner: "kernel",
    form: "instance",
    why: "This private field is the exact instantiated kernel module used by worker-side scratch consumers.",
  },
  {
    declaration:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.#scratchRegion",
    target: "value",
    owner: "kernel",
    form: "scratch-region",
    why: "This true-private slot may contain only the allocator-authenticated main kernel scratch region; the audit rejects every assignment that does not preserve that exact region provenance.",
  },
  {
    declaration:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.#tcpScratchRegion",
    target: "value",
    owner: "kernel",
    form: "scratch-region",
    why: "This true-private slot may contain only the allocator-authenticated TCP kernel scratch region; the audit rejects every assignment that does not preserve that exact region provenance.",
  },
  {
    declaration: "host/src/process-memory.ts::createProcessMemory",
    target: "return",
    owner: "process-memory",
    form: "memory",
    why: "This factory creates caller-owned process memory, not kernel scratch.",
  },
  {
    declaration:
      "host/src/node-kernel-worker-entry.ts::createSharedProcessMemory",
    target: "return",
    owner: "process-memory",
    form: "memory",
    why: "This Node factory creates a fork child's process memory.",
  },
  {
    declaration:
      "host/src/browser-kernel-worker-entry.ts::createSharedProcessMemory",
    target: "return",
    owner: "process-memory",
    form: "memory",
    why: "This browser factory creates a fork child's process memory.",
  },
  {
    declaration:
      "apps/browser-demos/pages/network/network-demo-worker.ts::createProcessMemory",
    target: "return",
    owner: "process-memory",
    form: "memory",
    why: "This diagnostic factory creates its guest process memory.",
  },
  {
    declaration: "host/src/kernel-worker.ts::ChannelInfo.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "A syscall channel is stored in its caller process memory.",
  },
  {
    declaration: "host/src/kernel-worker.ts::ProcessRegistration.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "A process registration carries that process's own memory.",
  },
  {
    declaration: "host/src/kernel-worker.ts::ThreadChannelAttachment.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "A thread attachment carries its owning process memory.",
  },
  {
    declaration:
      "host/src/kernel-worker.ts::PendingThreadChannelAttachment.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "A pending thread attachment carries process memory.",
  },
  {
    declaration: "host/src/node-kernel-worker-entry.ts::ProcessInfo.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "The Node process table stores guest process memory.",
  },
  {
    declaration: "host/src/browser-kernel-worker-entry.ts::ProcessInfo.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "The browser process table stores guest process memory.",
  },
  {
    declaration:
      "host/src/worker-protocol.ts::CentralizedWorkerInitMessage.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "This worker ingress carries the newly launched process's own linear memory, never kernel scratch.",
  },
  {
    declaration:
      "host/src/worker-protocol.ts::CentralizedThreadInitMessage.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "This thread ingress carries the owning process's shared linear memory, never kernel scratch.",
  },
  {
    declaration: "host/src/browser-kernel-protocol.ts::FbBindMessage.memory",
    target: "value",
    owner: "framebuffer",
    form: "memory",
    why: "This browser message carries a process framebuffer mapping for display binding, not kernel memory.",
  },
  {
    declaration:
      "host/src/browser-kernel-protocol.ts::FbRebindMemoryMessage.memory",
    target: "value",
    owner: "framebuffer",
    form: "memory",
    why: "This browser message replaces a framebuffer process-memory binding after growth, not kernel memory.",
  },
  {
    declaration: "host/src/wasi-shim.ts::WasiShim.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "The WASI shim operates on its guest process memory.",
  },
  {
    declaration:
      "host/src/fork-continuation.ts::LinkedForkContinuation.$param:memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "Fork continuation frames live in process memory.",
  },
  {
    declaration: "host/src/dylink.ts::LoadSharedLibraryOptions.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "Dynamic linking writes into the requesting process memory.",
  },
  {
    declaration:
      "host/src/thread-allocator.ts::ThreadPageAllocator.allocate.$param:memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "Thread control pages are allocations inside process memory.",
  },
  {
    declaration: "host/src/framebuffer/registry.ts::FbBinding.hostBuffer",
    target: "value",
    owner: "framebuffer",
    form: "view",
    why: "This view is host-owned framebuffer storage, not kernel memory.",
  },
  {
    declaration: "host/src/dri/registry.ts::InternalEntry.sab",
    target: "value",
    owner: "shared-memory",
    form: "buffer",
    why: "This shared buffer is canonical device storage outside kernel Wasm.",
  },
  {
    declaration: "host/src/kernel-worker.ts::AnonymousSharedMmapBacking.bytes",
    target: "value",
    owner: "shared-memory",
    form: "view",
    why: "This host view owns an anonymous shared mapping backing.",
  },
  {
    declaration: "host/src/kernel-worker.ts::SharedMmapMapping.snapshot",
    target: "value",
    owner: "shared-memory",
    form: "view",
    why: "This host snapshot is separate from allocator-owned scratch.",
  },
  {
    declaration: "host/src/kernel-worker.ts::SysvShmMapping.snapshot",
    target: "value",
    owner: "shared-memory",
    form: "view",
    why: "This host snapshot tracks a System V shared-memory mapping.",
  },
];

const reviewedScalarKernelExportCall = (
  key: string,
  count?: number,
): AuditAllowance => ({
  key,
  disposition: "kernel-control",
  ...(count === undefined ? {} : { count }),
  // WHY: the generated snapshot makes every kernel export fail closed. Each
  // exact occurrence below was reviewed to carry only control scalars or
  // caller-address-space values: it neither borrows host-staged kernel memory
  // nor authorizes a Rust scratch reservation. A second/new call remains a
  // violation unless it receives its own review.
  why: "This exact generated-export call carries no host-staged kernel-memory borrow or scratch-reservation authority.",
});

const reviewedScalarKernelExportCalls: AuditAllowance[] = [
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#attachThreadChannelWithinKernelEntry::kernel-export-direct-use::setMaxAddr(pid, this.toKernelPtr(tlsPageAddr))",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#bindKernelTid::kernel-export-direct-use::setTid(pid, tid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#captureBlockingRetryDisposition::kernel-export-direct-use::getTimeout( channel.pid, origArgs[0]!, timeoutDirection, )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#captureBlockingRetryDisposition::kernel-export-direct-use::isFdNonblock(channel.pid, fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#createTestAuthority::kernel-export-direct-use::forkProcess(parentPid, callerTid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#finalizeAddressSpaceForExecWithinKernelEntry::kernel-export-direct-use::detach(pid, mapping.segId)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.firePosixTimer::kernel-export-direct-use::fire(pid, timerId)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#getProcessExitSignal::kernel-export-direct-use::getExitSignal(pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#handleSyscallInner::kernel-export-direct-use::messageSizeForDescriptor( channel.pid, this.guestTidForChannel(channel), origArgs[0], )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#inheritPreparedSharedMappingsWithinKernelEntry::kernel-export-direct-use::kernelShmat!( prepared.childPid, mapping.segId, mapping.mapAddr, mapping.readOnly ? SHM_RDONLY : 0, )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#injectIncomingVirtualTcpConnection::kernel-export-direct-use::( this.#kernelInstanceForEntry(entry).exports.kernel_inject_connection as ( pid: number, listenerFd: number, a: number, b: number, c: number, d: number, port: number, ) => number )( target.pid, target.fd, remoteAddr[0], remoteAddr[1], remoteAddr[2], remoteAddr[3], remotePort, )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#kernelThreadHasDeliverable::kernel-export-direct-use::threadHasDeliverable(pid, tid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#killAllBlockedForTeardownWithinKernelEntry::kernel-export-direct-use::getExitStatus(registration.pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#notifyThreadExitWithinKernelEntry::kernel-export-direct-use::threadExit(pid, tid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#pickKernelSignalTargetTid::kernel-export-direct-use::pickSignalTarget(pid, signum)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#prepareExecFdMirrorPruneWithinKernelEntry::kernel-export-direct-use::fdIsOpen(pid, epfd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#prepareExecFdMirrorPruneWithinKernelEntry::kernel-export-direct-use::fdIsOpen(pid, interest.fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#prepareTcpListenerRegistration::kernel-export-direct-use::getAcceptWake?.(pid, fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#releaseBlockingRetrySnapshot::kernel-export-direct-use::release( channel.pid, this.guestTidForChannel(channel), snapshot.retryToken, )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#rememberBlockingRetrySnapshot::kernel-export-direct-use::tokenForRetry( channel.pid, this.guestTidForChannel(channel), snapshot.syscallNr, )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#removeFromKernelProcessTableWithinKernelEntry::kernel-export-direct-use::removeProcess(pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#replaceProcessMetadataWithinKernelEntry::kernel-export-direct-use::clear(pid, kind)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#reserveHostRegionAtWithinKernelEntry::kernel-export-direct-use::reserveHostRegionAtFn( pid, this.toKernelPtr(request.pointer), this.toKernelPtr(request.length), )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#reserveHostRegionWithinKernelEntry::kernel-export-direct-use::reserveHostRegionFn(pid, this.toKernelPtr(checkedLength))",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#resolveExecListenerFdWithinKernelEntry::kernel-export-direct-use::fdIsOpen(pid, oldFd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#resolveExecListenerFdWithinKernelEntry::kernel-export-direct-use::findListenerFd?.(pid, wakeIdx)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#resolveExecListenerFdWithinKernelEntry::kernel-export-direct-use::getAcceptWake(pid, fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#resolveExecListenerFdWithinKernelEntry::kernel-export-direct-use::getAcceptWake(pid, oldFd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#retireBlockingRetryCaptureAfterExitedProcess::kernel-export-direct-use::getState(channel.pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#rollbackInheritedSysvAttachmentsWithinKernelEntry::kernel-export-direct-use::kernelShmdt(childPid, segId)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#rollbackIpcShmatWithinKernelEntry::kernel-export-direct-use::kernelShmdt(channel.pid, shmid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#setBrkBaseWithinKernelEntry::kernel-export-direct-use::setBrkBaseFn(pid, this.toKernelPtr(addr))",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#setBrkLimitWithinKernelEntry::kernel-export-direct-use::setBrkLimitFn(pid, this.toKernelPtr(brkLimit))",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#setCredentialsWithinKernelEntry::kernel-export-direct-use::direct(pid, uid, gid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#setMaxAddrWithinKernelEntry::kernel-export-direct-use::setMaxAddrFn(pid, this.toKernelPtr(maxAddr))",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#setMmapBaseWithinKernelEntry::kernel-export-direct-use::setMmapBaseFn(pid, this.toKernelPtr(mmapBase))",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#setupPtyWithinKernelEntry::kernel-export-direct-use::kernelPtyCreate(pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#snapshotExecTcpListenerWakeIdsWithinKernelEntry::kernel-export-direct-use::getAcceptWake(pid, fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#snapshotExecTcpListenerWakeIdsWithinKernelEntry::kernel-export-direct-use::getAcceptWake(pid, target.fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.#startProcessWorkerWhenRunnableWithinKernelEntry::kernel-export-direct-use::getState(pid)",
    2,
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.consumeExitedChild::kernel-export-direct-use::reapChild(parentPid, childPid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.createProcess::kernel-export-direct-use::createProcess(stdinKind, stdoutKind, stderrKind)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.fdSupportsMmapWriteback::kernel-export-direct-use::supports(pid, fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.finalizeExitedProcessBeforeLifecycleNotification::kernel-export-direct-use::getState(pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.getForkCount::kernel-export-direct-use::fn(pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.getKernelMemoryPages::kernel-export-direct-use::fn()",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.getParentPid::kernel-export-direct-use::getParentPid(pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.getSpawnScratchCapacity::kernel-export-direct-use::fn()",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleBlockingRetry::kernel-export-direct-use::getAcceptWakeIdx?.(channel.pid, fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleBlockingRetry::kernel-export-direct-use::getFdPipeIdx?.(channel.pid, origArgs[0])",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleBlockingRetry::kernel-export-direct-use::getSendPipeIdx?.(channel.pid, origArgs[0])",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleExit::kernel-export-direct-use::commitProcessExit(exitStatus)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleExit::kernel-export-direct-use::getProcessState(channel.pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleFork::kernel-export-direct-use::clearForkChild(childPid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleFork::kernel-export-direct-use::kernelForkProcess(parentPid, callerTid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleIpcShmat::kernel-export-direct-use::kernelShmat( channel.pid, callerTid, shmid, // The kernel owns attachment accounting but not the process mapping // address; this legacy ABI slot is intentionally ignored by Rust. 0, flags, )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleIpcShmdt::kernel-export-direct-use::kernelShmdt( channel.pid, callerTid, mapping.segId, )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleSemctl::kernel-export-direct-use::arrayBytes( channel.pid, this.guestTidForChannel(channel), semid, rawCmd, )",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.handleSemctl::kernel-export-direct-use::statBytes(processPointerWidth)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.inheritHostFdMirrors::kernel-export-direct-use::fdIsOpen(childPid, entry.fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.inheritHostFdMirrors::kernel-export-direct-use::fdIsOpen(childPid, epfd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.inheritHostFdMirrors::kernel-export-direct-use::getAcceptWake?.(parentPid, parentTarget.fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.kernelExecPrepare::kernel-export-direct-use::prepare(pid, callerTid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.kernelExecSetup::kernel-export-direct-use::threadAware(pid, callerTid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.notifyParentOfChildStateTransition::kernel-export-direct-use::hasNoCldStop(parentPid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.notifyParentOfExitedProcess::kernel-export-direct-use::hasNoCldWait(parentPid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.registerProcess::kernel-export-direct-use::getProcessState?.(pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.releaseAllSysvShmMappingsForProcess::kernel-export-direct-use::kernelShmdt(pid, mapping.segId)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.resolveEpollReadinessIndices::kernel-export-direct-use::getAcceptWakeIdx(pid, interest.fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.resolveEpollReadinessIndices::kernel-export-direct-use::getRecvPipe(pid, interest.fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.resolveInheritedListenerFd::kernel-export-direct-use::findListenerFd?.(pid, wakeIdx)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.resolveInheritedListenerFd::kernel-export-direct-use::getAcceptWake(pid, fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.resolveInheritedListenerFd::kernel-export-direct-use::getAcceptWake(pid, preferredFd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.resolvePollReadinessIndices::kernel-export-direct-use::getAcceptWakeIdx(pid, fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.resolvePollReadinessIndices::kernel-export-direct-use::getRecvPipe(pid, fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.resumeStoppedProcess::kernel-export-direct-use::getState(pid)",
    6,
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel-worker.ts::CentralizedKernelWorker.validateKernelTid::kernel-export-direct-use::validateTask(pid, tid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.audioChannels::kernel-export-direct-use::fn()",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.audioPending::kernel-export-direct-use::fn()",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.audioSampleRate::kernel-export-direct-use::fn()",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.dup3::kernel-export-direct-use::fn(oldfd, newfd, flags)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.fchmod::kernel-export-direct-use::fn(fd, mode)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.fchown::kernel-export-direct-use::fn(fd, uid, gid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.fdatasync::kernel-export-direct-use::fn(fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.fsync::kernel-export-direct-use::fn(fd)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.ftruncate::kernel-export-direct-use::fn(fd, BigInt(length))",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.getpgrp::kernel-export-direct-use::fn()",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.getsid::kernel-export-direct-use::fn(pid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.setegid::kernel-export-direct-use::fn(egid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.seteuid::kernel-export-direct-use::fn(euid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.setgid::kernel-export-direct-use::fn(gid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.setpgid::kernel-export-direct-use::fn(pid, pgid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.setsid::kernel-export-direct-use::fn()",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.setuid::kernel-export-direct-use::fn(uid)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.shutdown::kernel-export-direct-use::fn(fd, how)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.signal::kernel-export-direct-use::fn(signum, handler)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.socket::kernel-export-direct-use::fn(domain, type, protocol)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.sysconf::kernel-export-direct-use::fn(name)",
  ),
  reviewedScalarKernelExportCall(
    "host/src/kernel.ts::WasmPosixKernel.umask::kernel-export-direct-use::fn(mask)",
  ),
];

const auditAllowances: AuditAllowance[] = [
  ...reviewedScalarKernelExportCalls,
  {
    key: "host/src/host-adapter-manifest.ts::<module>::wasm-authority-escape::WebAssembly.Memory.prototype",
    disposition: "kernel-read",
    why: "Module initialization passes the intrinsic Memory prototype directly to the captured descriptor lookup so the manifest reader can authenticate and measure a genuine current kernel buffer; no Memory instance or buffer is retained.",
  },
  {
    key: "host/src/kernel-entry-gate.ts::<module>::wasm-authority-escape::WebAssembly.Instance.prototype",
    disposition: "kernel-control",
    why: "Module initialization passes the intrinsic Instance prototype directly to the captured descriptor lookup so the gate can authenticate raw engine instances without retaining an instance or exports namespace.",
  },
  {
    key: "host/src/kernel-entry-gate.ts::createFrozenKernelInstanceFacade::wasm-authority-escape::intrinsicWasmInstancePrototype",
    disposition: "kernel-control",
    why: "The frozen façade deliberately has the intrinsic Instance prototype for nominal compatibility, but it is a slotless plain object: the captured intrinsic exports getter rejects it and only the gate's private WeakMaps authorize it.",
  },
  {
    key: "host/src/kernel-scratch.ts::<module>::wasm-authority-escape::WebAssembly.Memory.prototype",
    disposition: "scratch-core",
    why: "Module initialization passes the intrinsic Memory prototype directly to the captured descriptor lookup; the resulting getter authenticates current buffers inside checked scratch operations and exposes no Memory authority.",
  },
  {
    key: "host/src/kernel-worker.ts::<module>::wasm-authority-escape::WebAssembly.Memory.prototype",
    disposition: "kernel-control",
    why: "The dedicated worker captures the intrinsic Memory buffer getter before callbacks can mutate built-ins; this exact prototype access retains no Memory instance or backing buffer.",
  },
  {
    key: "host/src/kernel.ts::<module>::wasm-authority-escape::WebAssembly.Memory.prototype",
    disposition: "kernel-control",
    why: "The kernel wrapper captures the intrinsic Memory buffer getter before any host hook runs so later range checks cannot be redirected to a fake buffer; no Memory instance is captured here.",
  },
  {
    key: "host/src/kernel.ts::<module>::wasm-authority-escape::WebAssembly.Instance.prototype",
    disposition: "kernel-control",
    why: "The kernel wrapper passes the intrinsic Instance prototype directly to a captured descriptor lookup so raw engine exports can be authenticated before gate construction; it retains no instance or namespace.",
  },
  {
    key: "packages/registry/node-compat/bootstrap.js::runInThisContext::dynamic-code-contract::eval(code)",
    disposition: "non-kernel",
    why: "This reviewed Node compatibility boundary implements vm.runInThisContext for package JavaScript; the evaluated source runs in its explicit compatibility realm and receives no kernel Memory, Instance, exports namespace, or scratch authority.",
  },
  {
    key: "packages/registry/node-compat/bootstrap.js::runInThisContext::dynamic-code-contract::eval(this.code)",
    disposition: "non-kernel",
    why: "This is the matching compiled-script path for the reviewed Node vm compatibility boundary and likewise receives no kernel WebAssembly authority.",
  },
  {
    key: "packages/registry/spidermonkey/node-compat/adapter.js::evalScriptAsFunction::dynamic-code-contract::(0, eval)(source + '\\n//# sourceURL=' + filename)",
    disposition: "non-kernel",
    why: "The SpiderMonkey Node-compat adapter intentionally evaluates package JavaScript as its documented script-loader boundary; it is outside the kernel worker and receives no kernel WebAssembly authority.",
  },
  {
    key: 'apps/browser-demos/pages/network/network-demo-worker.ts::createProcessMemory::wasm-memory-authority::new WebAssembly.Memory({ initial: BigInt(initialPages) as unknown as number, maximum: BigInt(MAX_PAGES) as unknown as number, shared: true, address: "i64", } as WebAssembly.MemoryDescriptor)',
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This memory64 branch creates only the diagnostic demo process's shared guest memory.",
  },
  {
    key: "apps/browser-demos/pages/network/network-demo-worker.ts::createProcessMemory::wasm-memory-authority::new WebAssembly.Memory({ initial: initialPages, maximum: MAX_PAGES, shared: true, })",
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This memory32 branch creates only the diagnostic demo process's shared guest memory.",
  },
  {
    key: "apps/browser-demos/public/terminate-atomics-worker.js::<module>::wasm-memory-authority::new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true })",
    disposition: "non-kernel",
    authorityOwner: "shared-memory",
    why: "This isolated browser diagnostic creates only its disposable Atomics termination test memory.",
  },
  {
    key: "apps/browser-demos/public/wasm-memory-reclaim-worker.js::makeCommittedSharedMemory::wasm-memory-authority::new WebAssembly.Memory({ initial: 1, maximum: MAX_PAGES, shared: true, })",
    disposition: "non-kernel",
    authorityOwner: "shared-memory",
    why: "This isolated browser diagnostic creates disposable shared memory solely to measure reclamation.",
  },
  {
    key: "apps/browser-demos/test/epoll-repro.ts::main::wasm-memory-authority::new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true })",
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This browser epoll reproduction creates its test process memory, not the kernel's linear memory.",
  },
  {
    key: 'host/src/browser-kernel-worker-entry.ts::createSharedProcessMemory::wasm-memory-authority::new WebAssembly.Memory({ initial: BigInt(initialPages), maximum: BigInt(maximumPages), shared: true, address: "i64", } as unknown as WebAssembly.MemoryDescriptor)',
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This browser memory64 factory creates a fork child's shared process memory.",
  },
  {
    key: "host/src/browser-kernel-worker-entry.ts::createSharedProcessMemory::wasm-memory-authority::new WebAssembly.Memory({ initial: initialPages, maximum: maximumPages, shared: true, })",
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This browser memory32 factory creates a fork child's shared process memory.",
  },
  {
    key: "host/src/dylink.ts::instantiateSharedLibrary::wasm-instance-authority::new WebAssembly.Instance(module, imports)",
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This instance is a user process's dynamically linked shared library and can access only that process's imports.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#createKernelMemory::wasm-memory-authority::new IntrinsicWasmMemory({ initial: 24n, maximum: 16384n, shared: true, address: "i64", } as unknown as WebAssembly.MemoryDescriptor)',
    disposition: "kernel-control",
    authorityOwner: "kernel",
    why: "This true-private memory64 branch creates the dedicated kernel linear memory.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#createKernelMemory::wasm-memory-authority::new IntrinsicWasmMemory({ // 24 pages = 1.5 MiB of initial address space. This must remain above // the kernel Wasm's linker-derived minimum and leaves headroom for // future static data without re-tuning host construction each time. initial: 24, maximum: 16384, shared: true, })",
    disposition: "kernel-control",
    authorityOwner: "kernel",
    why: "This true-private memory32 branch creates the dedicated kernel linear memory.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.init::wasm-instance-authority::intrinsicApply( intrinsicWasmInstantiate, WebAssembly, [module, importObject], )",
    disposition: "kernel-control",
    authorityOwner: "kernel",
    why: "The captured intrinsic instantiates the kernel module with its private kernel-memory import object.",
  },
  {
    key: 'host/src/node-kernel-worker-entry.ts::createSharedProcessMemory::wasm-memory-authority::new WebAssembly.Memory({ initial: BigInt(initialPages) as any, maximum: BigInt(maximumPages) as any, shared: true, address: "i64", } as any)',
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This Node memory64 factory creates a fork child's shared process memory.",
  },
  {
    key: "host/src/node-kernel-worker-entry.ts::createSharedProcessMemory::wasm-memory-authority::new WebAssembly.Memory({ initial: initialPages, maximum: maximumPages, shared: true, })",
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This Node memory32 factory creates a fork child's shared process memory.",
  },
  {
    key: 'host/src/process-memory.ts::createProcessMemory::wasm-memory-authority::new WebAssembly.Memory({ initial: BigInt(layout.initialPages) as any, maximum: BigInt(layout.maximumPages) as any, shared: true, address: "i64", } as any)',
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This ordinary memory64 factory creates caller-owned process memory.",
  },
  {
    key: "host/src/process-memory.ts::createProcessMemory::wasm-memory-authority::new WebAssembly.Memory({ initial: layout.initialPages, maximum: layout.maximumPages, shared: true, })",
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This ordinary memory32 factory creates caller-owned process memory.",
  },
  {
    key: "host/src/worker-main.ts::centralizedThreadWorkerMain::wasm-instance-authority::new WebAssembly.Instance(module, importObject)",
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    why: "This thread worker instance executes a user process module against that process's shared memory.",
  },
  {
    key: "host/src/worker-main.ts::centralizedWorkerMain::wasm-instance-authority::WebAssembly.instantiate(module, importObject)",
    disposition: "non-kernel",
    authorityOwner: "process-memory",
    count: 3,
    why: "These three exact process launch paths instantiate user modules against caller-owned process memory, never kernel memory.",
  },
  {
    key: "host/src/kernel-scratch.ts::intrinsicWasmMemoryBuffer::kernel-memory-escape::intrinsicApply( intrinsicMemoryBuffer, memory, [], )",
    disposition: "scratch-core",
    why: "This is the single captured intrinsic access to a genuine WebAssembly.Memory buffer; every caller immediately applies an allocation-capacity or exact fixed-range proof.",
  },
  {
    key: "host/src/kernel-scratch.ts::OwnedKernelScratchRegion.constructor::kernel-memory-store::this.#memory = memory",
    disposition: "scratch-core",
    why: "The unforgeable region constructor stores the factory-validated kernel memory in a true private slot so every lease can recheck current bounds.",
  },
  {
    key: "host/src/kernel-scratch.ts::OwnedKernelScratchRegion.allocate::kernel-memory-escape::intrinsicApply( intrinsicWeakMapSet, ownedKernelScratchRegionOwnerships, [ region, intrinsicObjectFreeze({ memory, pointerWidth, instance: kernelInstance ?? null, }), ], )",
    disposition: "scratch-core",
    why: "The allocator records the exact factory-proven memory, pointer width, and gated instance in a module-private WeakMap so test validation can authenticate the region without exposing its pointer.",
  },
  {
    key: "host/src/kernel-scratch.ts::OwnedKernelScratchRegion.allocate::kernel-memory-escape::intrinsicObjectFreeze({ memory, pointerWidth, instance: kernelInstance ?? null, })",
    disposition: "scratch-core",
    why: "This frozen allocation-ownership record stays reachable only through the module-private WeakMap and is compared against the exact gated generation before any test region is accepted.",
  },
  {
    key: "host/src/kernel-scratch.ts::OwnedKernelScratchRegion.reserve::kernel-memory-escape::intrinsicApply( intrinsicWeakMapSet, ownedKernelScratchRegionOwnerships, [ region, intrinsicObjectFreeze({ memory, pointerWidth, instance: kernelInstance ?? null, }), ], )",
    disposition: "scratch-core",
    why: "A single-use reservation records its exact Rust-owned memory and gated generation in the same module-private ownership table before the region is returned.",
  },
  {
    key: "host/src/kernel-scratch.ts::OwnedKernelScratchRegion.reserve::kernel-memory-escape::intrinsicObjectFreeze({ memory, pointerWidth, instance: kernelInstance ?? null, })",
    disposition: "scratch-core",
    why: "This frozen reservation-ownership record is private metadata, not a caller-visible Memory escape; revocation and validation remain bound to the matching token generation.",
  },
  {
    key: "host/src/kernel-scratch.ts::OwnedKernelScratchRegion.allocate::scratch-allocator-call::allocator(capacity)",
    disposition: "scratch-core",
    why: "This is the sole allocator invocation; the returned pointer remains private and is validated with its requested capacity.",
  },
  {
    key: "host/src/host-adapter-manifest.ts::bufferByteLength::kernel-buffer-escape::intrinsicApply( intrinsicSharedArrayBufferByteLength, buffer, [], )",
    disposition: "kernel-read",
    why: "The captured SharedArrayBuffer byteLength getter only authenticates and measures the current kernel buffer before the fixed manifest range check; it cannot retain or mutate the buffer.",
  },
  {
    key: "host/src/host-adapter-manifest.ts::readKernelHostAdapterManifest::kernel-view::new IntrinsicDataView( buffer, pointer, HOST_ADAPTER_MANIFEST_SIZE, )",
    disposition: "kernel-read",
    why: "The fixed-size manifest view is created only after a lossless pointer conversion and complete current-buffer range proof, read synchronously, and never returned.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.init::scratch-address-contract::runtimeAccess.instance()",
    disposition: "kernel-control",
    why: "The dedicated worker retrieves the gated façade through the package-private authority; raw callable exports never leave kernel.ts.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#createTestAuthority::scratch-address-contract::options.instance",
    disposition: "kernel-control",
    why: "The module-secret test initializer assigns this instance only after both the allocator-private region ownership check and the entry-gate ownership check prove the same exact gated generation.",
  },
  {
    key: 'host/src/kernel-worker.ts::CentralizedKernelWorker.init::scratch-region-factory-call::allocateKernelScratchRegion( this.#kernelMemory!, allocScratch, SCRATCH_SIZE, this.#kernelPointerWidth, "kernel syscall scratch", // WHY: the allocator call is scoped to this initialization entry, // but the resulting region survives it. Bind ownership to the // persistent gated generation, never the revocable scoped façade. this.#kernelInstance!, instance, )',
    disposition: "scratch-core",
    why: "The main channel region invokes allocation through the revocable init scope but binds the returned pointer and explicit channel capacity to the same generation's persistent private memory and gate owner.",
  },
  {
    key: 'host/src/kernel-worker.ts::CentralizedKernelWorker.init::scratch-region-factory-call::allocateKernelScratchRegion( this.#kernelMemory!, allocScratch, 65536, this.#kernelPointerWidth, "kernel TCP scratch", this.#kernelInstance!, instance, )',
    disposition: "scratch-core",
    why: "The TCP region invokes allocation through the revocable init scope but binds its reviewed fixed capacity to the same generation's persistent private memory and gate owner before network callbacks can use it.",
  },
  {
    key: 'host/src/kernel-worker.ts::CentralizedKernelWorker.#beginLargeSpawnScratch::scratch-region-factory-call::reserveKernelScratchRegion( this.#kernelMemory!, () => ({ pointer: pointer(rawToken), capacity: capacity(rawToken), }), blobLen, this.#kernelPointerWidth, "kernel reserved spawn scratch", // Bind allocator provenance to the same persistent gated generation as // every I/O reservation. A scoped entry façade cannot outlive this call. this.#kernelInstance!, )',
    disposition: "scratch-core",
    why: "The spawn region binds one live Rust token's pointer and actual capacity to the persistent gated generation and is single-use for the matching synchronous commit or cancellation.",
  },
  {
    key: 'host/src/kernel-worker.ts::CentralizedKernelWorker.#beginLargeTransferScratch::scratch-region-factory-call::reserveKernelScratchRegion( this.#kernelMemory!, () => ({ pointer: pointer(rawToken), capacity: capacity(rawToken), }), minimumCapacity, this.#kernelPointerWidth, "kernel reserved I/O transfer scratch", // The region factory binds allocator ownership to the persistent // gated façade. `entry` proves this reservation belongs to that exact // generation; scoped façades are deliberately non-transferable. this.#kernelInstance!, )',
    disposition: "scratch-core",
    why: "The large-I/O region binds a live Rust token's pointer and capacity to the persistent gated façade; the lexical entry proves that exact generation while the single lease is active.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#beginLargeSpawnScratch::scratch-reservation-call::begin(this.toKernelPtr(blobLen))",
    disposition: "scratch-core",
    count: 1,
    why: "This begins one exclusive Rust-owned spawn reservation after the complete blob length has been validated and losslessly converted to the kernel pointer width.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#beginLargeSpawnScratch::scratch-reservation-call::capacity(rawToken)",
    disposition: "scratch-core",
    count: 1,
    why: "The capacity query is consumed only while the matching exclusive spawn token is live and is independently checked against the requested complete blob size.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#beginLargeSpawnScratch::scratch-reservation-call::pointer(rawToken)",
    disposition: "scratch-core",
    count: 1,
    why: "The pointer query is consumed only by the capacity-bearing single-use region factory while the exact matching spawn token remains live.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#cancelLargeSpawnScratch::scratch-reservation-call::cancel(token)",
    disposition: "scratch-core",
    count: 1,
    why: "This cleanup consumes an uncommitted spawn token under the same entry transaction so no later operation can reuse its region while host bytes remain live.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#beginLargeTransferScratch::scratch-reservation-call::begin(this.toKernelPtr(minimumCapacity))",
    disposition: "scratch-core",
    count: 1,
    why: "This begins one exclusive Rust-owned I/O reservation only after the complete transfer footprint has been checked and losslessly converted to the kernel pointer width.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#beginLargeTransferScratch::scratch-reservation-call::capacity(rawToken)",
    disposition: "scratch-core",
    count: 1,
    why: "The capacity query is consumed only while the exact I/O token is live and the returned allocation capacity is rechecked against the requested complete footprint.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#beginLargeTransferScratch::scratch-reservation-call::pointer(rawToken)",
    disposition: "scratch-core",
    count: 1,
    why: "The pointer query feeds only the capacity-bearing single-use region factory while the matching Rust-owned I/O token remains live.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#cancelLargeTransferScratch::scratch-reservation-call::cancel(token)",
    disposition: "scratch-core",
    count: 1,
    why: "This settlement consumes exactly one unfinished I/O token after its lease is revoked, preventing later operations from reusing bytes under stale host authority.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.init::kernel-pointer-export-bypass::abiVersionFn()",
    disposition: "kernel-control",
    why: "This exact generated-name export takes no arguments and returns only the kernel ABI version scalar.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#createTestAuthority::kernel-pointer-export-bypass::drain( this.#kernelPointerWidth === 8 ? 0n : 0, capacity, )",
    disposition: "kernel-control",
    why: "An allocator-owned KernelScratchExportPointer cannot represent null. This secret-capability fixed mqueue companion is the only intentional direct null call to this export and verifies Rust rejects the missing destination before consuming notification state; guarded destinations still require opaque lease tokens.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.#createTestAuthority::kernel-pointer-export-bypass::waitPoll( channel.pid, callerTid, childPid, WAIT_EVENT_EXITED, 0, this.#kernelPointerWidth === 8 ? 0n : 0, capacity, )",
    disposition: "kernel-control",
    why: "An allocator-owned KernelScratchExportPointer cannot represent null. This secret-capability fixed wait companion is the only intentional direct null call to this export and proves Rust rejects the destination before selecting or consuming child status; guarded destinations still require opaque lease tokens.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.handleIpcControl::kernel-pointer-export-bypass::structureBytes(pointerWidth)",
    disposition: "kernel-control",
    why: "This exact two-name IPC metadata branch passes only pointer width and returns a structure-size scalar.",
  },
  {
    key: "host/src/kernel.ts::bufferByteLength::kernel-buffer-escape::intrinsicApply( intrinsicSharedArrayBufferByteLength, buffer, [], )",
    disposition: "kernel-read",
    why: "The captured byteLength getter authenticates and measures the current kernel buffer for page-count and range checks without retaining or mutating it.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-memory-return::memory",
    disposition: "kernel-control",
    why: "The dedicated memory is returned only as env.memory inside the private kernel import object consumed by the reviewed instantiation path or module-secret test companion.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#createKernelMemory::kernel-memory-return::return new IntrinsicWasmMemory({ initial: 24n, maximum: 16384n, shared: true, address: "i64", } as unknown as WebAssembly.MemoryDescriptor);',
    disposition: "kernel-control",
    why: "This true-private factory branch creates the dedicated memory64 kernel linear memory before it can be published to an instance or worker.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#createKernelMemory::kernel-memory-return::return new IntrinsicWasmMemory({ // 24 pages = 1.5 MiB of initial address space. This must remain above // the kernel Wasm's linker-derived minimum and leaves headroom for // future static data without re-tuning host construction each time. initial: 24, maximum: 16384, shared: true, });",
    disposition: "kernel-control",
    why: "This true-private factory branch creates the dedicated memory32 kernel linear memory before it can be published to an instance or worker.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#createTestAuthority::kernel-memory-return::this.#buildImportObject(memory)",
    disposition: "kernel-control",
    why: "The module-secret test companion exposes this import builder only as a frozen named method; supported package entry points expose neither the companion nor a kernel Memory.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#createTestAuthority.defineMethod::kernel-memory-escape::intrinsicObjectDefineProperty(authority, name, { configurable: false, enumerable: true, writable: false, value, })",
    disposition: "kernel-control",
    why: "This module-secret test-only boundary installs exact frozen method closures rather than a target-bearing proxy; authority and raw memory remain absent from every supported package export.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#requireApiScratch::scratch-region-factory-call::allocateKernelScratchRegion( this.#memory, allocator, WasmPosixKernel.API_SCRATCH_SIZE, this.#kernelPtrWidth, "kernel public API scratch", this.#instance!, )',
    disposition: "scratch-core",
    why: "The public-wrapper scratch region binds the private Memory, exact gated instance, pointer width, and explicit 65,536-byte allocation before any temporary API transfer.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#ensureAudioScratch::scratch-region-factory-call::allocateKernelScratchRegion( this.#memory, alloc, WasmPosixKernel.AUDIO_SCRATCH_SIZE, this.#kernelPtrWidth, "kernel audio scratch", this.#instance!, )',
    disposition: "scratch-core",
    why: "The lazily created audio region binds the same private generation and explicit capacity and is used only through synchronous checked leases.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#getMemoryBuffer::kernel-view-return::return new IntrinsicUint8Array(wasmMemoryBuffer(this.#memory));",
    disposition: "kernel-read",
    why: "This true-private current-buffer view is returned only to the separately audited checked read and Rust-lent write helpers and never crosses a callback or promise.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#getMemoryBuffer::kernel-view::new IntrinsicUint8Array(wasmMemoryBuffer(this.#memory))",
    disposition: "kernel-read",
    why: "The private constructor reacquires the current backing buffer for one synchronous checked helper; no cached view survives memory growth.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#rustLentKernelDestination::kernel-memory-escape::intrinsicApply( intrinsicWeakMapSet, rustLentKernelDestinationRecords, [ destination, { owner: this, generation: this.#memoryGeneration, memory: this.#memory, pointer: range.pointer, capacity: range.length, label, consumed: false, }, ], )",
    disposition: "rust-lent",
    why: "This module-private WeakMap authenticates one normalized pointer and explicit capacity to the exact kernel Memory generation; the public frozen token exposes no pointer or Memory and is single-use.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#createTestAuthority::kernel-destination-factory-call::this.#rustLentKernelDestination( pointer, capacity, "test kernel destination", )',
    disposition: "rust-lent",
    why: "The module-secret test companion passes its exact pointer and capacity formals directly into the authenticated destination factory.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#createTestAuthority::kernel-destination-factory-call::this.#rustLentKernelDestination( statPointer, WASM_STAT_SIZE, "test host_fstat destination", )',
    disposition: "rust-lent",
    why: "The module-secret fstat companion binds its exact pointer formal to the generated fixed stat capacity before backend work.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#createTestAuthority::kernel-destination-factory-call::this.#rustLentKernelDestination( direntPointer, WASM_DIRENT_SIZE, "test host_readdir dirent destination", )',
    disposition: "rust-lent",
    why: "The module-secret readdir companion binds its exact dirent pointer formal to the generated fixed record capacity before backend work.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#createTestAuthority::kernel-destination-factory-call::this.#rustLentKernelDestination( namePointer, nameLength, "test host_readdir name destination", )',
    disposition: "rust-lent",
    why: "The module-secret readdir companion binds its exact name pointer and capacity formals before backend work.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( bufPtr, bufLen, "host_read destination", )',
    disposition: "rust-lent",
    why: "The host_read Wasm import binds the untouched Rust pointer and capacity formals before invoking any producer.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( bufPtr, bufLen, "host_pread destination", )',
    disposition: "rust-lent",
    why: "The host_pread Wasm import binds the untouched Rust pointer and capacity formals before invoking any positioned producer.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( statPtr, WASM_STAT_SIZE, "host_fstat destination", )',
    disposition: "rust-lent",
    why: "The host_fstat import binds its exact pointer formal to the generated fixed stat capacity before the backend consumes the handle.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( statPtr, WASM_STAT_SIZE, "host_stat destination", )',
    disposition: "rust-lent",
    why: "The host_stat import binds its exact pointer formal to the generated fixed stat capacity before path/backend work.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( statPtr, WASM_STAT_SIZE, "host_lstat destination", )',
    disposition: "rust-lent",
    why: "The host_lstat import binds its exact pointer formal to the generated fixed stat capacity before path/backend work.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( statfsPtr, WASM_STATFS_SIZE, "host_statfs destination", )',
    disposition: "rust-lent",
    why: "The host_statfs import binds its exact pointer formal to the generated fixed filesystem-stat capacity before backend work.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( valuePtr, 8, "host_pathconf destination", )',
    disposition: "rust-lent",
    why: "The host_pathconf import binds its exact pointer formal to the fixed eight-byte result capacity before backend work.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( valuePtr, 8, "host_fpathconf destination", )',
    disposition: "rust-lent",
    why: "The host_fpathconf import binds its exact pointer formal to the fixed eight-byte result capacity before backend work.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( bufPtr, bufLen, "host_readlink destination", )',
    disposition: "rust-lent",
    why: "The host_readlink import binds the untouched Rust pointer and capacity formals before resolving the link.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( direntPtr, WASM_DIRENT_SIZE, "host_readdir dirent destination", )',
    disposition: "rust-lent",
    why: "The host_readdir import authenticates its dirent pointer against the generated fixed record capacity before advancing the iterator.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( namePtr, nameLen, "host_readdir name destination", )',
    disposition: "rust-lent",
    why: "The host_readdir import authenticates its untouched name pointer and capacity formals before advancing the iterator.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( secPtr, 8, "host_clock_gettime seconds destination", )',
    disposition: "rust-lent",
    why: "The clock import binds the seconds pointer formal to its fixed eight-byte result before consulting the clock backend.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( nsecPtr, 8, "host_clock_gettime nanoseconds destination", )',
    disposition: "rust-lent",
    why: "The clock import binds the nanoseconds pointer formal to its fixed eight-byte result before consulting the clock backend.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( bufPtr, bufLen, "host_getrandom destination", )',
    disposition: "rust-lent",
    why: "The random import authenticates the untouched Rust pointer and capacity before the entropy producer runs.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( statusPtr, 4, "host_waitpid status destination", )',
    disposition: "rust-lent",
    why: "The wait import binds its nonnull status pointer formal to the fixed four-byte result before either backend can consume child state.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( bufPtr, bufLen, "host_net_recv destination", )',
    disposition: "rust-lent",
    why: "The network receive import authenticates the untouched Rust pointer and capacity before the network producer runs.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( resultPtr, resultLen, "host_getaddrinfo destination", )',
    disposition: "rust-lent",
    why: "The address lookup import authenticates the untouched result pointer and capacity before the resolver runs.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( outPtr, outLen, "host_gl_query destination", )',
    disposition: "rust-lent",
    why: "The graphics query import authenticates its untouched output pointer and capacity before touching WebGL state.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( dst_ptr, len, "host_proc_read_bytes destination", )',
    disposition: "rust-lent",
    why: "The process-copy import authenticates its untouched kernel destination pointer and capacity before resolving or reading process memory.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.#buildImportObject::kernel-destination-factory-call::this.#rustLentKernelDestination( out_ptr, STRUCT_SIZE_WPK_DRM_MODE_MODEINFO, "host_kms_mode_info destination", )',
    disposition: "rust-lent",
    why: "The display-mode import binds its exact pointer formal to the generated fixed structure capacity before inspecting display state.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#hostFutexWait::kernel-view::new IntrinsicInt32Array(wasmMemoryBuffer(this.#memory))",
    disposition: "kernel-control",
    why: "The lossless pointer, four-byte current-memory range, and alignment are proved before constructing this one synchronous futex-wait atomic view.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#hostFutexWake::kernel-view::new IntrinsicInt32Array(wasmMemoryBuffer(this.#memory))",
    disposition: "kernel-control",
    why: "The lossless pointer, four-byte current-memory range, and alignment are proved before constructing this one synchronous futex-wake atomic view.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.#writeKernelBytes::kernel-write::intrinsicApply( intrinsicUint8ArraySet, this.#getMemoryBuffer(), [exactBytes, range.pointer], )",
    disposition: "rust-lent",
    why: "The raw sink runs only after lossless pointer conversion, explicit Rust-lent capacity/current-memory proof, and an intrinsic producer-length check; it publishes once synchronously.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.constructor::kernel-memory-escape::intrinsicApply( intrinsicWeakMapSet, wasmPosixKernelRuntimeAccess, [ this, { gate: this.#kernelEntryGate, instance: () => this.#instance, memory: () => this.#memory, }, ], )",
    disposition: "kernel-control",
    why: "The package-private WeakMap grants only the dedicated worker access to this wrapper's exact gate, gated instance, and memory; none is exported from the public package surface.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.constructor::kernel-memory-return::() => this.#memory",
    disposition: "kernel-control",
    why: "This closure is reachable only through the package-private worker WeakMap and returns the current private Memory to that dedicated worker, not to a public caller.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.constructor::scratch-address-contract::testRuntime.instance ?? null",
    disposition: "kernel-control",
    why: "Only the module-secret test constructor can seed a deterministic instance; the resulting frozen test companion exposes no instance, Memory, export namespace, region, or arbitrary target dispatch.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.init::kernel-memory-escape::intrinsicApply( intrinsicWasmInstantiate, WebAssembly, [module, importObject], )",
    disposition: "kernel-control",
    why: "The captured engine intrinsic receives the dedicated memory only through the private env.memory import object and returns one raw instance that is wrapped before publication.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.init::kernel-memory-escape::this.#testEngine.instantiate(module, importObject)",
    disposition: "kernel-control",
    why: "The module-secret deterministic test engine receives the same private import object; this branch is unreachable from a production wrapper and its result is still gated before assignment.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.init::scratch-address-contract::createKernelEntryGatedInstance( rawInstance, this.#kernelEntryGate, )",
    disposition: "kernel-control",
    why: "The raw engine instance is immediately converted to the frozen gate-bound façade before the private instance slot is assigned or any worker can observe it.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.ioctl::kernel-pointer-export-bypass::fn( fd, request, this.toKernelPtr(scalarArgument), bufLen, 4, )",
    disposition: "kernel-control",
    why: "This exact non-pointer ioctl branch passes a scalar command argument with zero buffer length; pointer ioctl requests use the scratch lease branch above.",
  },
];

describe("kernel scratch static contract", () => {
  it("keeps host pointer roles aligned with Rust export parameters", () => {
    for (const exportName of KERNEL_SCRATCH_EXPORT_NAMES) {
      expect(() =>
        assertKernelScratchPointerRoleContract(kernelWasmApiSource, exportName),
      ).not.toThrow();
    }
  });

  it("rejects a same-Wasm-signature pointer-pair reorder", () => {
    const original =
      'pub extern "C" fn kernel_send(fd: i32, buf_ptr: *const u8, ' +
      "buf_len: u32, flags: u32) -> i32";
    const reordered =
      'pub extern "C" fn kernel_send(buf_ptr: *const u8, buf_len: u32, ' +
      "fd: i32, flags: u32) -> i32";
    expect(kernelWasmApiSource).toContain(original);
    const mutated = kernelWasmApiSource.replace(original, reordered);
    expect(() =>
      assertKernelScratchPointerRoleContract(mutated, "kernel_send"),
    ).toThrow(/kernel_send Rust\/host pointer-role drift/);
  });

  it("publishes only gated exports and package-private raw authority", () => {
    expect(hostKernelSource).not.toMatch(
      /\bgetMemory\s*\(\s*\)\s*:\s*WebAssembly\.Memory/,
    );
    expect(hostIndexSource).not.toContain("getWasmPosixKernelRuntimeAccess");
    expect(kernelEntryGateSource).toContain(
      'if (typeof value !== "function") continue;',
    );
    expect(kernelEntryGateSource).toContain("createKernelEntryScopedInstance(");
    expect(kernelScratchSource).toContain(
      "const binding = validatedKernelEntryCallable(instance, name);",
    );
    expect(kernelScratchSource).toMatch(
      /snapshot\[name\]\s*=\s*intrinsicObjectFreeze\(\{\s*call:\s*binding\.call as KernelScratchExportFunction,\s*argumentCount:\s*binding\.argumentCount,\s*instance,\s*\}\);/,
    );
    expect(kernelScratchSource).toMatch(
      /const invoke = \(\) => intrinsicApply\(\s*kernelExport\.call,\s*undefined,\s*convertedArgs,\s*\);\s*const result = scope === undefined\s*\? invoke\(\)\s*: invokeKernelEntryScopedOperation\(\s*scope,\s*kernelExport\.instance,\s*invoke,\s*\);/,
    );
    expect(hostKernelWorkerSource).not.toContain(
      "rejectReentrantKernelDispatch",
    );
    expect(hostKernelWorkerSource).toContain(
      "this.#runOrDeferChannelKernelEntry(",
    );
    expect(
      formatKernelEntryContextViolations(
        auditKernelEntryContext(hostKernelWorkerSource),
      ),
    ).toEqual([]);
  });

  it("admits only reviewed kernel-memory views, writes, and allocator calls", () => {
    const result = auditWasmMemoryWrites({
      rootDir: repoRoot,
      sourceFiles: repositoryRuntimeSourceFiles(repoRoot),
      ownershipSeeds,
      allowances: auditAllowances,
      kernelExportNames: [...abiKernelExportNames],
      kernelDestinationFactoryDeclarations: [
        "host/src/kernel.ts::WasmPosixKernel.#rustLentKernelDestination",
      ],
      auditWasmAuthorityOrigins: true,
    });
    if (process.env.KANDELO_DEBUG_SCRATCH_AUDIT === "keys") {
      for (const finding of result.violations) {
        console.error(
          `KANDELO_AUDIT_KEY ${finding.file}:${finding.line} ${finding.key}`,
        );
      }
    } else if (process.env.KANDELO_DEBUG_SCRATCH_AUDIT === "1") {
      const violationKinds = Object.fromEntries(
        [...new Set(result.violations.map(({ kind }) => kind))]
          .sort()
          .map((kind) => [
            kind,
            result.violations.filter((finding) => finding.kind === kind).length,
          ]),
      );
      console.error(
        `KANDELO_AUDIT_SUMMARY ${JSON.stringify({
          violations: result.violations.length,
          violationKinds,
          unusedAllowances: result.unusedAllowances.length,
          unresolvedSeeds: result.unresolvedSeeds.length,
          contractErrors: result.contractErrors.length,
        })}`,
      );
      const violationGroups = Object.fromEntries(
        [...new Set(result.violations.map(({ file }) => file))]
          .sort()
          .map((file) => [
            file,
            Object.fromEntries(
              [
                ...new Set(
                  result.violations
                    .filter((finding) => finding.file === file)
                    .map(({ kind }) => kind),
                ),
              ]
                .sort()
                .map((kind) => [
                  kind,
                  result.violations.filter(
                    (finding) => finding.file === file && finding.kind === kind,
                  ).length,
                ]),
            ),
          ]),
      );
      console.error(`KANDELO_AUDIT_GROUPS ${JSON.stringify(violationGroups)}`);
      console.error(
        `KANDELO_AUDIT_UNUSED ${JSON.stringify(
          result.unusedAllowances.map(({ key }) => key),
        )}`,
      );
      console.error(
        JSON.stringify({
          unresolvedSeeds: result.unresolvedSeeds,
          violations: result.violations,
          unusedAllowances: result.unusedAllowances,
          contractErrors: result.contractErrors,
        }),
      );
    }
    expect(formatAuditFailures(result)).toEqual([]);
    // This intentionally builds one TypeScript program for every repository
    // runtime source; keep CI headroom above the focused local 25–35 second run.
  }, 60_000);

  it("keeps variable-transfer parsing private and allocation-region-bearing", () => {
    const prefixOnlyFixture = kernelExportNamesFromSnapshot(
      JSON.stringify({
        kernel_exports: [{ name: "kernel_read_proc_maps" }],
      }),
    );
    const exactFixture = kernelExportNamesFromSnapshot(
      JSON.stringify({
        kernel_exports: [{ name: "kernel_read" }],
      }),
    );
    expect(prefixOnlyFixture.has("kernel_read")).toBe(false);
    expect(exactFixture.has("kernel_read")).toBe(true);
    expect(() =>
      kernelExportNamesFromSnapshot(
        JSON.stringify({
          kernel_exports: [
            { name: "kernel_setsockopt" },
            { name: "kernel_setsockopt" },
          ],
        }),
      ),
    ).toThrow(/duplicate names/);
    expect(() =>
      kernelExportNamesFromSnapshot(
        JSON.stringify({
          kernel_exports: [{ name: 7 }],
        }),
      ),
    ).toThrow(/has no exact name/);

    for (const obsoleteRawExport of [
      "kernel_read",
      "kernel_write",
      "kernel_pread",
      "kernel_pwrite",
      "kernel_readv",
      "kernel_writev",
      "kernel_preadv",
      "kernel_pwritev",
      "kernel_prepare_write_operation",
    ]) {
      expect(kernelWasmApiSource).not.toMatch(
        new RegExp(
          `#\\[unsafe\\(no_mangle\\)\\]\\s*` +
            `pub\\s+extern\\s+\"C\"\\s+fn\\s+${obsoleteRawExport}\\b`,
        ),
      );
      expect(legacySyscallImportsSource).not.toMatch(
        new RegExp(`\\b${obsoleteRawExport}\\b`),
      );
      expect(legacySyscallGlueSource).not.toMatch(
        new RegExp(`\\b${obsoleteRawExport}\\b`),
      );
      // Parse the authoritative export list and compare the complete property
      // value. Prefix-related live exports such as kernel_read_proc_maps must
      // neither trigger a false failure nor suppress an exact obsolete name.
      expect(abiKernelExportNames.has(obsoleteRawExport)).toBe(false);
    }

    for (const helper of [
      "channel_readv",
      "channel_writev",
      "channel_preadv",
      "channel_pwritev",
    ]) {
      expect(kernelWasmApiSource).toMatch(
        new RegExp(
          `fn\\s+${helper}\\s*\\([\\s\\S]*?` +
            `region:\\s*ChannelScratchRegion[\\s\\S]*?\\)\\s*->\\s*i32`,
        ),
      );
      expect(kernelWasmApiSource).toMatch(
        new RegExp(`${helper}\\([\\s\\S]*?scratch_region[\\s\\S]*?\\)`),
      );
    }
    expect(kernelWasmApiSource).toContain(
      "checked_kernel_iovec_entries(iov_ptr, iovcnt, region)",
    );
    // Total linear-memory size can never stand in for allocation ownership.
    expect(kernelWasmApiSource).not.toContain("current_kernel_memory_bytes");
  });

  it("keeps generated platform and spawn contracts wired into musl", () => {
    expect(platformLimitsHeader).toContain(
      `#define KANDELO_POSIX_ARG_MAX_BYTES ${POSIX_ARG_MAX_BYTES}u`,
    );
    expect(platformLimitsHeader).toContain(
      `#define KANDELO_POSIX_PATH_MAX_BYTES ${POSIX_PATH_MAX_BYTES}u`,
    );
    expect(platformLimitsHeader).toContain(
      `#define KANDELO_POSIX_IOV_MAX ${POSIX_IOV_MAX}u`,
    );

    expect(publicLimitsHeader).toContain("#include <bits/kandelo_limits.h>");
    expect(publicLimitsHeader).toContain(
      "#define ARG_MAX KANDELO_POSIX_ARG_MAX_BYTES",
    );
    expect(publicLimitsHeader).toContain(
      "#define PATH_MAX KANDELO_POSIX_PATH_MAX_BYTES",
    );
    expect(publicLimitsHeader).toContain(
      "#define IOV_MAX KANDELO_POSIX_IOV_MAX",
    );
    expect(muslSelectHeader).toContain(
      `#define FD_SETSIZE ${SELECT_FD_SETSIZE}`,
    );
    expect(SELECT_FD_SET_BYTES).toBe(SELECT_FD_SETSIZE / 8);

    expect(spawnContractHeader).toContain("#include <bits/kandelo_limits.h>");
    expect(spawnContractHeader).toContain(
      "#define WASM_POSIX_ARG_MAX_BYTES KANDELO_POSIX_ARG_MAX_BYTES",
    );
    expect(spawnContractHeader).toContain(
      "#define WASM_POSIX_PATH_MAX_BYTES KANDELO_POSIX_PATH_MAX_BYTES",
    );
    const exactSpawnWireMacros = [
      ["WASM_POSIX_SYS_SPAWN", HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN],
      ["WASM_POSIX_SPAWN_STRING_OFFSET_BYTES", SPAWN_WIRE_STRING_OFFSET_BYTES],
      ["WASM_POSIX_SPAWN_HEADER_ARGC_OFFSET", SPAWN_WIRE_HEADER_ARGC_OFFSET],
      ["WASM_POSIX_SPAWN_HEADER_ENVC_OFFSET", SPAWN_WIRE_HEADER_ENVC_OFFSET],
      [
        "WASM_POSIX_SPAWN_HEADER_ACTION_COUNT_OFFSET",
        SPAWN_WIRE_HEADER_ACTION_COUNT_OFFSET,
      ],
      [
        "WASM_POSIX_SPAWN_HEADER_ATTR_FLAGS_OFFSET",
        SPAWN_WIRE_HEADER_ATTR_FLAGS_OFFSET,
      ],
      ["WASM_POSIX_SPAWN_HEADER_PGRP_OFFSET", SPAWN_WIRE_HEADER_PGRP_OFFSET],
      ["WASM_POSIX_SPAWN_HEADER_PAD_OFFSET", SPAWN_WIRE_HEADER_PAD_OFFSET],
      [
        "WASM_POSIX_SPAWN_HEADER_SIGDEF_OFFSET",
        SPAWN_WIRE_HEADER_SIGDEF_OFFSET,
      ],
      [
        "WASM_POSIX_SPAWN_HEADER_SIGMASK_OFFSET",
        SPAWN_WIRE_HEADER_SIGMASK_OFFSET,
      ],
      ["WASM_POSIX_SPAWN_ACTION_OP_OFFSET", SPAWN_WIRE_ACTION_OP_OFFSET],
      ["WASM_POSIX_SPAWN_ACTION_FD_OFFSET", SPAWN_WIRE_ACTION_FD_OFFSET],
      ["WASM_POSIX_SPAWN_ACTION_NEWFD_OFFSET", SPAWN_WIRE_ACTION_NEWFD_OFFSET],
      [
        "WASM_POSIX_SPAWN_ACTION_PATH_OFF_OFFSET",
        SPAWN_WIRE_ACTION_PATH_OFF_OFFSET,
      ],
      [
        "WASM_POSIX_SPAWN_ACTION_PATH_LEN_OFFSET",
        SPAWN_WIRE_ACTION_PATH_LEN_OFFSET,
      ],
      ["WASM_POSIX_SPAWN_ACTION_OFLAG_OFFSET", SPAWN_WIRE_ACTION_OFLAG_OFFSET],
      ["WASM_POSIX_SPAWN_ACTION_MODE_OFFSET", SPAWN_WIRE_ACTION_MODE_OFFSET],
      ["WASM_POSIX_SPAWN_OP_OPEN", SPAWN_WIRE_OP_OPEN],
      ["WASM_POSIX_SPAWN_OP_CLOSE", SPAWN_WIRE_OP_CLOSE],
      ["WASM_POSIX_SPAWN_OP_DUP2", SPAWN_WIRE_OP_DUP2],
      ["WASM_POSIX_SPAWN_OP_CHDIR", SPAWN_WIRE_OP_CHDIR],
      ["WASM_POSIX_SPAWN_OP_FCHDIR", SPAWN_WIRE_OP_FCHDIR],
      ["WASM_POSIX_SPAWN_ATTR_RESETIDS", SPAWN_ATTR_RESETIDS],
      ["WASM_POSIX_SPAWN_ATTR_SETPGROUP", SPAWN_ATTR_SETPGROUP],
      ["WASM_POSIX_SPAWN_ATTR_SETSIGDEF", SPAWN_ATTR_SETSIGDEF],
      ["WASM_POSIX_SPAWN_ATTR_SETSIGMASK", SPAWN_ATTR_SETSIGMASK],
      ["WASM_POSIX_SPAWN_ATTR_SETSCHEDPARAM", SPAWN_ATTR_SETSCHEDPARAM],
      ["WASM_POSIX_SPAWN_ATTR_SETSCHEDULER", SPAWN_ATTR_SETSCHEDULER],
      ["WASM_POSIX_SPAWN_ATTR_USEVFORK", SPAWN_ATTR_USEVFORK],
      ["WASM_POSIX_SPAWN_ATTR_SETSID", SPAWN_ATTR_SETSID],
    ] as const;
    for (const [name, value] of exactSpawnWireMacros) {
      expect(spawnContractHeader).toContain(`#define ${name} ${value}u`);
    }
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_HEADER_BYTES ${SPAWN_WIRE_HEADER_BYTES}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_ACTION_RECORD_BYTES ${SPAWN_WIRE_ACTION_RECORD_BYTES}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_MAX_ARGV_COUNT ${SPAWN_MAX_ARGV_COUNT}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_MAX_ENVP_COUNT ${SPAWN_MAX_ENVP_COUNT}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_MAX_ACTION_COUNT ${SPAWN_MAX_ACTION_COUNT}u`,
    );
    expect(spawnContractHeader).toContain(
      `#define WASM_POSIX_SPAWN_WIRE_MAX_BYTES ${SPAWN_WIRE_MAX_BYTES}u`,
    );

    // WHY: musl compiles generated contracts before overlay headers are
    // installed. The source tree and incremental sysroot installer must both
    // mirror the reserved namespace so a renamed header cannot survive.
    expect(buildMuslSource).toContain(
      'cp "$OVERLAY_DIR/include/limits.h" "$MUSL_DIR/include/limits.h"',
    );
    expect(buildMuslSource).toContain(
      'find "$MUSL_DIR/include/bits" -maxdepth 1 \\\n' +
        "    \\( -type f -o -type l \\) -name 'kandelo_*.h' -delete",
    );
    expect(buildMuslSource).toContain(
      'KANDELO_GENERATED_HEADERS=("$OVERLAY_DIR"/include/bits/kandelo_*.h)',
    );
    expect(buildMuslSource).toContain(
      'cp "${KANDELO_GENERATED_HEADERS[@]}" "$MUSL_DIR/include/bits/"',
    );
    expect(installOverlayHeadersSource).toContain(
      'find "$SYSROOT/include/bits" -maxdepth 1 \\\n' +
        "        \\( -type f -o -type l \\) -name 'kandelo_*.h' -delete",
    );
  });

  it("keeps every requested spawn consumer on authoritative symbols", () => {
    expect(muslSpawnSource).toContain('#include "spawn_contract.h"');
    for (const name of [
      "WASM_POSIX_ARG_MAX_BYTES",
      "WASM_POSIX_PATH_MAX_BYTES",
      "WASM_POSIX_SPAWN_STRING_OFFSET_BYTES",
      "WASM_POSIX_SPAWN_HEADER_BYTES",
      "WASM_POSIX_SPAWN_ACTION_RECORD_BYTES",
      "WASM_POSIX_SPAWN_MAX_ARGV_COUNT",
      "WASM_POSIX_SPAWN_MAX_ENVP_COUNT",
      "WASM_POSIX_SPAWN_MAX_ACTION_COUNT",
      "WASM_POSIX_SPAWN_WIRE_MAX_BYTES",
    ]) {
      expect(muslSpawnSource).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // WHY: accepting a locally redefined copy would let the generated header
    // stay fresh while the compiled C consumer silently follows another value.
    expect(muslSpawnSource).not.toMatch(
      /^\s*#\s*define\s+WASM_POSIX_(?:ARG_MAX|PATH_MAX|SPAWN_)/m,
    );

    expect(kernelSpawnSource).toContain(
      "use wasm_posix_shared::{Errno, spawn_contract};",
    );
    for (const name of [
      "WIRE_HEADER_BYTES",
      "WIRE_ACTION_RECORD_BYTES",
      "MAX_ARGV_COUNT",
      "MAX_ENVP_COUNT",
      "MAX_ACTION_COUNT",
      "POSIX_ARG_MAX_BYTES",
      "POSIX_PATH_MAX_BYTES",
      "WIRE_MAX_BYTES",
    ]) {
      expect(kernelSpawnSource).toMatch(
        new RegExp(`\\bspawn_contract::${name}\\b`),
      );
    }

    for (const name of [
      "POSIX_ARG_MAX_BYTES",
      "POSIX_PATH_MAX_BYTES",
      "SPAWN_MAX_ARGV_COUNT",
      "SPAWN_MAX_ENVP_COUNT",
      "SPAWN_MAX_ACTION_COUNT",
      "SPAWN_WIRE_HEADER_BYTES",
      "SPAWN_WIRE_ACTION_RECORD_BYTES",
      "SPAWN_WIRE_MAX_BYTES",
    ]) {
      expect(hostKernelWorkerSource).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
