# Rust-Owned Host Logic Migration Plan

Date: 2026-05-20

## Context

The host must stay responsible for browser and Node platform primitives: Workers, WebAssembly instantiation and memory ownership, `SharedArrayBuffer`/`Atomics`, timers and event-loop scheduling, `postMessage`, fetch/OPFS/IndexedDB/service-worker bridges, canvas/audio/terminal presentation, and Node/browser filesystem and networking APIs. The migration target is the portable, deterministic contract logic currently duplicated in TypeScript: ABI constants, syscall metadata, kernel export expectations, process/resource ownership decisions, and policy that the Rust kernel can enforce without adding a per-syscall JS/Wasm round trip.

## Responsibility Map

| Area | Current owner | Current TS host logic | Rust/kernel ownership opportunity |
|---|---|---|---|
| Kernel boot | `kernel-worker.ts`, Node/browser worker entries | Instantiate kernel Wasm, read `__abi_version`, allocate scratch, wire callbacks | Rust can publish a compact host-adapter manifest describing ABI version, required exports/imports, protocol features, and channel layout. JS still instantiates and validates. |
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
   - Keep constants that are not yet in `shared::Syscall` local for now.

2. **Expand shared syscall metadata coverage.**
   - Move currently untracked syscall numbers used by TS (`clone`, `futex`, `epoll`, `mq`, SysV IPC, thread cancel, exit_group, etc.) into Rust/shared metadata.
   - Regenerate snapshot and TS bindings.
   - Migrate TS switches/sets to imported constants.

3. **Rust-defined host adapter manifest.**
   - Add kernel exports for a compact manifest: ABI version, required host adapter protocol version, required exports/imports, optional exports, required worker protocol features, channel layout checksum/version.
   - Have `CentralizedKernelWorker.init` validate it before accepting the kernel instance.
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
| Version-pinned binaries | Images can depend on stable ABI pins and first-party host adapters. | Keep strict `__abi_version` checks; use additive manifests/bindings without weakening compatibility checks. |

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

## Living Migration Backlog

Updated: 2026-05-28

This section is the handoff list for follow-up work. Keep it current as each
slice lands so the project does not lose track of what was intentionally left
in TypeScript and what still has a Rust-owned metadata or kernel-ownership
path.

| Status | Chunk | Scope | Acceptance criteria | Required checks |
|---|---|---|---|---|
| Done | Generated TS ABI constants | `host/src/generated/abi.ts` is generated from `crates/shared`/`xtask dump-abi`; host code consumes generated ABI version, channel layout, status codes, core syscall numbers, host-intercepted syscall numbers, and struct sizes. | No hand-maintained TS copies for those ABI constants. `check-abi-version.sh` checks generated TS drift. | `cargo test -p xtask --target <host> dump_abi`; `bash scripts/check-abi-version.sh`; focused generated ABI vitest; `npm --prefix host run build`. |
| Done / PR #534 | Rust-owned syscall marshalling descriptors | `crates/shared::host_abi` owns simple pointer-argument descriptors; `dump-abi` generates `SYSCALL_ARGS`; TS host keeps memory copies but reads generated descriptors. | The old TS `SYSCALL_ARGS` table and syscall-number size switches are gone. `poll`/`ppoll`, SysV message prefix, `semop`, and `msgrcv` copy-back adjustments are metadata fields. Nested-pointer syscalls (`readv`/`writev`/preadv/pwritev) stay on dedicated TS paths. | Shared unit tests for descriptor ordering/high-risk sizes/nested-pointer exclusion; xtask ABI tests; `bash scripts/check-abi-version.sh`; generated ABI vitest; host build; kernel lib tests. |
| Done / PR #534 follow-up | Extended host-visible syscall numbers and names | Add Rust/shared metadata for ABI-visible syscall numbers still hardcoded in host TS but not currently in `shared::Syscall`, such as `getrandom`, `clone`, `futex`, `ppoll`, `pselect6`, epoll, `exit_group`, `waitid`, `msync`, preadv/pwritev, mqueue, SysV IPC, `sched_yield`, `fallocate`, timers, and `thread_cancel`. Generate TS bindings, logging names, and snapshot coverage. | Host TS no longer defines literal syscall numbers for this set, and syscall trace names are generated from Rust-owned metadata. Existing `HOST_INTERCEPTED_SYSCALLS` remains separate for fork/exec/spawn because those are caught before normal dispatch. Public behavior unchanged. | Rust metadata uniqueness tests; xtask compatibility tests; `bash scripts/check-abi-version.sh update` + check; generated ABI vitest; host build; kernel lib tests. |
| Done / stacked PR | Rust-defined host adapter manifest | Add a compact Rust-defined manifest describing ABI version, required host adapter protocol version, required/optional exports, worker protocol features, and channel metadata. JS validates it during kernel boot. | Boot fails earlier with clear errors when the host/kernel contract is incompatible. No Worker creation or Wasm instantiation moves out of JS. | Rust manifest serialization tests; ABI snapshot check; vitest boot validation cases; Node/browser worker-entry smoke if boot code changes. |
| Implementation complete / ABI 43 batch; validation pending | Process lifecycle cleanup consolidation | Rust `ProcessTable` owns parent lookup, wait-target matching, wait-status derivation, host-crash zombie marking, authorized child reaping, thread-exit clear-TID metadata, SysV shared-memory attachment metadata, host-bridged TCP listener target policy, and process-owned host timer cleanup metadata. TypeScript keeps blocked waiter queues, Worker/memory cleanup, platform timer handles, process-memory writes and futex wakeups, thread-channel allocation/free-list state, and actual TCP server objects because those are host primitives. | Kernel owns lifecycle invariants that do not require Worker identity; JavaScript owns Worker termination, memory objects, crash observation, channel allocation, and platform callbacks. | ProcessTable unit tests; fork/exec/spawn/clone/wait tests; crash/trap tests; Node and browser worker smoke before a broad completion claim. |
| Implementation complete / ABI 43 batch; validation pending | IPC/resource cleanup in Rust | Rust `Process` records `shmat` address-to-segment metadata, records child attachments during transactional fork materialization, clears them across exec setup, and detaches live mappings from `remove_process()`. Rust owns mqueue tables and process cleanup. TypeScript still copies bytes between guest memory and kernel SysV segments and drains mqueue notifications because only the host can address guest `Memory` and wake host channels. | `remove_process()` owns IPC attachment cleanup; JavaScript handles guest-memory transfer, signal/notification delivery, and host primitive wake/schedule work. | SysV IPC and mqueue Rust tests plus host integration coverage for blocking, fork inheritance, exec, and cleanup. |
| Metadata slice complete / ABI 43 batch; browser and performance evidence deferred | Readiness metadata improvements | Rust/shared owns the packed kernel wake-event layout and reason bits, `poll`/`epoll` event bits, and `fd_set` sizing consumed through generated bindings. Pipe-readable and pipe-writable events target matching ordinary `poll`/`ppoll` retries by captured pipe index before the broad fallback; signal-safe `ppoll`, `select`/`pselect6` targeting, and epoll mirror removal remain deferred. | JavaScript owns timers, retry queues, `Atomics.waitAsync`, and the broad fallback for wait classes without exact identities. Metadata consumption and targeting add no host-to-kernel call. | Rust metadata and wakeup serialization tests; generated ABI Vitest; pipe/socket/poll/select/ppoll/pselect tests; browser bridge smoke and performance comparison before removing fallback logic. |
| Metadata slice complete / ABI 43 batch; policy design deferred | VFS policy split | Rust/shared owns the VFS-visible open and `*at` flags, descriptor and `fcntl` values, access modes, file modes, directory-entry types, and seek constants generated for shared Node/browser host consumers and the WebAssembly System Interface (WASI) shim. Backend I/O, Origin Private File System (OPFS), Node `fs`, and lazy archive materialization remain JavaScript-owned. The standalone OPFS worker and vendored SharedFS keep entry-point/vendor-local copies; Homebrew-specific adapters remain deferred to their dedicated batch. | Generated metadata centralizes Kandelo's existing guest ABI without making a broader Linux-compatibility promise. Kernel uid/gid/umask checks remain authoritative; mount/read-only enforcement needs an explicit checked contract. | Generated ABI tests and snapshot check; VFS, uid/gid/permission, host-fs metadata, default mount, Node worker, and browser worker tests before broader policy claims. |
| Done / ABI 43 batch | Procfs/process snapshot schema metadata | `crates/shared::process_snapshot_wire` owns the packed binary layout, `dump-abi` publishes it in `abi/snapshot.json` and generated TypeScript constants, and `parseProcSnapshots` consumes those offsets with strict bounds checks. | TypeScript no longer hand-decodes undocumented offsets for kernel process snapshot data. Procfs text formatting remains Rust-owned. | Rust process-snapshot wire tests; generated ABI Vitest; host snapshot parsing tests. |

Deferral rule: if a chunk would move browser/Node primitives, add runtime JS
evaluation, or add a Wasm call to every syscall without removing meaningful
ABI/security complexity, leave it in JS and document the reason here.

## Remaining Rust/host boundary

The metadata batch exhausts the changes that are safe to treat as mechanical
Rust ownership moves. Remaining candidates need a specific design or evidence
gate:

- Worker creation, `WebAssembly.Memory`, thread-channel allocation, and channel
  free-list ownership are host primitives.
- SysV shared-memory copies and mqueue notification delivery require JavaScript
  access to process memory and channel wakeups.
- More precise `select`/`pselect6` targeting and epoll mirror removal require
  browser smoke coverage and performance data because the broad fallback also
  protects signal-mask-swapping waits and engine-specific behavior.
- Mount/read-only enforcement needs an explicit mount-table contract shared by
  Rust and the Node/browser VFS backends before adapters can act as pure
  platform executors.

Resume with design documentation and tests for one of those contracts before
moving more logic across the Rust/TypeScript boundary.

## Additional candidate work

These are not approved migration chunks. Each needs a focused design, tests,
and explicit host/API-surface tradeoffs before implementation.

| Candidate | Why consider it | Boundary notes |
|---|---|---|
| Centralized advisory file-lock ownership with native lock bridge | Rust now owns Kandelo's `fcntl`/`flock` state, stable file and open-file-description identity, conflict semantics, and lifecycle cleanup. A native bridge remains an explicitly separate design question for coordinating host-backed files with programs outside Kandelo. See `docs/plans/2026-06-01-centralized-advisory-file-lock-native-bridge-plan.md`. | Kandelo has one centralized kernel target; do not preserve earlier decentralized research behavior as a compatibility concern. Browser/memfs hosts have no native-lock surface. Any Node/native bridge must preserve Rust as the sole Kandelo lock authority and account for host operating-system ownership rules. |
| Nested syscall marshalling descriptors | TypeScript special-cases nested process-memory layouts such as `readv`/`writev`, `sendmsg`/`recvmsg`, `fcntl` lock structs, `semctl`, `select`/`pselect6`, `ppoll`, and selected `ioctl` payloads. Shared metadata could keep future adapters from reimplementing that ABI knowledge. | Copies stay in the host adapter because they access process `WebAssembly.Memory`. Prefer generated tables or a reusable Rust host-adapter crate over a runtime kernel call for every syscall. |
| WebAssembly System Interface Preview 1 translation | `host/src/wasi-shim.ts` maps the WebAssembly System Interface (WASI) fd/path/poll/socket/errno surfaces onto Kandelo's POSIX syscall ABI. Non-JavaScript integrations would otherwise need to port it. | This likely belongs in a Rust host-adapter crate rather than the process-table kernel. The host still supplies module-memory access and syscall submission. |
| Exec/spawn launch planning | TypeScript reads argv/envp from process memory, resolves relative exec paths, handles `execveat(AT_EMPTY_PATH)`, performs spawn preflight, and handles shebang recursion in both worker entries. Rust could own a launch-plan descriptor so hosts only resolve/load bytes and instantiate. | Worker creation, module compilation, and byte loading remain host primitives. A design must preserve `posix_spawnp` file actions exactly once and `execvpe`/`PATH` retry semantics. |
| Mount/read-only VFS policy contract | The mount spec carries `readonly`, but enforcement and mount routing are host-side. Rust owns process uid/gid/umask and permission checks from host stat metadata. | Host VFS backends remain platform executors. Rust needs a versioned Node/browser contract for read-only enforcement, mount flags, path-to-mount identity, and `/proc/mounts` parity. |
| File-backed `mmap`/`msync` descriptors | TypeScript populates file-backed mappings after `mmap`, tracks `MAP_SHARED` regions, flushes `msync`, and cleans tracking on `munmap`. Rust owns virtual-address allocation and descriptor state, so it could own mapping descriptors and writeback policy. | Guest-memory copies and host file I/O remain host-side. The kernel would need to emit enough mapping/writeback commands for adapters to copy without duplicating policy. |
| Readiness, `select`/`pselect6`, and `epoll` descriptors | Rust emits targeted wakeup metadata, but TypeScript owns retry queues, timeout policy, signal-safe wake grace, and an epoll interest mirror. | Timers and `Atomics.waitAsync` remain host-side. More precise descriptors need browser smoke and performance data before removing broad fallbacks or the epoll mirror. |
| Signal-delivery event ABI | Rust owns signal state, but TypeScript copies delivery records into process channels, wakes blocked peers after `kill`, handles signal-death follow-up, and drains mqueue notification signals. | The host must wake channels and touch process memory. Rust/shared could define a compact event/command ABI so adapters run one generic delivery loop instead of copying TypeScript control flow. |
| Futex and cancellation wait descriptors | Futex waits and deferred `pthread_cancel` alter host wait state (`Atomics.waitAsync`, timers, pipe-reader registrations, and poll/select retries), while validation and wake/cancel targets are kernel semantics. | Actual waits stay host-side because futex addresses are in process memory. A Rust-owned descriptor/event contract is useful only if it reduces adapter-specific logic without adding hot-path round trips. |
| Virtual network-interface `ioctl` metadata | TypeScript currently supplies Linux-specific `SIOCGIFCONF`, `SIOCGIFHWADDR`, and `SIOCGIFADDR` layouts. | This is not an active migration goal: these interfaces are outside POSIX, and broad Linux compatibility is out of scope. Keep that boundary explicit; reconsider only if a package-independent Kandelo contract requires a portable interface inventory. |
| Device queue/surface contracts | Rust owns much of `/dev/fb0`, `/dev/input/mice`, and `/dev/dsp` semantics and their bounded queues. Remaining TypeScript surfaces can be audited for presentation-only code versus kernel policy. | DOM, canvas, Web Audio, and input-event collection stay host-side. More kernel-owned device contracts are useful only where they shrink adapter behavior without moving presentation into Rust. |
