# K10 grounding — `host/src/wasi-shim.ts` → Rust

> **Read-only grounding study.** No product code was changed to produce
> this document. Written 2026-09-09 in worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch
> `brandonpayton/rust-first-abi44-reconcile` (head of PR #1350).
>
> Companion records: `2026-09-09-rust-first-value-plan.md` (values,
> the Bar, item table), `2026-09-09-whole-kernel-rust-migration-census.md`
> §3 F5 and §4, `2026-09-09-runtime-ts-disposition-ledger.md`,
> `docs/agent-guidance/validation.md`.

Every claim below is marked **VERIFIED** (read in this worktree, with a
`file:line` citation or a command whose output is quoted) or **INFERRED**
(reasoned, not observed). Nothing was run beyond reads and small local
`python3`/`grep` measurements over the checked-out sources.

---

## 0. Headline

The census's F5 claim — *"pure WASI Preview 1 ↔ POSIX translation, ~180
constants and 8 pure functions, requires zero host capability"* — is
**substantially correct but incomplete**, and the item is **bigger than
"a table and a switch"**.

- **VERIFIED**: the *translation* is pure. `host/src/wasi-shim.ts`
  contains **zero** references to `host_` (`grep -c "host_"
  host/src/wasi-shim.ts` → `0`). It requires no `env.host_*` import, no
  host object, and no JS-API act.
- **VERIFIED**: but the file is not only translation. `WasiShim` is a
  **stateful, channel-speaking guest-side runtime**: it owns a preopen
  table, an argv/env snapshot, a scratch allocator over the syscall
  channel's data area, and its own copy of the channel protocol —
  `Atomics.store` / `Atomics.notify` / `Atomics.wait`
  (`host/src/wasi-shim.ts:490-544`). That is a *second implementation of
  `libc/glue/channel_syscall.c`*, written in TypeScript.
- **VERIFIED**: the file is not "host" code in the `HostIO` sense at
  all. It runs **inside the process worker**, on the **guest's own
  linear memory**, and is wired as the guest's `wasi_snapshot_preview1`
  import namespace (`host/src/worker-main.ts:3291-3341`).

That last point is the whole architectural answer, and it changes the
shape of the migration: the natural Rust home is **not the kernel and
not a host-side Rust module**. It is a **co-resident wasm side module in
the process worker** — exactly the `crates/fork-module` pattern, which
already exists, is already built, staged, freshness-stamped, and
instantiated in this same file.

Honest counterweight, stated up front: **WASI has essentially no
production consumer in this repository.** The only artifacts that
exercise it are three hand-written `.wat` fixtures
(`host/test/fixtures/wasi-{hello,args,scalar-abi}.wat`, VERIFIED via
`grep -rli wasi host/test tests apps packages`). No package, demo, or
rootfs program is a WASI binary. See §9 NEEDS-DEFER-DECISION 9 — the
value case is real but it is a *future-host* case (V1), not a
today-users case.

---

## 1. Every export, categorized

`host/src/wasi-shim.ts` has **four** exports plus three re-exports.

| export | line | category |
|---|---|---|
| `WasiExit` (class) | `:429`, re-exported `:437` | **host-dependent (JS control flow)** — a JS `Error` subclass thrown to unwind the guest out of `_start` |
| `WasiShim` (class) | `:442` | **stateful** — see §1.2 |
| `isWasiModule` | re-export from `./wasi-detect` at `:1621` | **pure** (see §1.4) |
| `wasiModuleImportsMemory` | re-export `:1621` | **pure** |
| `wasiModuleDefinesMemory` | re-export `:1621` | **pure** |

### 1.1 Module-private pure functions — 8, exactly as the census says

VERIFIED, with line numbers:

| function | line | purity |
|---|---|---|
| `checkedSignedI64Scalar` | `:113` | pure (throws `RangeError`) |
| `splitSignedI64Words` | `:126` | pure |
| `translateLinuxErrno` | `:371` | pure, table lookup |
| `modeToFiletype` | `:375` | pure, `switch` on `mode & S_IFMT` |
| `wasiWhenceToPosix` | `:388` | pure, returns `null` on bad input |
| `wasiClockToPosix` | `:398` | pure, **silently defaults to `CLOCK_REALTIME`** |
| `wasiOflagsToPosix` | `:408` | pure, bitmask |
| `posixFlagToWasiFdflags` | `:419` | pure, bitmask |

All eight are `no_std`-expressible Rust today. None touches memory, the
channel, or any host object.

### 1.2 `WasiShim` — stateful, but the state is *tiny*

VERIFIED instance state (`:443-448`):

| field | kind |
|---|---|
| `memory: WebAssembly.Memory` | the **guest's** shared linear memory, not kernel memory — this is exactly how `host/test/kernel-scratch-contract.test.ts:533-539` classifies it (`owner: "process-memory"`) |
| `channelOffset: number` | the process's syscall-channel base |
| `argv: string[]`, `env: string[]` | launch snapshot from `initData` |
| `preopens: Map<number, string>` | **the only real mutable kernel-ish state**: fd → preopened dir path. Seeded with exactly one entry (`"/"`) in `init()` (`:464-488`); mutated by `fd_close` (`:765`) and `fd_renumber` (`:1106`) |
| `encoder`/`decoder` | `TextEncoder`/`TextDecoder` — UTF-8 codecs, pure computation available in Rust `core::str` |

**The `preopens` map is at most a handful of entries and in practice
exactly one.** It is not a POSIX object model; V2's "no untyped
`Map<string, …>` standing in for kernel objects" is barely engaged here.

### 1.3 The 46 WASI entry points

VERIFIED: `getImports()` (`:640-706`) returns **46** bound methods
(`sed -n '640,706p' … | grep -c "bind(this)"` → `46`). Categorized by
what they actually need:

**(a) Pure-local — no syscall at all (6).** They read `argv`/`env`/
`preopens` and write the guest's memory:
`args_get` `:693`, `args_sizes_get` `:707`, `environ_get` `:718`,
`environ_sizes_get` `:732`, `fd_prestat_get` `:745`,
`fd_prestat_dir_name` `:754`.

**(b) No-op stubs (2).** `fd_fdstat_set_rights` `:949` (correct: WASI
rights are not modelled), `fd_advise` `:1025` (correct: advisory).

**(c) Refuses (1).** `sock_accept` `:1611` → `WASI_ENOSYS`. **This is an
honest stub** and satisfies the debugging-and-POSIX contract.

**(d) One channel syscall + translation (25).** e.g. `fd_close` `:765`,
`fd_read` `:772`, `fd_write` `:782`, `fd_seek` `:878`, `fd_sync` `:905`,
`path_create_directory` `:1125`, `path_unlink_file` `:1131`,
`path_rename` `:1143`, `path_open` `:1211` (2 syscalls on the retry
path), `clock_time_get` `:1331`, `sched_yield` `:1372`,
`sock_shutdown` `:1605`, …

**(e) Multiple syscalls / loops / re-marshalling (12).**
`fd_pread` `:790` and `fd_pwrite` `:842` (iovec gather/scatter through
the channel data area), `fd_fdstat_get` `:915` (`fstat` **then**
`fcntl`), `fd_readdir` `:1029` (`getdents64` + Linux `dirent64` →
WASI `dirent` re-encode), `fd_renumber` `:1106` (`dup2` + `close`),
`random_get` `:1311` (chunked loop), `poll_oneoff` `:1379` (the largest
single function: 144 lines, subscription decode → `pollfd` encode →
`poll` → event encode), `sock_recv` `:1523`, `sock_send` `:1572`,
`fd_filestat_set_times` `:965`, `path_filestat_set_times` `:1272`,
`proc_raise` `:1361` (`getpid` + `kill`).

**(f) Unwinds through JS (1).** `proc_exit` `:1355` — issues `SYS_EXIT`
then `throw new WasiExit(code)`, caught at
`host/src/worker-main.ts:3352`.

### 1.4 Private helpers

| helper | line | category |
|---|---|---|
| `init()` | `:464` | stateful — one `openat("/")` to seed the preopen |
| `doSyscall()` | `:490` | **the channel protocol, reimplemented**: validates 6 i64 args, writes `CH_SYSCALL`/`CH_ARGS`, `Atomics.store(CH_PENDING)` + `Atomics.notify`, spins `Atomics.wait`, reads `CH_RETURN`/`CH_ERRNO`, resets to `CH_IDLE` |
| `syscallResultNumber()` | `:546` | pure i64→i32 narrowing guard |
| `dataArea` (getter) | `:555` | pure |
| `writeStringToData()` | `:560` | memory write |
| `resolvePath()` | `:572` | **path resolution in TypeScript** — prefixes the preopen path, writes to scratch, returns `AT_FDCWD` |
| `translateStat()` | `:606` | struct re-encode: kernel `WasmStat` → WASI `filestat` |

### 1.5 The "zero host capability" claim — proven, with one refinement

**PROVEN for the translation and for the shim's own operation.**
VERIFIED evidence:

1. `grep -c "host_" host/src/wasi-shim.ts` → `0`. No `env.host_*`
   import is reachable from this file.
2. The WASI branch of `centralizedWorkerMain`
   (`host/src/worker-main.ts:3291-3363`) never calls
   `buildKernelImports` (`:422`). The guest's entire import object is
   `{ wasi_snapshot_preview1: <46 shim methods>, env: { memory } }`
   (`:3312-3319`), with every other `env` import replaced by a
   throwing stub (`:3323-3335`).
3. Everything the shim does is: read/write the guest's linear memory,
   and drive the syscall channel with `Atomics`. Both are things a wasm
   module can do natively — the first with plain loads/stores, the
   second with `memory.atomic.wait32` / `memory.atomic.notify`
   (the memory is shared; `Atomics.wait` at `:511` only works on a
   `SharedArrayBuffer`, so the memory is provably `shared: true` —
   corroborated by the test harness minting
   `new WebAssembly.Memory({initial: 3, maximum: 3, shared: true})` at
   `host/test/wasi-shim.test.ts:52-56`).

**Refinement — the genuinely non-migratable residue is three JS-API
acts, none of which are *translation*:**

| residue | why it is a floor |
|---|---|
| choosing the WASI branch, and creating the guest `WebAssembly.Instance` with an import object | instantiating a module is a host act; §4 of the value plan already counts "guest invocation" as an irreducible concept |
| supplying trap stubs for the guest's unknown `env` imports (`worker-main.ts:3323-3335`) | building JS closures to satisfy arbitrary import names |
| unwinding `_start` on `proc_exit` | today a JS `throw`; alternatives in §3.4 |

`WasiExit` is therefore **host-dependent**, and it is the *only*
host-dependent export. Everything else is pure or channel-state.

### 1.6 `wasi-detect.ts` is also pure — and this refines the census

**VERIFIED, and worth recording because it was not obvious.**
`host/src/wasi-detect.ts` does **not** use the `WebAssembly.Module`
reflection JS API. It calls `wasmModuleImports`/`wasmModuleExports` from
`host/src/wasm-module-reflection.ts`, which returns descriptors parsed
from the module's **bytes** by `readWasmImportDescriptors`
(`host/src/constants.ts:2252`) — a hand-written TypeScript wasm binary
parser, deliberately preferred over the engine reflection because
"WebKit can compile ABI 43 fork artifacts … while
`WebAssembly.Module.imports()` throws"
(`host/src/wasm-module-reflection.ts:19-26`).

So `isWasiModule` is **pure byte parsing**, fully Rust-expressible. It is
not in K10's stated 1,625 lines (it is a separate 49-line file), and
migrating it drags in the whole 50-line-plus wasm-section parser in
`constants.ts`. See NEEDS-DEFER-DECISION 6.

---

## 2. Consumers, and whether this is a hot path

VERIFIED by `grep -rn "wasi-shim\|WasiShim\|wasi_shim"` across the repo
(excluding `node_modules`). There are **three** source importers and
**two** test importers. No importer in `apps/`, `web-libs/`, or
`packages/`.

### 2.1 `host/src/worker-main.ts` — the only real consumer

`host/src/worker-main.ts:176` imports `isWasiModule`,
`wasiModuleDefinesMemory` from `./wasi-detect` (eagerly — cheap).
`:3302` dynamically imports `{ WasiShim, WasiExit }` **only** when
`isWasiModule(module)` is true (`:3291`), deliberately keeping the
1,625-line file off the bootstrap path for native channel-syscall
binaries (`:171-175`, and the same rationale restated in
`wasi-detect.ts:1-15`).

What it calls, in order (VERIFIED `:3291-3363`):

1. `wasiModuleDefinesMemory(module)` → hard failure if the module
   defines rather than imports memory.
2. `new WasiShim(memory, channelOffset, initData.argv ?? [], initData.env ?? [])`.
3. `wasiShim.getImports()` → 46 functions, spread into
   `importObject.wasi_snapshot_preview1`.
4. `await WebAssembly.instantiate(module, importObject)`.
5. `wasiShim.init()` — the seeding `openat("/")`.
6. `port.postMessage({type:"ready"})`, then `instance.exports._start()`.
7. `catch (e) { if (e instanceof WasiExit) exitCode = e.code; else throw }`.
8. `port.postMessage({type:"exit", pid, status: exitCode})`.

Note what is **absent** from this branch: no `buildKernelImports`, no
fork instrumentation, no dylink, no pthread plumbing, no
`ForkModuleTrampolines`. **The WASI guest is a completely separate,
much simpler process-worker path.** That is a large de-risking fact for
the migration: nothing in the fork/dylink/pthread machinery is entangled
with it.

**What it would take to call into Rust instead:** replace step 3's
`Record<string, Function>` with the `exports` object of a co-resident
Rust wasm instance. `WebAssembly.Instance.exports.<f>` values are
`WebAssembly.Function`s and are directly usable as another instance's
function imports. Steps 1, 2, 4, 6, 7, 8 stay JS (they are the floor).
Step 5 becomes a call into the module.

### 2.2 `host/src/index.ts:83`

`export { WasiShim, WasiExit } from "./wasi-shim";` — public
`kandelo/host` API surface. VERIFIED: **no in-repo consumer** of that
export (`grep -rn "WasiShim" apps/ web-libs/` → nothing). It is
package-public surface only. Deleting it is an npm-package API change,
not an internal one.

### 2.3 `host/src/wasi-detect.ts`

Only the *comment* direction: `wasi-detect.ts` was split **out of**
`wasi-shim.ts` and `wasi-shim.ts` re-exports it back (`:1621-1625`) so
`kandelo/host` consumers keep working. `wasi-detect.ts` does not import
`wasi-shim.ts`. No cycle.

### 2.4 Is `WasiShim` on a hot path?

**Yes, per-call — but the boundary it would remove is not the expensive
one.** VERIFIED structure; the cost comparison is **INFERRED** and
**unmeasured**:

- Every one of the 46 WASI functions is a **guest wasm → JS import
  call**. `fd_read`/`fd_write` are the hot ones for any real workload.
- Each of those (except the 9 in categories (a)/(b)/(c)) then does an
  `Atomics.wait` round trip to the kernel worker
  (`wasi-shim.ts:511`) — a cross-thread block-and-wake.
- **INFERRED:** the `Atomics.wait` round trip dominates the JS import
  frame by orders of magnitude. Moving the shim into a co-resident wasm
  module removes the JS frame and leaves the round trip unchanged, so
  the change should be neutral-to-slightly-positive.
- **This is explicitly NOT a performance claim.** Nothing was measured.
  Per the performance contract, if K10 lands, the honest report is
  "performance was not measured", unless benchmarks are run.
- **The important non-regression property is structural:** the design in
  §3 must not add a *channel* round trip anywhere. The kernel-side
  design (option a) would add one to the 6 pure-local calls; the
  co-resident design (option c) adds none, and could later *remove* one
  from `fd_fdstat_get` (currently 2 syscalls).

---

## 3. The architectural question — where does WASI translation belong?

This is the load-bearing part of the grounding. The brief offered three
options. One of them does not fit the actual call graph at all, and the
right answer is a fourth that the repo has already built the machinery
for.

### 3.0 The constraint that decides it

**The caller is the guest, not the kernel and not the host.**
`wasi_snapshot_preview1.fd_read` is a **wasm import of the guest
module**. Something must be a callable function value at guest
instantiation time. The kernel cannot intercept it — the kernel only
ever sees what arrives on the syscall channel.

So the real question is only: *what supplies those 46 function values,
and where does the translation run relative to the channel?*

### 3.1 Option (a) — in the kernel, behind the existing syscall dispatch

Shape: a thin process-side trampoline marshals `(wasi_op, args…)` into
the channel; `dispatch_channel_syscall` grows a WASI opcode space; the
kernel does the whole translation, reading and writing guest memory via
`proc_read_bytes`/`proc_write_bytes` (the K2 item).

**Genuine advantages.** It would *reduce* round trips for the
multi-syscall entries — `fd_fdstat_get` (2→1), `fd_renumber` (2→1),
`proc_raise` (2→1), `random_get` (N→1), `poll_oneoff` (2→1). And the
kernel already reads guest memory for `readv`/`writev` (that is exactly
why `fd_read` at `:772` can pass the guest's raw `iovsPtr` straight
through).

**Why I recommend against it:**

1. **STRONG DOUBT — it is an ABI addition.** A WASI opcode space on the
   channel is new marshalling in `crates/shared`, which the ABI contract
   lists explicitly ("syscall numbers and marshalling, channel layout").
   Under one campaign epoch it is *permitted*, but K10 is advertised as
   the low-risk Tier-1 item precisely because it needs no ABI motion.
   Buying round-trip reductions with ABI surface inverts that.
2. **Wrong ownership.** WASI's `filestat`, `fdstat`, `dirent`,
   `subscription`, and `event` layouts are a **guest ABI defined by the
   WASI specification**. Teaching the Kandelo kernel those layouts makes
   the kernel a WASI implementation. The kernel's contract is POSIX. A
   second guest personality belongs beside the guest, not inside the
   process table.
3. **It still needs 46 function values.** Something process-side must
   exist anyway; option (a) does not remove the process-side artifact,
   it only makes it dumber.
4. It *adds* a channel round trip to the 6 pure-local calls
   (`args_get`, `environ_get`, the two `*_sizes_get`, and the two
   prestat calls) unless they are special-cased — reintroducing exactly
   the "some in TS, some in Rust" split the campaign is trying to end.

### 3.2 Option (b) — a runtime-core module the kernel calls

**This one does not fit.** VERIFIED: nothing in `crates/kernel` or
`crates/runtime-core` ever calls WASI translation, because the kernel
never sees a WASI call
(`grep -rli wasi crates/ --include="*.rs"` → **no matches**; there is
zero WASI code in Rust today). A `runtime-core` module with no caller is
a library, not an architecture. If it means "host-side Rust the
TypeScript calls per WASI call", that is strictly worse than today: a JS
frame *plus* a wasm boundary crossing on every call.

The only sound sense in which (b) is right is as a **sub-part of (c)**:
the pure translation tables should live in a host-independent,
natively-unit-testable crate that both the co-resident module and any
future consumer link. That is `crates/wasi-abi` in §3.3.

### 3.3 Option (c), refined — **a co-resident Rust `wasi-module` in the process worker**. RECOMMENDED.

Shape: a new PIC wasm **side module**, `crates/wasi-module`, built the
way `crates/fork-module` is built. It imports the guest's
`env.memory` plus the placement globals, exports 46 functions with the
`wasi_snapshot_preview1` signatures, and drives the syscall channel
itself with `memory.atomic.wait32` — i.e. it does exactly what
`libc/glue/channel_syscall.c` does for SDK guests, for WASI guests.
`worker-main.ts` wires `wasiModule.exports` directly into the guest's
import object.

**The precedent is not hypothetical. VERIFIED, in this worktree:**

- `crates/fork-module/Cargo.toml:7-10` — *"the co-resident
  process-worker fork module. Built for wasm32 as a cdylib that imports
  the guest's linear memory and exports the guest-facing … functions."*
- `crates/fork-module/build-wasm.sh:52-63` — the exact flag set:
  `-C relocation-model=pic`,
  `-C target-feature=+atomics,+bulk-memory,+mutable-globals`,
  `--experimental-pic --pie --import-memory --shared-memory
  --max-memory=…`, `panic=immediate-abort`.
- `host/src/fork-module-instance.ts:1-21` — the placement contract:
  the module imports `env.__memory_base` (immutable),
  `env.__stack_pointer` (mutable), `env.__table_base`, and its passive
  data segments are relocated by `__wasm_apply_data_relocs` at
  instantiation, so its static data / BSS / shadow stack sit in a
  **host-chosen region** instead of colliding with live guest data.
- `host/src/fork-module-instance.ts:554-680` — region sizing,
  `reserve(regionBytes)`, alignment assertions, synchronous
  `new WebAssembly.Instance`, and a loud required-export check.
- `crates/fork-module/build-wasm.sh:150-175` — staging into
  `local-binaries/` **and** `host/wasm/`, resolved by
  `resolveBinary("fork_module32.wasm")` on Node and by the Vite
  `@fork-module32-wasm?url` alias in the browser
  (`host/src/browser-fork-module-artifact.ts:1`).
- `crates/fork-module/build-wasm.sh:22-35` — the closure-derived
  build-key stamp and `--verify-fresh` gate, matching the
  "closure-derived cache-keys" rule.

**Why this is the right home:**

1. **Zero new host API surface (V4).** No `env.host_*` import. No new
   `HostIO` trait method. The host's job shrinks from *"implement 46
   WASI functions"* to *"instantiate one more module and pass its
   exports through"*.
2. **Zero ABI motion.** `wasi_snapshot_preview1` is a WASI-spec
   namespace, not a Kandelo ABI surface. VERIFIED: `grep -c wasi
   abi/snapshot.json` → `0`. The channel protocol the module would speak
   is the *existing* one.
3. **V1 is delivered concretely, not abstractly.** VERIFIED:
   `grep -rn wasi crates/host-native/src/*.rs` → **nothing**.
   `host-native` has no WASI support whatsoever. A wasm side module is
   loadable by wasmtime as readily as by a browser, so this migration
   *gains* native WASI rather than relocating browser WASI. That is the
   single strongest value argument for K10 and it is not in the census.
4. **V2 is delivered where the bugs actually are.** §5 lists five real
   defects that exhaustive matching and typed constants would have
   caught or made visible.
5. **It puts the translation on the correct side of the channel.** WASI
   is a *guest personality*. `channel_syscall.c` is the SDK guest's
   personality; `wasi-module` becomes the WASI guest's. Symmetric, and
   it is the design that lets a future `wasi_snapshot_preview2` /
   `wasip2` adapter be a second module rather than a second kernel
   opcode space.

**Sub-structure (this is where option (b)'s good idea lands):**

```
crates/wasi-abi     no_std, no wasm assumptions.
                    The 107 WASI constants as typed enums, the errno
                    table, and the 8 pure functions. Unit-tested on the
                    HOST target with `cargo test -p wasi-abi`.
crates/wasi-module  cdylib PIC side module. Depends on wasi-abi and
                    wasm-posix-shared. Owns the channel syscall, the
                    preopen table, scratch layout, and the struct
                    re-encoders (filestat / fdstat / dirent /
                    subscription / event).
```

This split matters: it makes ~700 of the 1,625 lines testable by an
ordinary native `cargo test` with no wasm, no worker, and no kernel.

### 3.4 Residue that stays TypeScript, and why

Being honest about the floor, per the Bar:

| residue | lines (est.) | why it is a floor |
|---|---|---|
| WASI branch selection + `WebAssembly.instantiate` + import-object assembly (`worker-main.ts:3291-3341`) | ~35 | instantiating a module is a host act (§4 "guest invocation") |
| trap stubs for unknown `env` imports (`:3323-3335`) | ~13 | building JS closures for arbitrary names |
| `_start` invocation and exit reporting (`:3345-3362`) | ~18 | host act |
| the module's region reservation | ~10 | host act, same as `fork-module`'s `reserve` |
| `proc_exit` unwind | ~5 | see below |

**`proc_exit` needs a decision.** Three options, all sound:

- **(i) one JS thunk.** `proc_exit: (code) => { wasiModule.proc_exit(code); throw new WasiExit(code); }`.
  Keeps today's behavior byte-for-byte; costs one JS function on a path
  taken exactly once per process. **My recommendation** — smallest
  diff, no new mechanism.
- **(ii) module traps.** The module issues `SYS_EXIT`, stores the code,
  then `unreachable`. The host catches `WebAssembly.RuntimeError` and
  reads the code back from an export. No JS on the import path at all,
  but it converts a normal exit into a trap, which is worse for
  diagnostics.
- **(iii) an exception tag.** The repo already mints tags
  (`createForkUnwindTag`, `worker-main.ts:3370`), so a
  `wasi_exit` tag is available. Cleanest semantically; most machinery.

### 3.5 Option (d) — leave it, shrink it, and re-express only the tables

Recorded for completeness so the maintainer sees the cheap alternative:
generate the 107 WASI constants and the errno table into
`host/src/generated/` from a Rust source of truth (the way
`generated/abi.ts` already works), and leave the 46 functions in
TypeScript. Cost: ~1 day. Benefit: kills the duplicate-table risk and
part of V2. Non-benefit: V1 is untouched — `host-native` still has no
WASI — and 1,400 lines of TS remain in the runtime. I do **not**
recommend stopping here, but it is the honest fallback if the maintainer
decides K10 does not earn a new wasm artifact (NEEDS-DEFER-DECISION 9).

---

## 4. What Rust already has — the overlap, quantified

Measured, not estimated (a `python3` pass over
`crates/shared/src/lib.rs` and `host/src/wasi-shim.ts`).

| quantity | count | source |
|---|---|---|
| module-level `const` declarations in `wasi-shim.ts` | **180** | matches the census's "~180" — **VERIFIED** |
| of those, `WASI_*` (genuinely new to Rust) | **107** | |
| of those, POSIX aliases of `generated/abi` values (`SYS_*`, `O_*`, `S_IF*`, `SEEK_*`, `F_*`, `AT_*`, `CH_*`) | **73** | `wasi-shim.ts:49-147` — these are *already* Rust-owned; the TS is a re-alias |
| `linuxToWasi` map entries | **79** | `wasi-shim.ts:229-338` |
| variants in Rust `Errno` (`crates/shared/src/lib.rs:828`) | **62** | |
| Linux errno numbers in the TS map with **no** Rust `Errno` variant | **17** | `33, 60, 62, 67, 71, 72, 74, 84, 100, 102, 105, 113, 116, 122, 125, 130, 131` |
| Rust `Errno` values the TS map does not cover | **1** | `108` — falls through to `translateLinuxErrno`'s `?? WASI_EIO` default (`:371-373`) |
| WASI constants that exist in Rust today | **0** | `grep -rli wasi crates/ --include="*.rs"` → no matches |

**Reading of this:**

- **~40% of the constants are re-expression, not new work.** The 73
  POSIX aliases become `wasm_posix_shared::{flags, mode, seek, fcntl_cmd,
  ...}` imports and simply disappear.
- **~60% is genuinely new**: the 107 `WASI_*` values and the 79-entry
  errno table have no Rust counterpart at all.
- **The 17 uncovered errnos are a finding, not a chore.** Rust's `Errno`
  enum does not carry `EDOM(33)`, `ENOLINK(67)`, `EPROTO(71)`,
  `EMULTIHOP(72)`, `EBADMSG(74)`, `EILSEQ(84)`, `ENETDOWN(100)`,
  `ENETRESET(102)`, `ENOBUFS(105)`, `EHOSTUNREACH(113)`, `ESTALE(116)`,
  `EDQUOT(122)`, `ECANCELED(125)`, `EOWNERDEAD(130)`,
  `ENOTRECOVERABLE(131)`, and the two ENOSTR/ETIME-family values
  `60`/`62`. Writing the table in Rust forces a decision on each. See
  NEEDS-DEFER-DECISION 1.

The two structural helpers `checkedSignedI64Scalar` and
`splitSignedI64Words` (`:113`, `:126`) are pure BigInt arithmetic that
Rust gets for free from `i64`/`u32` — they exist *only* because
JavaScript numbers cannot hold i64. **They vanish entirely in Rust.**
That is ~35 lines of the file that is pure V2 tax.

---

## 5. Defects the migration would surface (V2 evidence)

VERIFIED by a dead-constant scan
(`declared-but-unused module consts`) plus reading the call sites. These
are stated as findings, not as things to fix silently.

1. **`WASI_EVENTTYPE_FD_WRITE` is declared and never compared.**
   `poll_oneoff` does
   `const events = tag === WASI_EVENTTYPE_FD_READ ? POLLIN : POLLOUT;`
   (`:1461`). Any subscription tag that is neither `CLOCK` nor
   `FD_READ` — including a malformed one — is silently treated as
   `fd_write`. An exhaustive Rust `match` cannot express this bug.
2. **`WASI_LOOKUP_SYMLINK_FOLLOW` is declared and never read.**
   `path_filestat_get` (`:1258`) takes `_flags` and passes `0` to
   `SYS_FSTATAT` (`:1264-1266`), i.e. it **always follows symlinks**.
   WASI's `lstat` equivalent (`lookupflags == 0`) is not implementable
   through this shim today. A real POSIX/WASI gap.
3. **`WASI_FDFLAG_DSYNC`/`RSYNC`/`SYNC` are declared and never read.**
   `fd_fdstat_set_flags` (`:941`) maps only `APPEND` and `NONBLOCK` and
   returns `WASI_ESUCCESS`. Setting `O_SYNC` silently succeeds without
   doing anything — the exact "unsupported API turned into silent
   success" the debugging-and-POSIX contract forbids.
4. **`WASM_STAT_SIZE` is declared and never used**, while
   `translateStat` (`:606-637`) reads the kernel `WasmStat` at
   **hard-coded** offsets `0/8/16/20/32/40/48/56/64/72/80`. The
   generated ABI constant is imported and ignored. This is precisely
   the hand-maintained-offset hazard V2 exists to kill.
5. **`fd_readdir` cookie handling looks wrong.** `:1029-1104` issues a
   fresh `getdents64` on **every** call and then skips
   `entryIdx <= cookie` entries. But `getdents64` advances the fd
   offset, so the second call reads the *next* batch and then discards
   `cookie` of *those*. **INFERRED** (not reproduced): directories
   larger than one `getdents64` batch will drop entries. The one-batch
   case, which is all the fixtures exercise, works.
6. `POLLHUP` and `WASI_FILETYPE_SOCKET_DGRAM` are declared and unused;
   `SYS_READ`/`SYS_WRITE` are dead (the shim uses `readv`/`writev`).

None of these is a reason to rush; all of them are reasons to write the
Rust version with exhaustive matches and typed newtypes rather than
transliterating.

---

## 6. Test coverage today, and where each test goes

VERIFIED inventory (`grep -rli wasi host/test tests apps packages`):

| artifact | lines | what it proves |
|---|---|---|
| `host/test/wasi-shim.test.ts` | 294 | 12 tests in 2 `describe` blocks |
| `host/test/fixtures/wasi-hello.wat` | — | real guest: `fd_write` → stdout |
| `host/test/fixtures/wasi-args.wat` | — | real guest: `args_get` |
| `host/test/fixtures/wasi-scalar-abi.wat` | — | real guest: i64 scalar fidelity |
| `host/test/global-setup.ts:163-166,383-393` | — | compiles the three `.wat` with `wat2wasm --enable-threads` |
| `host/test/kernel-scratch-contract.test.ts:533-539` | 7 | an inventory entry declaring `WasiShim.memory` is process memory, not kernel scratch |

**There is no other WASI coverage anywhere.** No conformance suite, no
browser test, no package.

### Fates

**Becomes a Rust unit test (9 of 12).** The entire
`"WASI shim scalar channel ABI"` block
(`host/test/wasi-shim.test.ts:129-293`) drives `WasiShim` against a
**mocked** `Atomics.wait` (`:60-84`) and asserts the exact syscall
number and the six i64 argument slots. Every one of these is a
statement about translation and marshalling:

- pread/pwrite offsets in their exact i64 slot (`:130`)
- lseek low/high word split and exact i64 result (`:178`)
- negative lseek sign-extension and `fd_tell`→`SEEK_CUR` (`:202`)
- seek output untouched on channel error (`:226`)
- invalid WASI whence rejected before any syscall (`:239`)
- ftruncate/fallocate scalar slots (`:252`)
- direct-JS scalars that cannot encode i64 exactly are rejected (`:272`)

In Rust these become `cargo test -p wasi-abi` (the pure functions) and
`cargo test -p wasi-module` against an in-memory fake channel. The
`i64`-exactness tests (`:130`, `:272`) become *type-level facts* and
mostly disappear — which is the point.

**Stays TypeScript (3 of 12).** The `"WASI shim"` block
(`:99-127`) runs real `.wasm` guests through
`runCentralizedProgram` → a real `CentralizedKernelWorker`. These are
genuine cross-host wasm behavior tests (ledger §6 "stays TS") and must
not be traded away. They also become the **cutover gate**.

**Changes (1).** `kernel-scratch-contract.test.ts:533` names
`host/src/wasi-shim.ts::WasiShim.memory` in a declaration inventory; that
row is deleted with the class.

**Coverage is thin for a cutover.** Three `.wat` fixtures exercise
`fd_write`, `args_get`, and scalar fidelity. They touch **none** of
`path_open`, `fd_readdir`, `poll_oneoff`, `path_filestat_get`,
`fd_seek` against a real file, or the socket calls. **Increment I2 must
add fixtures before I5 flips anything** — see §7.

---

## 7. Host contract impact (`env.host_*`)

**Expected answer confirmed: NO.** VERIFIED on four independent
grounds:

1. `grep -c "host_" host/src/wasi-shim.ts` → `0`.
2. The WASI branch never calls `buildKernelImports`
   (`worker-main.ts:422`), so not even the guest-facing `env.kernel_*`
   contract is engaged; the guest's `env` namespace is
   `{ memory }` plus traps (`:3312-3335`).
3. `grep -c wasi abi/snapshot.json` → `0`. Nothing WASI is in the ABI
   snapshot.
4. `HostIO` (83 methods, one production implementor at
   `crates/kernel/src/wasm_api.rs:318`) is a *kernel*↔host trait. The
   WASI shim lives in the process worker and never reaches it.

**`EXPECTED_HOST_IMPORT_COUNT = 84` (`crates/host-native/src/lib.rs:77`)
is unaffected.** The 85 `env.host_*` bindings do not move.

**But two second-order contract facts must be stated honestly:**

- **A new build artifact enters the host's load path.**
  `wasi_module32.wasm` would be resolved by `resolveBinary` on Node and
  by a Vite `?url` alias in the browser, exactly like
  `fork_module32.wasm`. That is not the ABI, but it *is* a distribution
  and freshness contract, and it must carry a closure-derived build-key
  stamp with a `--verify-fresh` gate from day one
  (`crates/fork-module/build-wasm.sh:22-35` is the pattern; per the
  "favor Rust implementations" rule the new one should be an **xtask
  verb**, not a second shell script).
- **`host/src/index.ts:83` is public npm surface.** Deleting
  `WasiShim`/`WasiExit` from `kandelo/host` is an external API removal
  even though no in-repo consumer exists.

---

## 8. Implementation plan

Seven increments. Each is independently landable, and each names the
evidence for the claim it lets you make. **Nothing is deleted before
§I2's differential harness is green.**

Prerequisite for every runtime suite in a fresh worktree: the
provisioning steps in `docs/agent-guidance/validation.md`
("Preparing a fresh checkout or worktree"). `<host-target>` is
`rustc -vV | awk '/^host/ {print $2}'`.

### I0 — Probe. No product code. (GATES EVERYTHING.)

Four questions, all answerable in a throwaway harness under
`docs/plans/probes/`. **Three "floors" have already been inherited and
disproved in this campaign; do not inherit these.**

1. Can a PIC side module's exported function be used **directly** as
   another instance's import, with the guest calling it as a wasm→wasm
   call? (Signatures are all `i32`/`i64` → `i32`, so this should hold;
   verify on **Node, Chromium, and WebKit**, matching the K0 probe
   discipline.)
2. Does `memory.atomic.wait32` inside the side module block and wake on
   the **same channel status word** the TS shim drives with
   `Atomics.wait` (`wasi-shim.ts:511`)? Confirm the module can be built
   with `+atomics` against an imported shared memory and that
   `Atomics.notify` from the kernel worker wakes it.
3. **Region placement for a non-SDK guest.** `fork-module` reserves via
   `continuationMmap` → the kernel `find_gap` allocator
   (`worker-main.ts:6727`). A WASI guest is **not** SDK-linked: its
   `wasi-libc` heap grows memory with `memory.grow` directly, so the
   kernel is not the sole authority over that address space. Probe
   whether a kernel `SYS_MMAP` is safe here, or whether the host should
   instead reserve by growing the memory **once, before guest
   instantiation**, and hand the base in as `__memory_base`. I expect
   the latter is correct and simpler; **INFERRED, must be probed.**
4. Ordering: can the reservation and module instantiation happen before
   `WebAssembly.instantiate(guest)` and before the `ready` message,
   given the process is already kernel-registered when `initData`
   arrives? (`wasiShim.init()` already issues a syscall at
   `worker-main.ts:3341`, before `ready` at `:3344` — so pre-`ready`
   syscalls demonstrably work. VERIFIED for syscalls; unverified for
   mmap.)

*Evidence:* probe artifacts + results table under
`docs/plans/probes/2026-09-09-k10/`, on all three engines.

### I1 — `crates/wasi-abi` (pure, additive, wired to nothing)

`no_std` crate: the 107 WASI constants as typed enums/newtypes
(`WasiErrno`, `WasiFiletype`, `WasiClock`, `WasiWhence`, `WasiOflags`,
`WasiFdflags`, `WasiEventType`), the 79-entry Linux→WASI errno table,
and the 8 pure functions. Every `match` exhaustive; no `_ =>` arm that
hides an unhandled case (see §5.1). POSIX constants come from
`wasm-posix-shared`, never re-declared.

*Validation:*
`cargo test -p wasi-abi --target <host-target>`;
`cargo test --workspace --exclude xtask --target <host-target>`.
*Claim it supports:* "the translation tables are expressed in Rust and
unit-tested"; **not** "behavior is equivalent".

### I2 — Differential equivalence harness. **The deletion gate.**

The domains are small enough to enumerate **exhaustively**, so this is
proof, not sampling:

| function | domain | size |
|---|---|---|
| `translateLinuxErrno` | `0..=200` | 201 |
| `modeToFiletype` | all 7 `S_IFMT` buckets × representative low bits | ~64 |
| `wasiWhenceToPosix` | `0..=8` | 9 |
| `wasiClockToPosix` | `0..=8` | 9 |
| `wasiOflagsToPosix` | `oflags 0..=15` × `fdflags 0..=31` | 512 |
| `posixFlagToWasiFdflags` | every single-bit flag + combinations | ~64 |
| `splitSignedI64Words` | i64 boundaries + a fixed pseudo-random vector set | ~200 |

Mechanism: an `xtask` verb dumps the Rust results for the full domain to
JSON; a new Vitest case (`host/test/wasi-translation-equivalence.test.ts`)
loads that JSON and asserts the **TypeScript** produces the identical
value for every input. Any divergence is a defect in one side and must
be adjudicated (§5) before I5.

**Also in I2: raise guest coverage.** Add `.wat` (or SDK-built) WASI
fixtures for `path_open` + `fd_read` on a real file, `fd_seek` +
`fd_tell`, `fd_readdir` across a multi-batch directory (this will likely
expose §5.5 — good), `path_filestat_get` on a symlink (§5.2), and
`poll_oneoff` with a clock subscription. These fixtures must pass
**against today's TypeScript shim** first, so they are a regression
baseline, not a moving target.

*Validation:* `cd host && npx vitest run wasi` (and the two new files by
name); `cargo test -p wasi-abi --target <host-target>`.
*Claim it supports:* "the Rust and TypeScript translation tables agree on
the entire enumerated input domain."

### I3 — `crates/wasi-module` (built, staged, wired to nothing)

The PIC side module: 46 exported functions, the channel syscall in Rust
(`memory.atomic.wait32`), the preopen table, the scratch layout, and the
struct re-encoders. Struct offsets come from `wasm-posix-shared`
constants, never hard-coded (§5.4).

Build + staging as an **xtask verb** (`cargo xtask build-wasi-module`),
mirroring `crates/fork-module/build-wasm.sh` including the
closure-derived build-key stamp and `--verify-fresh`. Stage
`wasi_module32.wasm` into `local-binaries/` and `host/wasm/`; add the
Vite `?url` alias.

*Validation:* `cargo test -p wasi-module --target <host-target>`
(the channel logic against an in-memory fake channel);
`cargo xtask build-wasi-module --verify-fresh`;
`bash scripts/ci-check-browser-assets.sh`.

### I4 — Dormant instantiation (byte-identical when off)

In `worker-main.ts`'s WASI branch, behind an off-by-default flag:
reserve the region, instantiate `wasi_module32.wasm`, assert its 46
exports loudly, then **do nothing with it** — the guest still gets
`wasiShim.getImports()`. This is the `tmpfs.rs` twelve-increment
pattern the value plan §7 mandates.

*Validation:* `cd host && npx vitest run` (full); flag-off must be
byte-identical. Browser suite for the asset/alias change:
`cd apps/browser-demos && npx playwright test --grep-invert "@slow" --project=chromium`.

### I5 — Cutover

Flip `importObject.wasi_snapshot_preview1` to the module's exports,
keeping `proc_exit` as the one JS thunk (§3.4(i)) unless the maintainer
picks (ii) or (iii). Move `init()`'s seeding `openat("/")` into the
module. Flag defaults **on**; the flag stays for one increment so a
regression can be bisected without a revert.

*Validation:* the full I2 fixture set (now the real gate);
`cd host && npx vitest run`;
`cd apps/browser-demos && npx playwright test --grep-invert "@slow" --project=chromium`;
`bash scripts/ci-check-browser-assets.sh`;
`bash scripts/check-abi-version.sh` (expected: **no change** — that is
the claim being evidenced).

Note honestly in the report: WASI is not exercised by the libc, POSIX,
or Sortix conformance suites, so those prove nothing here. Say so rather
than running them for the appearance of rigor. Do **not** claim any
performance result without benchmarks.

### I6 — Delete the TypeScript

Delete `host/src/wasi-shim.ts` (1,625 lines), remove the
`WasiShim`/`WasiExit` export from `host/src/index.ts:83`, delete the
`kernel-scratch-contract.test.ts:533-539` inventory row, and delete the
9 migrated unit tests from `host/test/wasi-shim.test.ts`, keeping the
real-guest integration block and the new I2 fixtures. Remove the flag
from I4/I5. Update the disposition ledger and census rows.

*Validation:* `cd host && npx vitest run`; `npx tsc --noEmit` in `host`
(or the repo's configured type-check); browser suite.

### I7 — host-native inherits WASI (the V1 proof)

Load and wire the same `wasi_module32.wasm` in `crates/host-native` so a
WASI guest runs under wasmtime. This is what converts K10 from "moved
code" into "one implementation, three hosts". It may be scoped as a
follow-up — see NEEDS-DEFER-DECISION 8.

*Validation:* a `crates/host-native` test running
`wasi-hello.wasm` end-to-end;
`cargo test --workspace --exclude xtask --target <host-target>`.

### Proving behavioral equivalence before deletion — summary

Three layers, in order, and none of them is skippable:

1. **Exhaustive table equivalence (I2)** — the pure functions agree on
   every input in a fully enumerated domain. This is the strongest layer
   and it is cheap because the domains are tiny.
2. **Channel-record equivalence (I3)** — for each of the 46 entry
   points, the Rust module emits the *same syscall number and the same
   six i64 argument slots* as the TypeScript, for a fixed set of inputs.
   The existing TS tests already assert exactly this shape against a
   mocked `Atomics.wait` (`host/test/wasi-shim.test.ts:60-84`), so the
   expectations transfer directly.
3. **Real-guest behavior (I2 fixtures + I5)** — real `.wasm` WASI guests
   through a real kernel, before and after the flip, on Node and in the
   browser.

---

## 9. NEEDS-DEFER-DECISION

The maintainer decides each of these. I have not deferred any of them on
my own authority.

**1. The 17 Linux errnos with no Rust `Errno` variant.**
*What:* `33, 60, 62, 67, 71, 72, 74, 84, 100, 102, 105, 113, 116, 122,
125, 130, 131` appear in `wasi-shim.ts`'s table but not in
`crates/shared/src/lib.rs:828`. *Why now:* writing the table in Rust
forces the question. *Cost now:* extending a `repr(u32)` enum;
ABI-adjacent only if any of them is already produced by the kernel
under a different name. *Cost later:* the Rust table has to carry raw
`u32`s beside a typed enum, which is exactly the untyped-escape-hatch
V2 is meant to remove. *Recommendation:* extend `Errno` in I1 and treat
any that the kernel genuinely cannot produce as a documented comment.

**2. `fd_readdir` cookie semantics (§5.5).**
*What:* looks broken for multi-batch directories. *Cost now:* the I2
fixture will likely turn red, and fixing it means real
`getdents64`-offset handling (probably `lseek`-on-dirfd or caching a
batch). *Cost later:* the Rust module inherits a latent bug, and the
"differential equivalence" gate would be certifying wrong behavior as
correct. *Recommendation:* write the fixture, let it fail, and fix it in
the **Rust** implementation, documenting the TS behavior as the
pre-existing defect. Do not preserve it bug-for-bug.

**3. `path_filestat_get` ignores `lookupflags` (§5.2).**
*What:* WASI `lstat` is unreachable. *Cost now:* one `AT_SYMLINK_NOFOLLOW`
mapping. *Cost later:* a real POSIX gap ships in Rust. *Recommendation:*
fix in I3; it is three lines and it is a platform-values issue.

**4. `fd_fdstat_set_flags` silently succeeds for `O_SYNC`/`O_DSYNC`/
`O_RSYNC` (§5.3).** *Cost now:* decide between mapping them to POSIX
flags or returning `WASI_ENOTSUP`. *Cost later:* the honest-stub rule is
violated in the new Rust code too. *Recommendation:* map what the kernel
supports; return `ENOTSUP` for the rest.

**5. `poll_oneoff`'s non-exhaustive tag handling (§5.1).**
*Recommendation:* exhaustive `match`, `WASI_EINVAL` for an unknown tag.
Behavior change; needs a nod.

**6. Migrating `wasi-detect.ts` (49 lines) too.**
*What:* it is pure byte parsing (§1.6), so it *could* be Rust — but it
runs before instantiation, so a Rust version needs a callable
entry point, and it depends on the TS wasm-section parser in
`constants.ts`. *Cost now:* drags a wasm parser migration into K10.
*Cost later:* a 49-line pure-computation file stays in TS. *My
recommendation:* **leave it out of K10** and record it as a candidate
for whichever item migrates `constants.ts`'s wasm parsing. But this is a
deferral, so it is the maintainer's call, not mine.

**7. `proc_exit` unwind mechanism** — (i) JS thunk / (ii) trap + read
code / (iii) exception tag. §3.4. *Recommendation:* (i).

**8. Is I7 (host-native wiring) in K10 or a follow-up?**
*Cost now:* wasmtime module loading + import wiring in
`crates/host-native`, which today `define_unknown_imports_as_traps`
for most things. *Cost later:* K10 lands as "moved code" and V1 —
its headline value — remains unproven. *Recommendation:* keep it in
K10. Without it, the honest claim is only "the same TypeScript logic is
now Rust", which is a weaker case than the item is sold on.

**9. Is K10 correctly ranked Tier 1, given it has no in-repo
consumer?** *What:* the only WASI artifacts in the repo are three test
fixtures (§0). No package, demo, or rootfs program is a WASI binary.
*Cost now:* seven increments plus a new versioned wasm artifact and its
freshness machinery, to serve a capability nothing currently uses.
*Cost later:* K10 is genuinely low-risk and fully independent, and it
would give `host-native` a capability it has never had; deferring it
past ABI-44 finalization is fine because it needs no ABI motion. *My
recommendation:* keep it, but rank it **below K1 and K13a** and treat
§3.5 (generate the tables only) as the acceptable reduced scope if the
new-artifact cost is judged too high for a capability with no consumer.

---

## 10. STRONG DOUBT

**1. Any design that adds host API surface.** The recommended design
(§3.3) adds **none** — VERIFIED (§7). But note what *would*: option (a)
adds channel marshalling; a "call Rust from JS per WASI call" design
adds a boundary crossing on the hot path. If either is chosen, that is a
V4 regression and must be argued explicitly.

**2. ABI_VERSION.** The recommended design needs **no** ABI bump.
VERIFIED: zero `wasi` in `abi/snapshot.json`, zero `host_` in the shim,
`EXPECTED_HOST_IMPORT_COUNT` untouched. **Option (a) would demand one**
(new channel opcode space = new marshalling). Treat any plan that
reaches for an ABI bump here as a signal the design drifted.

**3. Hot-path regression risk.** Every WASI call is per-call code. The
recommended design removes a JS frame and adds nothing, so it *should*
be neutral-to-better — but **nothing was measured** and no performance
claim may be made. Two specific hazards: (a) if the co-resident module's
channel wait is implemented differently from the TS `Atomics.wait` spin
at `wasi-shim.ts:511`, wake behavior could change; (b) I0 probe 2 must
confirm `memory.atomic.wait32` and `Atomics.notify` interoperate on the
same word.

**4. The region-placement assumption (I0 probe 3).** `fork-module`
places itself via a kernel `SYS_MMAP`, which is sound because SDK guests
route *all* address-space growth through the kernel. **A WASI guest does
not** — `wasi-libc` grows memory itself. Assuming the `fork-module`
placement recipe transfers unexamined is exactly the kind of inherited
floor this campaign has disproved three times. Probe it.

**5. Test coverage is too thin to certify a cutover today.** Three
`.wat` fixtures covering `fd_write`, `args_get`, and scalar fidelity do
not cover `path_open`, `fd_readdir`, `poll_oneoff`, symlink stat, or
sockets. **I2's fixture work is not optional polish; it is the gate.**

---

## 11. Honest sizing

**Bigger than assumed** in three ways:

- It is not 8 pure functions plus constants. It is 46 guest-facing entry
  points, a second implementation of the channel syscall protocol
  (`:490-544`), path resolution, scratch-area allocation, and five
  binary struct re-encoders (`filestat`, `fdstat`, `dirent`,
  `subscription`, `event`).
- It requires a **new versioned wasm artifact** with build, staging,
  browser-alias, and freshness machinery — real work even with the
  `fork-module` template.
- It has **five latent defects** (§5) that a faithful port would carry
  forward and a correct port must adjudicate.

**Smaller than assumed** in three ways:

- **Zero host capability is real.** No `env.host_*`, no `HostIO`, no
  ABI, no `EXPECTED_HOST_IMPORT_COUNT` movement. VERIFIED four ways.
- **Complete isolation.** The WASI branch shares nothing with fork,
  dylink, pthreads, or `buildKernelImports`
  (`worker-main.ts:3291-3363`). Blast radius is one `if` block.
- **~40% of the constants are re-expression**, and the two i64-fiddling
  helpers (~35 lines) disappear outright in a language with `i64`.

**Net:** a well-shaped, genuinely independent Tier-1 item whose real
cost is the new wasm artifact and its plumbing, not the translation —
and whose real payoff is `host-native` gaining WASI, not lines moved.
