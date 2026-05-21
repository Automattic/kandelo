# Rust-Owned Host Logic Migration Plan

Date: 2026-05-20

## Context

The host must stay responsible for browser and Node platform primitives: Workers, WebAssembly instantiation and memory ownership, `SharedArrayBuffer`/`Atomics`, timers and event-loop scheduling, `postMessage`, fetch/OPFS/IndexedDB/service-worker bridges, canvas/audio/terminal presentation, and Node/browser filesystem and networking APIs. The migration target is the portable, deterministic contract logic currently duplicated in TypeScript: ABI constants, syscall metadata, kernel export expectations, process/resource ownership decisions, and policy that the Rust kernel can enforce without adding a per-syscall JS/Wasm round trip.

## Responsibility Map

| Area | Current owner | Current TS host logic | Rust/kernel ownership opportunity |
|---|---|---|---|
| Kernel boot | `kernel-worker.ts`, Node/browser worker entries | Instantiate kernel Wasm, read `__abi_version`, call `kernel_set_mode`, allocate scratch, wire callbacks | Rust can publish a compact host-adapter manifest describing ABI version, required exports/imports, protocol features, and channel layout. JS still instantiates and validates. |
| Process worker lifecycle | `node-kernel-worker-entry.ts`, `browser-kernel-worker-entry.ts`, `worker-main.ts` | Allocate `WebAssembly.Memory`, Workers, channel offsets, fork/exec/clone Worker setup, crash safety net, module ABI checks | Kernel should own process table state, pid allocation semantics, exec/fork/spawn process descriptors, cleanup invariants. JS must keep Worker/memory creation and crash observation. |
| Syscall channel marshalling | `kernel-worker.ts`, `worker-main.ts`, `wasi-shim.ts`, `constants.ts` | Hardcoded channel offsets, status codes, syscall numbers, struct sizes, pointer argument descriptors, scatter/gather special cases | Channel layout, status codes, struct sizes, syscall names/numbers, and host-intercepted syscall metadata should be generated from `crates/shared`/`xtask dump-abi`. Pointer-copy descriptors are a candidate if they can be generated without adding runtime Wasm calls. |
| Blocking and wakeups | `kernel-worker.ts` | `Atomics.waitAsync`, timers, retry queues, pipe/socket reader/writer maps, poll/select/epoll retry timing | Kernel already emits wakeup events for pipe state. More readiness policy can move into Rust event metadata, but JS must keep the actual wait/timer scheduling. |
| `poll`/`select`/`epoll` | `kernel-worker.ts` plus Rust syscall handlers | Host infers some wakeups and mirrors epoll interest lists because Chrome crashes on `epoll_pwait` kernel path | Rust should own readiness semantics and expose targeted wakeup/event data. Host mirror stays while V8 workaround exists. |
| IPC | TS shared tables plus Rust IPC/mqueue modules | Some SysV IPC and mqueue blocking/resource cleanup still coordinated host-side | Move pure IPC tables and cleanup into Rust kernel so `remove_process` owns lifetime. JS only wakes blocked channels when needed. |
| VFS routing and backends | `vfs/*`, `kernel.ts`, Rust syscalls | Mount selection, backend access, metadata overlay, host/node path sandboxing, browser OPFS/lazy fetch | Platform calls must stay JS. Permission and policy decisions should move kernel-side where possible; mount table metadata can become a Rust-owned contract consumed by JS adapters. |
| Procfs/process inspection | Rust `procfs.rs`, TS `parseProcSnapshots` | Rust generates `/proc` content and binary process snapshots; TS decodes for UI | Keep formatting/kernel state in Rust. Generate the binary snapshot schema/constants from Rust metadata. |
| ABI/versioning | `crates/shared`, `dump_abi.rs`, `abi/snapshot.json`, TS hardcoded readers | Rust snapshot covers ABI, but TS still repeats some constants and export names | Generate TS bindings from `dump_abi` and make check-abi validate them. Add runtime manifest validation later. |
| Browser integrations | browser worker entry, framebuffer/audio/service worker code | HTTP bridge, framebuffer registry mirroring, mouse/audio drain, lazy VFS materialization | Stay JS. Rust owns device semantics and bounded queues; JS presents or injects platform events. |

## Classification

| Classification | Logic | Rationale |
|---|---|---|
| Must remain JS | Worker creation/termination, `WebAssembly.compile/instantiate`, `WebAssembly.Memory`, SharedArrayBuffer allocation, `Atomics.waitAsync`, `postMessage`, `fetch`, OPFS/IndexedDB/service-worker bridges, DOM/canvas/audio/xterm, Node `fs`/`net`/`dns`, browser VFS lazy fetches | These are host/platform primitives unavailable or impractical inside synchronous kernel Wasm. |
| Good Rust candidate | ABI constants and generated TS/C bindings; syscall number/name metadata; host-intercepted syscall metadata; marshalled struct sizes/offsets; channel layout/status constants; kernel export/import manifest; process snapshot schema; process lifecycle invariants; SysV IPC and POSIX mqueue tables; VFS permission/policy checks; procfs formatting | Portable, deterministic, ABI-relevant, security-relevant, and already naturally owned by the kernel/shared crate. |
| Maybe Rust later | Pointer argument marshalling descriptors; poll/select readiness bookkeeping; epoll interest handling; mount specification metadata; thread channel layout policy; host adapter capability negotiation; shebang/PATH launch metadata | Worth moving only if it reduces duplicated ABI logic without making syscall hot paths worse or fighting host-only constraints. |
| Do not move | Syscall hot-path micro-optimizations, DataView caching, per-syscall arg-count shortcuts, conditional wakeup drains, V8 epoll workaround removal without browser evidence, Worker boot redesign, platform filesystem/network implementations | Prior benchmarking says these either regress performance or are platform-bound. Some are temporary workarounds but not safe first migrations. |

## Prioritized Migration Chunks

1. **Generated TS ABI constants from `crates/shared`/`xtask dump-abi`.**
   - Generate `host/src/generated/abi.ts` with ABI version, channel offsets/sizes, status codes, host-intercepted syscall numbers, syscall numbers already in `shared::Syscall`, and marshalled struct sizes.
   - Use it in `constants.ts`, `kernel-worker.ts`, `kernel.ts`, and the simplest worker-channel writers.
   - Keep legacy constants that are not yet in `shared::Syscall` local for now.

2. **Expand shared syscall metadata coverage.**
   - Move currently untracked syscall numbers used by TS (`clone`, `futex`, `epoll`, `mq`, SysV IPC, thread cancel, exit_group, etc.) into Rust/shared metadata.
   - Regenerate snapshot and TS bindings.
   - Migrate TS switches/sets to imported constants.

3. **Rust-defined host adapter manifest.**
   - Add kernel exports for a compact manifest: ABI version, required host adapter protocol version, required exports/imports, optional exports, required worker protocol features, channel layout checksum/version.
   - Have `CentralizedKernelWorker.init` validate it before `kernel_set_mode`.
   - Keep behavior unchanged except earlier, clearer boot errors.

4. **Process lifecycle cleanup consolidation.**
   - Audit TS maps (`childToParent`, `parentToChildren`, zombie/reap guards, thread maps, shm mappings, pending timers) against Rust process table ownership.
   - Move pure lifecycle state into Rust where Worker identity is not needed.
   - JS remains responsible for terminating Workers and observing crashes.

5. **IPC/resource cleanup in Rust.**
   - Move remaining host-side SysV IPC/mqueue tables or cleanup hooks into Rust-owned state.
   - Expose only wakeup/event notifications to JS.

6. **Readiness metadata improvements.**
   - Replace broad host inference with kernel-emitted readiness events covering pipe/socket/poll/select cases.
   - Keep JS retry queues and timers; avoid extra calls per syscall.

7. **VFS policy split.**
   - Keep backend I/O in JS.
   - Move permission/policy decisions into Rust where the kernel has process uid/gid/umask/fd context.
   - Make mount/read-only metadata explicit and ABI/versioned if guest-visible.

## Risks And Performance Concerns

| Risk | Concern | Mitigation |
|---|---|---|
| Hot path overhead | Moving marshalling decisions into runtime Rust calls could add a Wasm round trip per syscall. | Prefer build-time generated TS tables from Rust metadata for host-side copy decisions. |
| ABI drift | TS constants currently drift silently from `crates/shared`. | Generated TS plus `check-abi-version.sh` validation makes drift fail in CI. |
| Browser/Node parity | Host lifecycle changes often break one side only. | Migrate shared files first, then update both worker entries in the same PR for lifecycle changes. |
| Snapshot churn | Adding snapshot coverage can look like ABI change even when runtime bytes do not change. | Keep first slice generated from existing snapshot/shared data. For new coverage, follow `docs/abi-versioning.md` and classify whether an ABI bump is required. |
| V8/browser workarounds | Epoll and wake scheduling have browser-specific failure modes. | Do not remove TS workarounds until browser smoke/Playwright evidence exists. |
| Legacy binaries | Older images depend on stable ABI pins and first-party host adapters. | Keep strict `__abi_version` checks; use additive manifests/bindings without weakening compatibility checks. |

## ABI And Versioning Implications

- First slice should not change runtime ABI: it generates TypeScript from existing Rust/shared metadata and existing ABI snapshot data.
- If a later chunk adds kernel Wasm exports for a host adapter manifest, `abi/snapshot.json` must be regenerated. New exports are additive-compatible under `docs/abi-versioning.md` if no existing export/signature changes.
- If shared syscall metadata is expanded for already-existing syscall numbers, decide whether the snapshot generator’s coverage change itself requires an ABI bump. At minimum regenerate `abi/snapshot.json` and document why any no-bump change is compatible.
- Any change to channel layout, status values, signal delivery area, marshalled struct layout, syscall numbers, asyncify slots, custom section names, process expected globals, or existing kernel exports must follow the ABI bump policy.

## Tests Required Per Chunk

| Chunk | Tests |
|---|---|
| Generated TS ABI constants | `cargo test -p xtask --target <host> dump_abi`, `bash scripts/check-abi-version.sh`, `cd host && npx vitest run test/generated-abi.test.ts`, `cd host && npm run build`. |
| Expanded syscall metadata | Rust unit tests for metadata completeness, `bash scripts/check-abi-version.sh update` then check, vitest for migrated switches, targeted syscall integration tests. |
| Host adapter manifest | Rust unit tests for manifest serialization, ABI snapshot check, vitest boot tests for valid/missing/incompatible manifest, Node and browser worker-entry smoke if boot validation path changes. |
| Process lifecycle cleanup | Existing fork/exec/spawn/clone/wait tests, crash/trap tests, browser parity smoke where worker entry changes. |
| IPC/resource cleanup | SysV IPC and mqueue vitest/e2e, Rust cleanup tests, process-exit cleanup regression tests. |
| Readiness metadata | Pipe/socket/poll/select/ppoll/pselect tests, WordPress/nginx/browser bridge smoke if browser wake path changes, performance comparison on syscall and app workloads before removing TS inference. |
| VFS policy split | VFS unit tests, uid/gid/permission tests, host-fs metadata tests, default mount tests, Node and browser parity tests. |

## First Slice Decision

Implement chunk 1 first. It removes hand-maintained TS constants from the host runtime without changing Worker boot or syscall behavior, keeps platform boundaries intact, and makes future ABI metadata moves cheaper. It rejects runtime reflection for the hot path and instead uses build-time generated TypeScript checked by the existing ABI script.
