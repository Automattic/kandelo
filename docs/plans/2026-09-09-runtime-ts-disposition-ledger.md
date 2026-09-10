# Runtime TS/JS Disposition Ledger

> Every in-scope runtime TypeScript area, with a verdict and the reason for
> it — **including the reasons for keeping things**, which are the ones most
> likely to be lost or quietly reversed later.
>
> Written 2026-09-09. Companion to
> `2026-09-09-rust-first-value-plan.md` (why, and in what order) and
> `2026-09-09-whole-kernel-rust-migration-census.md` (the measurements).
> Scope: the runtime only — everything required to run the kernel on a host,
> including fork capture/replay. Toolchain, benchmarks, and the demo UI are
> out of scope by direction.

## Verdict key

| verdict | meaning |
|---|---|
| **MIGRATE** | the logic moves into Rust; the TS goes away |
| **ELIMINATE** | disappears entirely — it exists only to serve something being removed |
| **KEEP** | genuine host adapter; stays in TypeScript, with the reason recorded below |
| **SPLIT** | part migrates, part stays; both parts named |

## The test used for KEEP

A thing stays in the host only if **both** hold:

1. **Wasm cannot express it.** It requires a JS-API act or a real host
   object — constructing a Worker or an `Instance`, growing a `Memory`,
   `Atomics.wait`, touching a socket/canvas/audio device, or copying between
   two `Memory` objects the kernel does not own.
2. **It cannot be pushed into the kernel module instead.** Being awkward,
   large, or currently-working is not a reason.

Anything failing either test is MIGRATE, regardless of how settled it looks.
A browser engine *bug* is a compatibility boundary — documented, scoped, and
periodically re-checked — never a floor. The campaign has now inherited a
"floor" that turned out to be stale **four times**: wasmtime-exnref; the E1
GC blockers (disproved by K0 P1/P2); the V8 `epoll_pwait` crash (disproved
by K0c); and `netif.rs:11-13`, which states as fact that a process-memory
address is one "the kernel's separate Wasm instance cannot itself reach" —
false, since `host_proc_read_bytes` reaches it from seven sites today.
All four were assertions no one had re-tested.

---

## 1. Ledger

### `host/src/kernel-worker.ts` — 34,875 lines

| region | lines | verdict | destination / reason |
|---|---|---|---|
| Blocking-wait scheduler (poll/epoll/select/futex/sleep/retry) | 4,532 | **MIGRATE** | extend `blocked_retry.rs` + `wakeup.rs`. Rust already computes readiness; TS owns only *waiting*. 21 state containers. `blocked_retry.rs:1` calls itself "host-driven" — that is the thing being fixed |
| — the epoll interest-list mirror within it | ~425 + 10 call sites | **ELIMINATE** | a **second authority** for state `Process.epolls[].interests` already owns. Its sole justification — a V8 shared-memory crash — **did not reproduce on 2026-09-09** on Node, Chromium 151, or WebKit 26.5, on the main thread or in a dedicated Worker with a peer sharing the kernel's `SharedArrayBuffer`. Not a self-contained deletion: it is read/written from fork inheritance, exec fd-mirror pruning, child rollback, and teardown, so it lands inside the scheduler migration |
| Shared-mapping page cache | 3,027 | **MIGRATE** | `memory.rs`. Dirty-page sets, per-process snapshots, version counters, dev/ino revalidation before writeback, `F_DUPFD_CLOEXEC` writeback dups — POSIX VM semantics, not adapter metadata |
| Process-lifecycle transitions | ~3,000 | **MIGRATE** | `process_table.rs`, `spawn.rs`. Rust already owns pgid/sid/stop/continue/zombie state; TS owns only the transitions the worker sees |
| `#handleSyscallInner` | 2,261 | **ELIMINATE** | it *is* the pre/post-dispatch split-half. Pre-dispatch dissolves into `proc_read_bytes`; post-dispatch into the Rust scheduler and mapping table. Nothing to relocate |
| IPC / socket marshalling | ~2,100 | **ELIMINATE** | guest⇄scratch copying only; the queues are already Rust (`ipc.rs`, `mqueue.rs`). Replaced by `proc_read_bytes`/`proc_write_bytes` |
| SysV shm mappings + synthetic mem | 1,102 | **MIGRATE** | `ipc.rs` already owns the segments |
| Networking pumps + registries | ~1,600 | **SPLIT** | registries → `socket.rs` (**MIGRATE**); raw byte pumping on a host socket → **KEEP** |
| Transport: scratch views, kernel-entry gate | ~4,000 | **KEEP** | see §2.1 |
| `#createTestAuthority` | 1,444 | **ELIMINATE** | test scaffolding compiled into a production file. Extract or delete; it is not kernel code |
| Preamble: types, errno constants, argument validators | 2,744 | **SPLIT** | validators guard the JS↔wasm pointer boundary → **KEEP**; errno/type mirrors → **ELIMINATE** with the ABI surface |

### Process orchestration — 9,107 lines

| file | lines | verdict | reason |
|---|---|---|---|
| `browser-kernel-worker-entry.ts` | 4,847 | **MIGRATE** | **54 functions are duplicated verbatim between these two files** — `handleFork`, `handleVfork`, `handleOrdinaryFork`, `handleClone`, `handleExec`, `handleSpawn`, `handlePosixSpawn`, `handleExit`, `handleThreadExit`, `containVforkAddressSpace`, `completeVforkGenerationTeardown`, `detachExactProcessGeneration`, `resolveExecutableForLaunch`, … One algorithm, written twice, in the language where parity bugs live |
| `node-kernel-worker-entry.ts` | 4,260 | **MIGRATE** | same set |
| — `parseShebang` (both copies) | ~40 | **ELIMINATE** | POSIX `#!` parsing already exists in `exec_target.rs`, exported as `kernel_exec_target_resolve_shebang` and used by host-native. Two hand-rolled TS copies with their own `MAX_SHEBANG_DEPTH = 4` is a triple authority |
| residue: Worker construction, `Memory` construction, `postMessage` | small | **KEEP** | §2.2 |

### `host/src/worker-main.ts` — 7,476 lines (process-side worker)

| part | verdict | reason |
|---|---|---|
| dlopen reader/writer lock protocol (`DLOPEN_LOCK_*`, per-pointer-width offset constants) | **MIGRATE** | a synchronization protocol with hand-maintained `_WASM32`/`_WASM64` offset pairs — exactly what Rust's type system removes |
| `patchWasmForThread` | **MIGRATE** | binary rewriting of a wasm module in TypeScript |
| `encodeStartupMetadata` + `STARTUP_E*` | **MIGRATE** | a wire format with its own errno set, encoded in TS. Belongs with the ABI in `crates/shared` |
| `verifyProgramAbi`, `hasCompleteForkInstrumentation`, custom-section reads | **MIGRATE** | custom-section parsing is deterministic computation over bytes |
| `continuationMmap`/`Munmap`, `alignUp` | **MIGRATE** | memory arithmetic |
| `buildImportObject` / `buildKernelImports` / `buildDlopenImports` | **KEEP** | constructing a JS import object is a JS-API act |
| `setupChannelBase`, thread spawn | **KEEP** | §2.2 |

### `host/src/dylink.ts` + `dylink-fork-archive.ts` — 6,340 lines

| part | verdict | reason |
|---|---|---|
| `parseDylinkSection`, symbol scoping/resolution, GOT maintenance, dependency graph, memory/table allocation arithmetic, the dlopen fork-activation state machine | **MIGRATE** | a complete `ld.so` in TypeScript. Deterministic computation with POSIX-visible semantics. **host-native has no linker at all**, so this *gains* native `dlopen` rather than relocating a capability — the clearest V1 win after the duplicated entries |
| **Eight** JS-API act kinds at 16 call sites — `new WebAssembly.Instance`, `new WebAssembly.Module`, `Memory.grow`/`Table.grow`, `new WebAssembly.Tag`, table get/set, `new WebAssembly.Global` + `Global.value` get/set, and the stateful counting-`Proxy` import object | **KEEP (executor only)** | §2.2. **Corrected 2026-09-09 from "four" — the fifth disproved floor, and this one was authored here.** All eight have wasmtime-48 equivalents and collapse into one typed `LinkAct` executor, so the *planner* is still pure Rust |

### `host/src/vfs/**` — 22,599 lines

> **CORRECTED 2026-09-09 by the K8 grounding.** This section treated
> `memory-fs.ts` + `sharedfs-vendor.ts` (11,950 lines) as MIGRATE in bulk. That
> is wrong. **Only ~556 lines (`memory-fs.ts:7430-7985`, the `FileSystemBackend`
> surface) stop being a guest-visible mount.** The rest survives with a
> different job: `memory-fs.ts` is the **image writer** (`saveImage:7029`) and
> the host fetch authority — for `tools/mkrootfs`, `images/vfs/scripts`, and
> crucially the **runtime** `export_rootfs_image` path on *both* hosts
> (`browser-kernel-worker-entry.ts:4038`, `node-…:3973` →
> `rootfs-overlay-export.ts`). `sharedfs-vendor.ts` survives essentially whole,
> because its read helpers back the write path; it leaves only with the
> toolchain campaign. K8's real removal is **~1,500-2,500 lines, not ~12,000** —
> Phase 5 already took `/`.

| part | lines | verdict | reason |
|---|---|---|---|
| `sharedfs-vendor.ts` + `memory-fs.ts` as **runtime FS authority** | 11,950 → **~556** | **SPLIT (corrected)** | they are the VFS image **format owner**, and images are stamped with the guest ABI (`mkrootfs --kernel-abi`). `sffs.rs` is the Rust reader for that exact format and is wired to nothing. Inverting this is what decouples images from the ABI (**V3**) |
| tar/zip/manifest parsers, lazy-tree materialization | ~3,500 | **MIGRATE** | byte parsing; `zip.rs` already exists in Rust |
| `/dev/shm` backing | — | **MIGRATE** | the one host-backed subtree inside the kernel devfs namespace (`syscalls.rs:2068`, `:2122`). Folds into an in-kernel shmfs generalized from `tmpfs.rs` |
| OPFS worker/channel/handles, browser lazy fetcher, `host-fs.ts` | ~3,000 | **KEEP** | §2.3 — real host byte stores |
| mount specs, image loading orchestration | ~2,000 | **SPLIT** | policy → Rust; handle acquisition → KEEP |
| boot-time image *assembly* helpers | ~2,000 | **KEEP (scope)** | toolchain-adjacent; revisit in the toolchain campaign |

### `host/src/kernel.ts` — 4,962 lines (the `env` import object)

**SPLIT.** The 85 `host_*` bodies are judged individually by the concept
table in the value plan §4: 25 name-taking FS imports **ELIMINATE** (the
host must open a file, never resolve a name); socket/device/byte/wait/
clock/cross-memory bodies **KEEP**. The file shrinks with the contract
rather than migrating.

### Pure translation and encode/decode

| file | lines | verdict | reason |
|---|---|---|---|
| `wasi-shim.ts` | 1,625 | **MIGRATE** | WASI Preview 1 ↔ POSIX. **Requires zero host capability** (verified: no `host_`, no ABI, `EXPECTED_HOST_IMPORT_COUNT` untouched). **Destination corrected 2026-09-09:** it is *guest-side*, not host-side — it runs in the process worker on the guest's memory as its `wasi_snapshot_preview1` imports, so it becomes a **co-resident Rust PIC side module** (`fork-module` pattern), not a `runtime-core` module. Larger than the census said: 46 entry points, a duplicate channel-syscall protocol, path resolution, 5 struct re-encoders. Gains `host-native` WASI, which it has never had |
| `networking/virtual-network.ts` | 527 | **MIGRATE** | `LocalVirtualNetwork`/`VirtualTcpPeer`, endpoint registries, bind-conflict rules, its own errno table — duplicating `socket.rs` `tcp_can_bind`/`udp_can_bind`/`tcp_register` |
| `networking/` TLS / fetch / tcp / cors backends | 2,241 | **SPLIT** | TLS *state machine* → **MIGRATE**; the actual socket/fetch calls → **KEEP** |
| `framebuffer/browser-controls.ts` — `encodeLinuxMediumRawKeyCode` | ~200 of 732 | **MIGRATE** | Linux VT input encoding: pure computation |
| `webgl/bridge.ts` — command-buffer decode | ~300 of 700 | **MIGRATE** | decoding is computation; issuing GL calls is not |
| `framebuffer`/`webgl`/`audio`/`dri` — device calls, registries | ~3,600 | **KEEP** | §2.4 |
| `platform/` | 829 | **KEEP** | host detection and platform bridges |

### ABI surface

| file | lines | verdict | reason |
|---|---|---|---|
| `generated/abi.ts` (563 constants) | 2,168 | **ELIMINATE (shrinks)** | already correctly generated from Rust by `cargo xtask dump-abi` with CI drift-checking. The *pattern* is right; the volume is the symptom. It shrinks toward near-zero as TS leaves the dispatch path, and is a good progress readout |
| `constants.ts` | 3,005 | **KEEP** | a re-export shim over the generated ABI with only 7 own declarations. Not duplication |

### Transport and proxies

| file | lines | verdict | reason |
|---|---|---|---|
| `kernel-scratch.ts` | 2,465 | **KEEP** | §2.1 |
| `kernel-entry-gate.ts` | 1,596 | **KEEP** | §2.1 |
| `{browser,node}-kernel-host.ts` + protocols | 4,197 | **KEEP** | main-thread proxies; message passing between real host threads |
| `process-memory.ts` | 1,357 | **SPLIT** | layout policy → MIGRATE; `WebAssembly.Memory` handling → KEEP |
| `worker-protocol.ts`, `worker-adapter.ts`, `vfork-lifetime.ts`, `host-adapter-manifest.ts`, `native-positioned-write.ts`, `exec-target.ts`, and remaining top-level files | ~2,500 | **SPLIT** | judged file-by-file at implementation time against §2's test; none is individually large enough to change the plan |

### Fork — `host/src/fork-*.ts`, 25,665 lines

| part | verdict | reason |
|---|---|---|
| GC / struct / array / i31 / static-root reference reconstruction, incl. `fork-gc-codec.ts`'s `ForkGcProvenanceRegistry` | **ELIMINATE** | **The K0 probes (2026-09-09, Node + Chromium + WebKit, unanimous) proved provenance does not need recording — it is recoverable by a `ref.test` cascade over the module's own type section, and GC-derived externref identity survives a full host round trip.** The E1 blockers are dissolved |
| ~43 per-type `fm_*` reference-marshalling exports | **MIGRATE** | consolidate behind a narrower encode/decode dispatch (already tracked in `docs/future-improvements.md`) |
| `scanSegmentedForkReferenceExternrefHandles` (`fork-reference-wire.ts`) | **MIGRATE** | re-decodes the fork-codec wire format in TS, duplicating decode that `fork-codec` owns |
| capture/replay orchestration | **MIGRATE** | already the fork inversion plan's direction: the co-resident Rust module owns the algorithm |
| `resolve_externref` (handle → canonical host externref) | **KEEP** | §2.5 — **the single genuine fork reference floor**, now proven rather than assumed |
| anyref-transit `Table.grow` sizing, PIC placement globals, resume `WebAssembly.Table`, worker spawn | **KEEP** | §2.2 |

### `web-libs/kandelo-session` — runtime portion, ~3,400 lines

| part | verdict | reason |
|---|---|---|
| boot-descriptor validation, size caps, mount limits, path validation | **MIGRATE** | untrusted-input validation with a security contract — exactly what belongs in a typed language |
| `KernelHost` transport, snapshot plumbing | **KEEP** | browser-side session and transport |
| demo config / gallery / guides | **out of scope** | consumer, not platform |

### `binary-resolver.ts` — 3,611 lines

**SPLIT, mostly out of scope.** Artifact resolution and package projection
are toolchain. The exception is `programWasmArtifactPolicy` and the
required/forbidden-export checks: those encode the ABI contract and belong
with the ABI in Rust.

---

## 2. What stays in TypeScript, and why

The complete KEEP list. Each entry names the JS-API act or host object that
makes it irreducible. If a future reader cannot map a piece of surviving TS
to one of these, that TS is unfinished migration.

### 2.1 Transport safety — ~4,000 lines

`kernel-entry-gate.ts` and `kernel-scratch.ts` guard a hazard that exists
*because* the kernel is a wasm instance called from JS:

- **Reentrancy.** A kernel export may synchronously call a host import while
  Rust still owns mutable kernel state, so a host callback must not enter
  another export before the outer call returns. Rust cannot enforce this —
  the hazard is on the JS side of the boundary.
- **Capacity-carrying pointer views.** "A pointer being inside
  `WebAssembly.Memory` proves only that the host can address those bytes. It
  does not prove that the allocator gave those bytes to this caller."

Both are properties of the *boundary*, not of the kernel. **However:** this
surface should *shrink* as the kernel owns more, because less marshalling
crosses it. If it does not shrink, that is a signal the migration went
sideways rather than forward.

### 2.2 Object construction and thread control

Wasm cannot instantiate itself or spawn a thread:

- `new Worker` / terminate
- `new WebAssembly.Instance`, `new WebAssembly.Memory`, `SharedArrayBuffer`
  allocation
- `Memory.grow`, `Table.grow`, `WebAssembly.Table` get/set
- `new WebAssembly.Tag`
- `postMessage` between real host threads
- calling a guest export on the kernel's behalf (`host_call_signal_handler`)

### 2.3 Real byte stores

Node `fs`, `fetch`, and the lazy-archive fetcher. The kernel decides *what* to
read; the host performs the read.

**CORRECTED 2026-09-09.** This entry previously led with OPFS. **OPFS is not
mounted in the shipping path**: `OpfsFileSystem.create` (`host/src/vfs/opfs.ts:37`)
has no production caller — the only non-test references are two doc comments and
a re-export from `index.ts` (VERIFIED). Listing it as a live KEEP floor
overstated the host contract. It is a backend that exists but is unreachable;
decide whether to wire or delete it, and do not count it as floor until then.

Related, and larger: after Phase 5 the host `/` mount is **unconditionally
dropped** (`node-kernel-worker-entry.ts:1244`), and every path first hits
`tmpfs::claims_path` then `rootfs::claims_path`. The host's remaining filesystem
reach is therefore only the foreign prefixes — `/dev/shm` (a `MemoryFileSystem`,
not a host capability), `/dev` (shadowed), and Node `--mount`. The 25
path-taking imports are far less load-bearing than this ledger first implied. Contract
shape: `host_read`/`host_write`/`host_pread`/`host_pwrite`/`host_seek`/
`host_close` on an opaque handle, plus `host_blob_read`/`host_fetch_archive`.

### 2.4 Real devices

Canvas / OffscreenCanvas, WebGL contexts, AudioWorklet, the KMS/GBM/DRI
bridge, and raw socket I/O (Node `net`, the browser relay, the virtual
network transport). These are host objects with no wasm equivalent.

Their *count* should still fall — 23 device imports can converge on attach +
submit + query, since GL already has a command buffer — but the surface
itself is genuine.

### 2.5 `resolve_externref` — the one fork floor

Handle → canonical host `externref`. Irreducible because the value **is** a
host object and, per the K0 P2c control (0 on Node, Chromium, and WebKit), a
genuine host externref is not `ref.eq`-comparable once internalized, so its
identity cannot be recovered in wasm. This is the only surviving member of
what was once assumed to be a family of fork reference floors.

### 2.6 The two wait primitives

`host_futex_wait` / `host_futex_wake`. `Atomics.wait` performs the
compare-and-park atomically, and a wasm kernel instance cannot call it on
memory it does not own. `sigsuspend_wait` and `nanosleep` are futex-with-
timeout and collapse into these.

### 2.7 Cross-memory copy

`host_proc_read_bytes` / `host_proc_write_bytes` — copying between two
`WebAssembly.Memory` objects the kernel does not own. Unique in this list
for being a floor whose **use should grow**: generalizing it is what deletes
all pre-dispatch marshalling.

### 2.8 Clock and entropy

`host_clock_gettime`, `host_getrandom`.

**CORRECTED 2026-09-09.** This entry previously also listed `host_debug_log` as
a KEEP floor. **It is not an import at all**: `host/src/kernel.ts` supplies it,
but it is dead-code-eliminated out of the built kernel and does not appear in
`local-binaries/kernel.wasm` (VERIFIED — `wasm-tools print | grep host_debug_log`
→ 0, against 84 function imports plus `env.memory`). So the host contract is
**84 mandatory imports, not 85**, and the "diagnostics" concept in the value
plan's §4 table is already **0**, not 1. A floor that does not exist in the
artifact is not a floor.

---

## 3. What is NOT a reason to keep something

Recorded because each has been used at least once in this campaign's history
and each was later disproved:

| non-reason | why it fails |
|---|---|
| "It works today" | not an engineering argument |
| "It's a big rewrite" | cost is a sequencing input, not a verdict |
| "A browser engine crashes on it" | a compatibility boundary — document it, scope it narrowly, re-check it. The epoll mirror (`kernel-worker.ts:12274`) went five months un-rechecked; when tested on 2026-09-09 it **did not reproduce** on any engine (`docs/plans/probes/2026-09-09-k0c-epoll/`) |
| "Tests depend on it" | tests live where the primitives live. The fork campaign already hit this: production exports kept alive only by `.mjs` harnesses |
| "It was declared a floor before" | **three for three so far.** The wasmtime-exnref floor was stale; the E1 GC floors were disproved by the K0 P1/P2 probes; the V8 `epoll_pwait` crash did not reproduce (K0c). All three were inherited rather than re-verified |
| "The host must parse it anyway" | the host supplies bytes; the kernel parses. This is the whole V3 argument |
| "Only one host needs it" | then it is host-specific behavior in a shared contract, which is worse |

---

## 4. Totals

| verdict | approx. lines | share of the in-scope ≈153,000 |
|---|---|---|
| **MIGRATE** | ≈62,000 | 41% |
| **ELIMINATE** | ≈9,000 | 6% |
| **KEEP** | ≈40,000 | 26% |
| SPLIT / to be judged at implementation time | ≈42,000 | 27% |

The KEEP figure is an upper bound and should fall: much of it is transport
surface (§2.1) that shrinks as the kernel owns more, and device imports
(§2.4) that consolidate. A KEEP entry is a claim, and every claim here is
re-checkable against §2's two-part test.
