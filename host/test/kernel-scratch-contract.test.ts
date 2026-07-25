import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOST_INTERCEPTED_SYSCALLS,
  POSIX_ARG_MAX_BYTES,
  POSIX_IOV_MAX,
  POSIX_PATH_MAX_BYTES,
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
  repositoryTypeScriptSourceFiles,
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
    declaration:
      "host/src/kernel-worker.ts::AnonymousSharedMmapBacking.bytes",
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
    key:
      "host/src/kernel-scratch.ts::KernelScratchDataView.constructor::kernel-buffer-store::private readonly activeMemoryBuffer: () => ArrayBufferLike",
    disposition: "scratch-core",
    why: "This private callback exposes the current backing buffer only after checking that the scratch lease is still active.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchDataView.constructor::kernel-buffer-store::private readonly refreshView: () => { buffer: ArrayBufferLike; view: DataView; }",
    disposition: "scratch-core",
    why: "This private refresh callback repeats owned-range and current-memory checks before replacing the cached buffer.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchDataView.constructor::kernel-view-store::private readonly refreshView: () => { buffer: ArrayBufferLike; view: DataView; }",
    disposition: "scratch-core",
    why: "This private refresh callback returns only the native view paired with its freshly revalidated backing buffer.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchDataView.constructor::kernel-buffer-store::this.cachedBuffer = initial.buffer",
    disposition: "scratch-core",
    why: "The constructor caches the buffer returned by the checked refresh callback solely to detect later memory replacement.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchDataView.constructor::kernel-view-store::this.cachedView = initial.view",
    disposition: "scratch-core",
    why: "The native view remains private behind currentView, which checks lease validity before every operation.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchDataView.currentView::kernel-buffer-store::this.cachedBuffer = refreshed.buffer",
    disposition: "scratch-core",
    why: "A changed Wasm buffer is cached only after refreshView repeats the allocation and current-memory proof.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchDataView.currentView::kernel-view-store::this.cachedView = refreshed.view",
    disposition: "scratch-core",
    why: "A replacement native view is cached only alongside the freshly checked replacement buffer.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchDataView.currentView::kernel-view-return::return this.cachedView;",
    disposition: "scratch-core",
    why: "This private return follows the active-lease and buffer-identity checks and is consumed synchronously by one wrapper method.",
  },
  ...[
    [
      "setBigInt64",
      "this.currentView().setBigInt64(byteOffset, value, littleEndian)",
    ],
    [
      "setBigUint64",
      "this.currentView().setBigUint64(byteOffset, value, littleEndian)",
    ],
    [
      "setFloat32",
      "this.currentView().setFloat32(byteOffset, value, littleEndian)",
    ],
    [
      "setFloat64",
      "this.currentView().setFloat64(byteOffset, value, littleEndian)",
    ],
    [
      "setInt16",
      "this.currentView().setInt16(byteOffset, value, littleEndian)",
    ],
    [
      "setInt32",
      "this.currentView().setInt32(byteOffset, value, littleEndian)",
    ],
    ["setInt8", "this.currentView().setInt8(byteOffset, value)"],
    [
      "setUint16",
      "this.currentView().setUint16(byteOffset, value, littleEndian)",
    ],
    [
      "setUint32",
      "this.currentView().setUint32(byteOffset, value, littleEndian)",
    ],
    ["setUint8", "this.currentView().setUint8(byteOffset, value)"],
  ].map(([method, call]) => ({
    key:
      `host/src/kernel-scratch.ts::KernelScratchDataView.${method}::kernel-write::${call}`,
    disposition: "scratch-core" as const,
    why: "currentView checks lease validity and refreshes the capacity-checked native view before this scalar write.",
  })),
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.constructor::kernel-buffer-store::private readonly currentMemoryBuffer: () => ArrayBufferLike",
    disposition: "scratch-core",
    why: "This private callback is usable only while the lease token is active and reacquires the current Wasm buffer.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.dataView::kernel-buffer-return::return this.currentMemoryBuffer();",
    disposition: "scratch-core",
    why: "The active-memory callback checks lease validity immediately before returning the current buffer to the guarded wrapper.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.dataView.refreshView::kernel-buffer-return::buffer",
    disposition: "scratch-core",
    why: "The returned buffer is paired with a view created only after ownedRange proves allocation capacity and memory bounds.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.dataView.refreshView::kernel-view-return::new DataView( buffer, range.pointer, range.length, )",
    disposition: "scratch-core",
    why: "This private native view covers exactly the freshly checked owned range and remains behind a revocable wrapper.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchRegion.constructor::kernel-memory-store::private readonly memory: WebAssembly.Memory",
    disposition: "scratch-core",
    why: "The region privately retains its allocator's kernel memory so every lease can recheck the current buffer bounds.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchRegion.withLease::kernel-buffer-return::return this.memory.buffer;",
    disposition: "scratch-core",
    why: "This callback returns the current buffer only after validating the active lease token and never escapes the private lease.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.buildImportObject::kernel-memory-return::memory",
    disposition: "kernel-control",
    why: "The env.memory import is the engine-required kernel memory and is consumed only by the two reviewed instantiation sites.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.createKernelMemory::kernel-memory-return::return new WebAssembly.Memory({ initial: 24n, maximum: 16384n, shared: true, address: \"i64\", } as unknown as WebAssembly.MemoryDescriptor);",
    disposition: "kernel-control",
    why: "This factory branch creates the dedicated memory64 kernel linear memory before instantiation.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.createKernelMemory::kernel-memory-return::return new WebAssembly.Memory({ // 24 pages = 1.5 MiB of initial address space. This must remain above // the kernel Wasm's linker-derived minimum and leaves headroom for // future static data without re-tuning host construction each time. initial: 24, maximum: 16384, shared: true, });",
    disposition: "kernel-control",
    why: "This factory branch creates the dedicated memory32 kernel linear memory before instantiation.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.getMemory::kernel-memory-return::return this.memory;",
    disposition: "kernel-read",
    why: "This documented unsafe trusted-embedder API intentionally exposes kernel memory for tests and low-level diagnostics.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.init::kernel-memory-escape::WebAssembly.instantiate(module, importObject)",
    disposition: "kernel-control",
    why: "The engine receives the dedicated memory only as the kernel module's reviewed env.memory import.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.initWithMemory::kernel-memory-escape::WebAssembly.instantiate(module, importObject)",
    disposition: "kernel-control",
    why: "The thread-worker path passes its explicitly supplied shared kernel memory only to kernel instantiation.",
  },
  {
    key:
      "host/src/host-adapter-manifest.ts::readKernelHostAdapterManifest::kernel-view::new DataView( memory.buffer, pointer, HOST_ADAPTER_MANIFEST_SIZE, )",
    disposition: "kernel-read",
    why: "The fixed-size adapter manifest is read synchronously after its complete kernel-memory range is checked.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.copyFrom::kernel-view::new Uint8Array(this.currentMemoryBuffer())",
    disposition: "scratch-core",
    why: "The lease reacquires the current buffer only after ownedRange proves allocation capacity and current-memory bounds.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.copyFrom::kernel-write::new Uint8Array(this.currentMemoryBuffer()).set( exactSource, destination.pointer, )",
    disposition: "scratch-core",
    why: "copyFrom independently checks the source slice and allocator-owned destination range before this synchronous write.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.copyOut::kernel-view::new Uint8Array( this.currentMemoryBuffer(), source.pointer, source.length, )",
    disposition: "scratch-core",
    why: "copyOut constructs only the owned range and immediately detaches it with slice before the lease ends.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.copyTo::kernel-view::new Uint8Array( this.currentMemoryBuffer(), source.pointer, source.length, )",
    disposition: "scratch-core",
    why: "copyTo constructs only the capacity-checked owned source range for one synchronous copy.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.dataView.refreshView::kernel-view::new DataView( buffer, range.pointer, range.length, )",
    disposition: "scratch-core",
    why: "The revocable DataView refresh repeats ownedRange after every possible memory-buffer replacement.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.fill::kernel-view::new Uint8Array(this.currentMemoryBuffer())",
    disposition: "scratch-core",
    why: "fill reacquires the current memory only after proving its exact allocator-owned destination range.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchLease.fill::kernel-write::new Uint8Array(this.currentMemoryBuffer()).fill( value, destination.pointer, destination.end, )",
    disposition: "scratch-core",
    why: "The fill start and end come from ownedRange, which proves both allocation capacity and current-memory bounds.",
  },
  {
    key:
      "host/src/kernel-scratch.ts::KernelScratchRegion.allocate::scratch-allocator-call::allocator(capacity)",
    disposition: "scratch-core",
    why: "This is the sole allocator invocation; the returned pointer remains private and is validated with its requested capacity.",
  },
  {
    key:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.beginLargeSpawnScratch::spawn-reservation-call::begin(this.toKernelPtr(blobLen))",
    disposition: "scratch-core",
    why: "This begins one transactional Rust-owned reservation before any pointer or capacity is observed.",
  },
  {
    key:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.beginLargeSpawnScratch::spawn-reservation-call::capacity(rawToken)",
    disposition: "scratch-core",
    why: "The capacity accessor is consumed only by reserveKernelScratchRegion while the matching transaction is active.",
  },
  {
    key:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.beginLargeSpawnScratch::spawn-reservation-call::pointer(rawToken)",
    disposition: "scratch-core",
    why: "The pointer accessor is consumed only by reserveKernelScratchRegion while the matching transaction is active.",
  },
  {
    key:
      "host/src/kernel-worker.ts::CentralizedKernelWorker.cancelLargeSpawnScratch::spawn-reservation-call::cancel(token)",
    disposition: "scratch-core",
    why: "This exact cleanup path releases a reservation that was begun but not consumed by the Rust spawn entry point.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.getMemoryBuffer::kernel-view-return::return new Uint8Array(this.memory.buffer);",
    disposition: "kernel-read",
    why: "This private full-memory view is tracked through every caller; only exact checked read and Rust-lent write sinks are admitted below.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.getMemoryBuffer::kernel-view::new Uint8Array(this.memory.buffer)",
    disposition: "kernel-read",
    why: "This private constructor feeds only the separately inventoried synchronous read and checked Rust-lent write helpers.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.hostFutexWait::kernel-view::new Int32Array(this.memory.buffer)",
    disposition: "kernel-control",
    why: "The futex word's lossless pointer, four-byte range, and alignment are checked before constructing this current-memory atomic view.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.hostFutexWake::kernel-view::new Int32Array(this.memory.buffer)",
    disposition: "kernel-control",
    why: "The futex word's lossless pointer, four-byte range, and alignment are checked before constructing this current-memory atomic view.",
  },
  {
    key:
      "host/src/kernel.ts::WasmPosixKernel.writeKernelBytes::kernel-write::this.getMemoryBuffer().set(exactBytes, range.pointer)",
    disposition: "rust-lent",
    why: "writeKernelBytes proves pointer, explicit capacity, current-memory bounds, and producer length before this write.",
  },
];

describe("kernel scratch static contract", () => {
  it("admits only reviewed kernel-memory views, writes, and allocator calls", () => {
    const result = auditWasmMemoryWrites({
      rootDir: repoRoot,
      sourceFiles: repositoryTypeScriptSourceFiles(repoRoot),
      ownershipSeeds,
      allowances: auditAllowances,
    });
    expect(formatAuditFailures(result)).toEqual([]);
  // This intentionally builds one TypeScript program for every repository
  // runtime source; keep CI headroom above the focused local 11–14 second run.
  }, 30_000);

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

    expect(publicLimitsHeader).toContain(
      "#include <bits/kandelo_limits.h>",
    );
    expect(publicLimitsHeader).toContain(
      "#define ARG_MAX KANDELO_POSIX_ARG_MAX_BYTES",
    );
    expect(publicLimitsHeader).toContain(
      "#define PATH_MAX KANDELO_POSIX_PATH_MAX_BYTES",
    );
    expect(publicLimitsHeader).toContain(
      "#define IOV_MAX KANDELO_POSIX_IOV_MAX",
    );

    expect(spawnContractHeader).toContain(
      "#include <bits/kandelo_limits.h>",
    );
    expect(spawnContractHeader).toContain(
      "#define WASM_POSIX_ARG_MAX_BYTES KANDELO_POSIX_ARG_MAX_BYTES",
    );
    expect(spawnContractHeader).toContain(
      "#define WASM_POSIX_PATH_MAX_BYTES KANDELO_POSIX_PATH_MAX_BYTES",
    );
    const exactSpawnWireMacros = [
      ["WASM_POSIX_SYS_SPAWN", HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN],
      [
        "WASM_POSIX_SPAWN_STRING_OFFSET_BYTES",
        SPAWN_WIRE_STRING_OFFSET_BYTES,
      ],
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
      [
        "WASM_POSIX_SPAWN_ACTION_NEWFD_OFFSET",
        SPAWN_WIRE_ACTION_NEWFD_OFFSET,
      ],
      [
        "WASM_POSIX_SPAWN_ACTION_PATH_OFF_OFFSET",
        SPAWN_WIRE_ACTION_PATH_OFF_OFFSET,
      ],
      [
        "WASM_POSIX_SPAWN_ACTION_PATH_LEN_OFFSET",
        SPAWN_WIRE_ACTION_PATH_LEN_OFFSET,
      ],
      [
        "WASM_POSIX_SPAWN_ACTION_OFLAG_OFFSET",
        SPAWN_WIRE_ACTION_OFLAG_OFFSET,
      ],
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
      'cp "$OVERLAY_DIR/include/bits/kandelo_limits.h" \\\n'
        + '    "$MUSL_DIR/include/bits/kandelo_limits.h"',
    );
  });
});
