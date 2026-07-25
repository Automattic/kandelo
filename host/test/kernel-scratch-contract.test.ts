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
  auditWasmMemoryWrites,
  formatAuditFailures,
  repositoryRuntimeSourceFiles,
  type AuditAllowance,
  type OwnershipSeed,
} from "./support/wasm-memory-write-audit";
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
const hostKernelWorkerSource = readFileSync(
  new URL("../src/kernel-worker.ts", import.meta.url),
  "utf8",
);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const ownershipSeeds: OwnershipSeed[] = [
  {
    declaration: "host/src/kernel.ts::WasmPosixKernel.memory",
    target: "value",
    owner: "kernel",
    form: "memory",
    why: "This private field is the kernel WebAssembly linear memory.",
  },
  {
    declaration: "host/src/kernel.ts::WasmPosixKernel.instance",
    target: "value",
    owner: "kernel",
    form: "instance",
    why: "This private field is the instantiated kernel module whose exported memory aliases the kernel linear memory.",
  },
  {
    declaration: "host/src/kernel.ts::WasmPosixKernel.createKernelMemory",
    target: "return",
    owner: "kernel",
    form: "memory",
    why: "This factory creates only the kernel WebAssembly linear memory.",
  },
  {
    declaration:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.kernelMemory",
    target: "value",
    owner: "kernel",
    form: "memory",
    why: "This worker field aliases only the dedicated kernel memory.",
  },
  {
    declaration:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.kernelInstance",
    target: "value",
    owner: "kernel",
    form: "instance",
    why: "This private field is the exact instantiated kernel module used by worker-side scratch consumers.",
  },
  {
    declaration:
      "apps/browser-demos/test/epoll-repro.ts::KernelWorkerInternals.kernelInstance",
    target: "value",
    owner: "kernel",
    form: "instance",
    why: "This diagnostic-only interface is the reviewed structural view of CentralizedKernelWorker's exact private kernel instance.",
  },
  {
    declaration:
      "apps/browser-demos/test/epoll-repro.ts::KernelWorkerInternals.scratchRegion",
    target: "value",
    owner: "kernel",
    form: "scratch-region",
    why: "This diagnostic-only interface is the reviewed structural view of CentralizedKernelWorker's allocator-created main scratch region.",
  },
  {
    declaration:
      "apps/browser-demos/test/fixtures/opfs-advisory-lock-client-worker.ts::KernelWorkerInternals.kernelInstance",
    target: "value",
    owner: "kernel",
    form: "instance",
    why: "This browser fixture's structural field is populated only by its reviewed cast of the live CentralizedKernelWorker instance.",
  },
  {
    declaration:
      "apps/browser-demos/test/fixtures/opfs-advisory-lock-client-worker.ts::KernelWorkerInternals.scratchRegion",
    target: "value",
    owner: "kernel",
    form: "scratch-region",
    why: "This browser fixture's structural field is populated only by its reviewed cast of the allocator-created main scratch region.",
  },
  {
    declaration: "host/src/browser-kernel-worker-entry.ts::kernelMemory",
    target: "value",
    owner: "kernel",
    form: "memory",
    why: "This browser-worker diagnostic alias points at kernel memory.",
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
    declaration:
      "host/src/node-kernel-worker-entry.ts::ProcessGenerationOwnership.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "Each Node process generation owns its exact guest process memory.",
  },
  {
    declaration:
      "host/src/browser-kernel-worker-entry.ts::ProcessGenerationOwnership.memory",
    target: "value",
    owner: "process-memory",
    form: "memory",
    why: "Each browser process generation owns its exact guest process memory.",
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

const auditAllowances: AuditAllowance[] = [
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
    key: 'host/src/kernel-scratch.ts::snapshotKernelScratchExports::kernel-pointer-export-bypass::intrinsicObjectGetOwnPropertyDescriptor( value, "length", )',
    disposition: "scratch-core",
    why: "The scratch core passes the selected raw Wasm export only to a captured descriptor intrinsic so it can validate exact arity before privately snapshotting the callable.",
  },
  {
    key: "host/src/kernel-scratch.ts::ActiveKernelScratchLease.invokeKernelExport::kernel-pointer-export-bypass::intrinsicApply( kernelExport.call, undefined, convertedArgs, )",
    disposition: "scratch-core",
    why: "This is the sole approved raw invocation after the lease has replaced every pointer argument with a checked owned-range token and matched each adjacent capacity.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.buildImportObject::kernel-memory-return::memory",
    disposition: "kernel-control",
    why: "The env.memory import is the engine-required kernel memory and is consumed only by the two reviewed instantiation sites.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.createKernelMemory::kernel-memory-return::return new WebAssembly.Memory({ initial: 24n, maximum: 16384n, shared: true, address: "i64", } as unknown as WebAssembly.MemoryDescriptor);',
    disposition: "kernel-control",
    why: "This factory branch creates the dedicated memory64 kernel linear memory before instantiation.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.createKernelMemory::kernel-memory-return::return new WebAssembly.Memory({ // 24 pages = 1.5 MiB of initial address space. This must remain above // the kernel Wasm's linker-derived minimum and leaves headroom for // future static data without re-tuning host construction each time. initial: 24, maximum: 16384, shared: true, });",
    disposition: "kernel-control",
    why: "This factory branch creates the dedicated memory32 kernel linear memory before instantiation.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.getMemory::kernel-memory-return::return this.memory;",
    disposition: "kernel-read",
    why: "This documented unsafe trusted-embedder API intentionally exposes kernel memory for tests and low-level diagnostics.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.init::kernel-memory-escape::WebAssembly.instantiate(module, importObject)",
    disposition: "kernel-control",
    why: "The engine receives the dedicated memory only as the kernel module's reviewed env.memory import.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.initWithMemory::kernel-memory-escape::WebAssembly.instantiate(module, importObject)",
    disposition: "kernel-control",
    why: "The thread-worker path passes its explicitly supplied shared kernel memory only to kernel instantiation.",
  },
  {
    key: "host/src/host-adapter-manifest.ts::readKernelHostAdapterManifest::kernel-view::new DataView( memory.buffer, pointer, HOST_ADAPTER_MANIFEST_SIZE, )",
    disposition: "kernel-read",
    why: "The fixed-size adapter manifest is read synchronously after its complete kernel-memory range is checked.",
  },
  {
    key: "host/src/kernel-scratch.ts::OwnedKernelScratchRegion.allocate::scratch-allocator-call::allocator(capacity)",
    disposition: "scratch-core",
    why: "This is the sole allocator invocation; the returned pointer remains private and is validated with its requested capacity.",
  },
  {
    key: 'host/src/kernel-worker.ts::CentralizedKernelWorker.init::scratch-region-factory-call::allocateKernelScratchRegion( this.kernelMemory, allocScratch, SCRATCH_SIZE, this.kernel.getKernelPtrWidth(), "kernel syscall scratch", this.kernelInstance, )',
    disposition: "scratch-core",
    why: "The main channel region binds its memory, allocator, and reviewed fixed capacity to the exact instantiated kernel module.",
  },
  {
    key: 'host/src/kernel-worker.ts::CentralizedKernelWorker.init::scratch-region-factory-call::allocateKernelScratchRegion( this.kernelMemory, allocScratch, 65536, this.kernel.getKernelPtrWidth(), "kernel TCP scratch", this.kernelInstance, )',
    disposition: "scratch-core",
    why: "The TCP region binds its memory, allocator, and reviewed fixed capacity to the exact instantiated kernel module.",
  },
  {
    key: 'host/src/kernel-worker.ts::CentralizedKernelWorker.beginLargeSpawnScratch::scratch-region-factory-call::reserveKernelScratchRegion( this.kernelMemory!, () => ({ pointer: pointer(rawToken), capacity: capacity(rawToken), }), blobLen, this.kernel.getKernelPtrWidth(), "kernel reserved spawn scratch", )',
    disposition: "scratch-core",
    why: "The spawn region binds the pointer and capacity returned by one active Rust-owned transactional reservation.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.requireApiScratch::scratch-region-factory-call::allocateKernelScratchRegion( this.memory, allocator, WasmPosixKernel.API_SCRATCH_SIZE, this.kernelPtrWidth, "kernel public API scratch", this.instance!, )',
    disposition: "scratch-core",
    why: "The public API region binds its memory, allocator, and reviewed fixed capacity to this exact kernel instance.",
  },
  {
    key: 'host/src/kernel.ts::WasmPosixKernel.ensureAudioScratch::scratch-region-factory-call::allocateKernelScratchRegion( this.memory, alloc, WasmPosixKernel.AUDIO_SCRATCH_SIZE, this.kernelPtrWidth, "kernel audio scratch", this.instance!, )',
    disposition: "scratch-core",
    why: "The audio region binds its memory, allocator, and reviewed fixed capacity to this exact kernel instance.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.beginLargeSpawnScratch::spawn-reservation-call::begin(this.toKernelPtr(blobLen))",
    disposition: "scratch-core",
    why: "This begins one transactional Rust-owned reservation before any pointer or capacity is observed.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.beginLargeSpawnScratch::spawn-reservation-call::capacity(rawToken)",
    disposition: "scratch-core",
    why: "The capacity accessor is consumed only by reserveKernelScratchRegion while the matching transaction is active.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.beginLargeSpawnScratch::spawn-reservation-call::pointer(rawToken)",
    disposition: "scratch-core",
    why: "The pointer accessor is consumed only by reserveKernelScratchRegion while the matching transaction is active.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.cancelLargeSpawnScratch::spawn-reservation-call::cancel(token)",
    disposition: "scratch-core",
    why: "This exact cleanup path releases a reservation that was begun but not consumed by the Rust spawn entry point.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.getMemoryBuffer::kernel-view-return::return new Uint8Array(this.memory.buffer);",
    disposition: "kernel-read",
    why: "This private full-memory view is tracked through every caller; only exact checked read and Rust-lent write sinks are admitted below.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.getMemoryBuffer::kernel-view::new Uint8Array(this.memory.buffer)",
    disposition: "kernel-read",
    why: "This private constructor feeds only the separately inventoried synchronous read and checked Rust-lent write helpers.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.hostFutexWait::kernel-view::new Int32Array(this.memory.buffer)",
    disposition: "kernel-control",
    why: "The futex word's lossless pointer, four-byte range, and alignment are checked before constructing this current-memory atomic view.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.hostFutexWake::kernel-view::new Int32Array(this.memory.buffer)",
    disposition: "kernel-control",
    why: "The futex word's lossless pointer, four-byte range, and alignment are checked before constructing this current-memory atomic view.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.writeKernelBytes::kernel-write::this.getMemoryBuffer().set(exactBytes, range.pointer)",
    disposition: "rust-lent",
    why: "writeKernelBytes proves pointer, explicit capacity, current-memory bounds, and producer length before this write.",
  },
  {
    key: "host/src/host-adapter-manifest.ts::readKernelHostAdapterManifest::kernel-pointer-export-bypass::ptrFn()",
    disposition: "kernel-read",
    why: "This exact dynamically selected manifest export returns a scalar offset and accepts no pointer argument.",
  },
  {
    key: "host/src/host-adapter-manifest.ts::readKernelHostAdapterManifest::kernel-pointer-export-bypass::lenFn()",
    disposition: "kernel-read",
    why: "This exact dynamically selected manifest export returns a scalar length and accepts no pointer argument.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.init::kernel-pointer-export-bypass::abiVersionFn()",
    disposition: "kernel-control",
    why: "This exact generated-name export takes no arguments and returns only the kernel ABI version scalar.",
  },
  {
    key: "host/src/kernel-worker.ts::CentralizedKernelWorker.handleIpcControl::kernel-pointer-export-bypass::structureBytes(pointerWidth)",
    disposition: "kernel-control",
    why: "This exact two-name IPC metadata branch passes only pointer width and returns a structure-size scalar.",
  },
  {
    key: "host/src/kernel.ts::WasmPosixKernel.ioctl::kernel-pointer-export-bypass::fn( fd, request, this.toKernelPtr(scalarArgument), bufLen, 4, )",
    disposition: "kernel-control",
    why: "This exact non-pointer ioctl branch passes a scalar command argument with zero buffer length; pointer ioctl requests use the scratch lease branch above.",
  },
];

describe("kernel scratch static contract", () => {
  it("admits only reviewed kernel-memory views, writes, and allocator calls", () => {
    const result = auditWasmMemoryWrites({
      rootDir: repoRoot,
      sourceFiles: repositoryRuntimeSourceFiles(repoRoot),
      ownershipSeeds,
      allowances: auditAllowances,
    });
    expect(formatAuditFailures(result)).toEqual([]);
    // This intentionally builds one TypeScript program for every repository
    // runtime source; keep CI headroom above the focused local 25–35 second run.
  }, 60_000);

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

    // WHY: musl compiles sysconf limits before overlay headers are installed,
    // so both generated public headers must be staged into its source tree.
    expect(buildMuslSource).toContain(
      'cp "$OVERLAY_DIR/include/limits.h" "$MUSL_DIR/include/limits.h"',
    );
    expect(buildMuslSource).toContain(
      'cp "$OVERLAY_DIR/include/bits/kandelo_limits.h" \\\n' +
        '    "$MUSL_DIR/include/bits/kandelo_limits.h"',
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
