# K5 grounding — the TypeScript dynamic linker → Rust

> Read-only grounding. No product code was changed. Worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch
> `integration/k-tier1-20260909` (tip `bd3364c95`).
>
> Companion records: `2026-09-09-rust-first-value-plan.md` (values, the Bar,
> §2b–§2h), `2026-09-09-whole-kernel-rust-migration-census.md` §3 F2,
> `2026-09-09-runtime-ts-disposition-ledger.md`,
> `2026-09-09-k10-wasi-shim-grounding.md` §3.3 (the co-resident-module
> precedent).

## 0. Headline

Five things changed relative to the census and the ledger.

1. **The V1 prize is real and VERIFIED.** `crates/host-native` defines none of
   the six `env.__wasm_dl*` guest imports; they fall to
   `Linker::define_unknown_imports_as_traps` (`crates/host-native/src/lib.rs:212`,
   `crates/host-native/src/guest.rs:4797`). A native guest that calls `dlopen()`
   traps. Moving the linker *gains* a capability.

2. **The claimed four-act floor is REFUTED.** The ledger
   (`runtime-ts-disposition-ledger.md:90`) says the JS-API floor is
   "`new WebAssembly.Instance`, `Memory.grow`/`Table.grow`, `new WebAssembly.Tag`,
   table get/set — four JS-API acts, and only these four." Walking the code
   finds **eight kinds** at **16 call sites**. The three material omissions are
   `new WebAssembly.Module` (compilation), **`new WebAssembly.Global` plus
   `Global.value` get/set** (every GOT cell, `__memory_base`, `__table_base`),
   and **import-object construction** — which is not a plain object but a
   *stateful counting `Proxy`* whose `get` order is engine-observable
   (`host/src/dylink.ts:1793-1888`, with the reason written at `:1877-1881`).
   This is the fifth inherited-and-disproved "floor" of the campaign.

3. **The floor being eight instead of four does not change the verdict.** Every
   one of the eight has a wasmtime-48 equivalent already vendored and, in one
   case, already used by this repo (`wasmtime::Tag::new`,
   `crates/host-native/src/guest.rs:5276`, `:8520`). There is **no wasmtime
   wall**. And the eight collapse into *one* new concept for a host author — a
   `LinkAct` executor — not eight.

4. **Part of K5 is already written and wired to nothing.**
   `crates/fork-codec/src/dylink_archive.rs` (1,318 lines) is a complete Rust
   decoder for the KFLA fork archive, ported from `dylink-fork-archive.ts`, with
   **zero callers** outside its own `pub use`
   (`crates/fork-codec/src/lib.rs:45,69-70`). Its module doc already names the
   remaining work as "a separate follow-on increment for the co-resident module
   (Phase 6 D5+)" (`dylink_archive.rs:65-72`). This is the K1/`sffs.rs` pattern
   exactly: the highest value-per-risk sub-item in K5 is finishing something
   already reviewed.

5. **Three of the four `worker-main.ts` pieces the census assigned to K5 are not
   dlopen work at all.** `patchWasmForThread`, `encodeStartupMetadata` +
   `STARTUP_E*`, and `verifyProgramAbi` have no relationship to dynamic linking
   (§3). Keeping them in K5 mis-sizes both K5 and K4.

**Real consumer count: one product.** PHP (`php.wasm` + `php-fpm.wasm`) loading
six `.so` side modules. Redis imports the protocol but no loadable module exists
in the repo (§6).

---

## 1. What the two files actually are

| file | lines | role |
|---|---|---|
| `host/src/dylink.ts` | 4,188 | `ld.so`: `dylink.0` parsing, placement, symbol scope, GOT, dependency graph, the staged `dlopen` state machine, fork replay of libraries |
| `host/src/dylink-fork-archive.ts` | 2,152 | a **pure binary codec** (KFLA/KFLM/KFLT/KFJP records in guest linear memory) + the pthread table replica |

**Blast radius is small and VERIFIED.** `dylink.ts` is imported by exactly three
files: `host/src/worker-main.ts:18-27`, `host/src/fork-activation-registry.ts:51`
(archive types only), and the public re-export at `host/src/index.ts:70-71`. One
browser test fixture imports it directly
(`apps/browser-demos/test/fixtures/borrowed-dylink-replay-browser-worker.ts:1`).
**It never runs in the kernel worker.** That is the placement constraint, and it
is the same one that decided K10.

### 1.1 The guest-facing contract is six imports, and it is not `env.host_*`

`libc/glue/dlopen.c` is the strong override for musl's stub
(`libc/musl/src/ldso/dlopen.c:4-10` is a `weak_alias` that always fails). It
declares six imports (`libc/glue/dlopen.c:29-36`):

```
__wasm_dlopen_main   __wasm_dlopen_prepare   __wasm_dlopen_next
__wasm_dlsym         __wasm_dlclose          __wasm_dlerror
```

plus `__wasm_dlopen_commit` (`worker-main.ts:2158`), reached through the staged
protocol. These are *process-worker guest imports*, in the same category as
`wasi_snapshot_preview1.*` — **not** part of the 85-import `env.host_*` kernel
contract that V4 measures. `EXPECTED_HOST_IMPORT_COUNT` is untouched by K5 in
either direction. VERIFIED: `grep dlopen crates/shared/src/lib.rs` → nothing;
`grep -c wasi abi/snapshot.json`-style check for dlopen → the only
`abi/snapshot.json`-adjacent mention is the fork-instrument lowering.

The staged shape matters for the design. `dlopen()` in the guest does
(`libc/glue/dlopen.c:127-166`):

```
transaction = __wasm_dlopen_prepare(bytes, len, path, name_len, flags)
for (;;) {
    entry = __wasm_dlopen_next(transaction, &handle);   /* a table index */
    if (entry == 0) break;
    ((void(*)(void))entry)();                            /* guest calls it */
}
```

**The host never re-enters wasm while a dlopen import frame is live.** It hands
back a `void(void)` table index and the guest calls it. That is already an
act-queue protocol driven from the guest side, and it is the reason the linker's
initialization is a `Generator` in TS (`dylink.ts:1119-1157`,
`driveDylinkInitialization` at `:2323`) rather than a straight-line call.
Anything that moves this to Rust inherits a protocol that is *already* shaped
for a non-JS driver.

---

## 2. The split: deterministic computation vs. JS-API acts

### 2.1 Every JS-API act, enumerated (VERIFIED by walking every `WebAssembly.` occurrence)

| # | act | sites in `dylink.ts` | in the claimed four? | reducible? |
|---|---|---|---|---|
| 1 | `new WebAssembly.Module(bytes)` | `:1164`, `:1184` | **no** | no — `Instance` needs a `Module` |
| 2 | `WebAssembly.Module.customSections(m, name)` | `:75` | **no** | **yes** — `readWasmCustomSectionPayload` (`constants.ts:2391`) already reads the same bytes |
| 3 | `new WebAssembly.Instance(module, imports)` | `:1899` | yes | no |
| 4 | `new WebAssembly.Global(type, init)` | `:1591`, `:1595`, `:1704`, `:1741`, `:2090` | **no** | partially (§2.3) |
| 5 | `Global.value` read / write | `:1699`, `:1732-1756`, `:1786`, `:2073-2090`, `:2195`, `refreshGlobalGotEntries` `:997-1023` | **no** | no |
| 6 | `Table.grow` / `get` / `set` | via `growTable` `:489`, `getTableEntry` `:494`, `setTableEntry` `:503`; 12 call sites | yes | no |
| 7 | `Memory.grow` | `growMemory` `:514`, one call site `:1552` | yes | **already unused in production** (§2.4) |
| 8 | `new WebAssembly.Tag(type)` | `createLongjmpTag` `:1044`, `createCppExceptionTag` `:1055` | yes | no |
| 9 | import-object construction: three `Proxy` namespaces + JS trampoline closures | `:1793-1888`, self-import thunk `:1841-1848` | **no** | no (§2.2) |

**16 act call sites in 4,188 lines.** Everything else — `parseDylinkSection`
(`:263-364`), `readDefinedFunctionExports` (`:365`), `alignUp` (`:393`),
`wasmAddress`/`requireWasmAddress` (`:410`, `:417`), `symbolOwners` (`:866`),
`functionTableIndex` (`:875`), `isPublicDylinkExport` (`:886`),
`publishGlobalLibrarySymbols` (`:900`), `promoteLibraryGlobal` (`:918`),
`appendDependencyScope` (`:938`), `runtimeDependencyNames` (`:962`),
`scopedSymbol` (`:973`), `refreshGlobalGotEntries`' *decisions* (`:997`), the
whole `DynamicLinker` state machine (`:2594-4188`), and the entire
`dylink-fork-archive.ts` codec — is deterministic computation over bytes,
integers and name maps.

**Answer to the brief's item 1: the four-act claim is refuted. The proven floor
is eight kinds / 16 sites, and only #2 and #7 shrink.** The two additions that
matter are #4/#5 (Globals) and #9 (the import object).

### 2.2 Why the import object is a genuine floor, and a subtle one

`dylink.ts:1877-1881` states the constraint in the source:

> Imported global/table identity is observable only while WebAssembly lazily
> resolves this exact proxy graph. Give the process owner one synchronous
> wrapper boundary; eager enumeration would collapse duplicate `(module, name)`
> declarations and capture the wrong provider.

`wasm-ld` can emit two import entries with the same `(module, name)`. The JS API
resolves imports **in declaration order**, calling `Get` once per entry, so a
stateful `Proxy` can return a *different* value on the second read — which is
exactly what `functionImportReads` (`:1785-1789`) does. A plain object cannot
express that; a JS `Map` keyed by name cannot either.

This is not reducible in a browser. It *is* trivially expressible natively:
`wasmtime::Instance::new(store, module, &[Extern])` takes an **ordered slice**
positionally. So the Rust core should produce an **ordered `Vec<ImportBinding>`,
one entry per import declaration** — the shape wasmtime wants, and the shape a
~25-line JS counting `Proxy` can consume. That is the correct interface, and it
is *better* than today's design because the ordering dependency becomes explicit
data instead of an emergent property of proxy traps.

### 2.3 `new WebAssembly.Global` is unavoidable — and it is not cheap

GOT cells are `(global (mut i32))` **imports** of the side module
(`GOT.mem.<sym>`, `GOT.func.<sym>`). There is no wasm instruction that
constructs a global at runtime, so a co-resident wasm module cannot make them.
VERIFIED, and it is load-bearing: every one of PHP's six side modules imports
GOT cells.

```
$ wasm-objdump -j Import -x local-binaries/source-only-v1/programs/wasm32/php/*.so
curl.so       GOT.func   10   GOT.mem   18
intl.so       GOT.func 1646   GOT.mem  823
opcache.so    GOT.func    8   GOT.mem   29
phar.so       GOT.func    2   GOT.mem   26
zend_test.so  GOT.func    7   GOT.mem   21
zip.so        GOT.func    4   GOT.mem    6
```

`intl.so` alone forces **2,469 `new WebAssembly.Global` allocations** on one
`dlopen`. (For scale: `intl.so` is 13.2 MB with `mem_size 570,364`,
`table_size 2,357`, 566 function imports; `opcache.so` is 489 KB with
`mem_size 45,840`, `table_size 57`, 199 function imports.)

*One reduction exists and is recorded but NOT recommended for a first cut:* a
Rust core can **synthesize a small wasm module** whose exports are exactly the N
mutable globals a side module needs, compile it once, and hand
`instance.exports` straight in as the `GOT.mem` / `GOT.func` namespace object.
That collapses N `Global` constructions into one `Module`+`Instance` pair. It is
clever, it is measurable, and it is a *performance* change with a correctness
surface (global identity must stay stable across later interposition). It does
not belong in a migration whose gate is behavioral equivalence.

### 2.4 `Memory.grow` is already dead in production — the K10 caveat does not apply

The brief asks whether the K10 placement finding (the `fork-module` `SYS_MMAP`
recipe does not hold for guests that grow their own memory) transfers. **It does
not, and the reason is decisive.**

VERIFIED: `dylink.ts:1531-1533` takes the `options.allocateMemory` branch
whenever the caller supplies an allocator, and `worker-main.ts:1904-1907` always
supplies one. That allocator is a **synchronous `SYS_MMAP` on the syscall
channel** (`worker-main.ts:1516-1560`: writes `SYS_MMAP_NR` into `CH_SYSCALL`,
`Atomics.notify`, `Atomics.wait`, reads `CH_RETURN`). The `growMemory` fallback
at `:1552` is reached only when no allocator is passed, and its own comment says
so: *"for standalone linker tests and non-POSIX embedders."*

**dlopen guests are SDK-built by construction** — `libc/glue/dlopen.c` is linked
in only by the Kandelo SDK when `-ldl` is seen (`sdk/src/lib/flags.ts:430`,
`sdk/src/bin/cc.ts:362`, `sdk/kandelo/bin/wasm32posix-cc:263,662`). A guest that
can call `dlopen` at all routes address-space growth through the kernel. That is
the opposite of the WASI case, where `wasi-libc` grows memory itself. **K10's
I0 probe 3 concern does not transfer to K5.**

---

## 3. The `worker-main.ts` pieces — what is in K5 and what is not

The census (`census.md:139-147`) bundles four items into K5. Only two belong.

| piece | in K5? | evidence | what moving it requires |
|---|---|---|---|
| **dlopen reader/writer lock** (`DLOPEN_LOCK_IDLE/WRITER/MAX_READERS`, `DLOPEN_{HEAD,LOCK,OWNER,GENERATION}_OFFSET_WASM{32,64}`) | **YES — core** | `worker-main.ts:2861-2905`, used at `:1209-1217`, `:1311-1465` | see §3.1 |
| **`hasCompleteForkInstrumentation`** | **shared with K12** | `worker-main.ts:3161`; a *second* implementation inline at `dylink.ts:1228-1229`; a *third* as `wasmHasCompleteForkInstrumentation` (`constants.ts:2434`) | see §3.2 |
| `patchWasmForThread` | **NO** | `worker-main.ts:5976`; called from `browser-kernel-worker-entry.ts:3505` and `node-kernel-worker-entry.ts:3264` — i.e. the **kernel** worker rewriting program bytes before spawning a *thread* worker. Zero dlopen involvement | belongs to **K4** (unify the two worker entries — it is called from both, which is precisely K4's duplication thesis) or to build-time `fork-instrument`, which already owns wasm rewriting in Rust with `walrus` |
| `encodeStartupMetadata` + `STARTUP_E*` | **NO** | `worker-main.ts:337-342`, `:367-419`; encodes argv/environ for the `kernel.*` CRT startup imports (`buildKernelImports`, `:421`). Nothing to do with linking | belongs to **`crates/shared`** (it is a wire format with an errno set) driven by **K4** |
| `verifyProgramAbi` | **NO** | `worker-main.ts:3228`; an `__abi_version` marker check | belongs to **K13**/ABI, or K4 |

**RECOMMENDATION: re-scope K5 to `dylink*.ts` + the dlopen lock, and move
`patchWasmForThread` / `encodeStartupMetadata` / `verifyProgramAbi` to K4.**
The census's ~9,000-line figure for K5 is inflated by roughly 900 lines of
unrelated work; K4's is understated by the same amount.

### 3.1 The dlopen lock: what moving it requires

The lock lives in the **host-private control prefix of the process's fork-save
scratch page**, below the fork buffer (`worker-main.ts:2860-2863`). Four words:

- `HEAD` — the archive head pointer, so a fork child's copied memory carries the
  parent's archive (`:2864-2865`).
- `LOCK` — a reader/writer word. Negative (`DLOPEN_LOCK_WRITER = -1`) is the
  exclusive main-worker dlopen writer; positive counts concurrent pthread forks
  from their pre-unwind archive check through memory copy / `SYS_FORK` / parent
  rewind (`:2866-2874`, protocol at `:1311-1465`).
- `OWNER` — positive identity of the Worker whose ordinary wasm stack owns every
  live staged loader transaction; a lease spanning bootstrap, relocations and
  constructors (`:2875-2880`).
- `GENERATION` — a naturally aligned u64 fence so *instrumented wasm* can detect
  a newer process table snapshot **without crossing into JavaScript**
  (`:2881-2885`).

Moving it requires three things and **no ABI bump**:

1. The four offsets move into `crates/shared` beside
   `FORK_SAVE_CONTROL_PREFIX_SIZE` (`crates/shared/src/lib.rs:1990`), which is
   already there and already generated into
   `host/src/generated/abi.ts:933`. Today the four pairs are **TS-only,
   hand-maintained** — VERIFIED: `grep DLOPEN crates/shared/src/lib.rs` → no
   matches. That is the exact V2 duplication class. Additive to the snapshot;
   ABI 44 is unreleased and amendable (`docs/abi-versioning.md:790-794`, per the
   K13a decision).
2. The protocol itself becomes Rust in the co-resident module: it is
   `Atomics.compareExchange` / `load` / `store` on a shared `Int32Array`, which
   is `i32.atomic.rmw.cmpxchg` / `i32.atomic.load` / `i32.atomic.store` on the
   guest's shared memory. **No host import.** This is the same claim K10 made
   for `memory.atomic.wait32` and it is stronger here, because the dlopen lock
   never blocks — `:1393-1425` spins with bounded retries, it does not
   `Atomics.wait`.
3. The `GENERATION` fence already reaches the co-resident fork module as a
   `WebAssembly.Global` import (`worker-main.ts:2943-2945`, `:3989`, `:6854`,
   consumed via `fork-activation-registry.ts:117`). The wiring exists.

### 3.2 The triple authority on "is this artifact fork-instrumented?"

Three independent implementations of the same predicate, VERIFIED:

- `constants.ts:2434` `wasmHasCompleteForkInstrumentation(programBytes)` — over
  raw bytes.
- `worker-main.ts:3161` `hasCompleteForkInstrumentation(module, pid)` — over
  module exports, plus the Asyncify-rejection and capability-claim throws.
- `dylink.ts:1228-1229` — an inline `const` over `moduleExports`, with its own
  near-identical throws at `:1275-1281`, `:1290-1300`, `:1301-1327`.

This belongs to **K12** (fork surface) more than K5, but K5 cannot avoid
touching the third copy. Recommendation: K5 deletes its own copy in favor of
whichever single authority K12 lands, and does not invent a fourth.

### 3.3 `constants.ts` is misclassified in the ledger

The ledger (`runtime-ts-disposition-ledger.md:128`) says `constants.ts` is
**KEEP**, "a re-export shim over the generated ABI with only 7 own
declarations." That is wrong. It is **~2,900 lines of a hand-written wasm binary
parser and fork-artifact contract validator**: `readULEB128`/`readSLEB128_i32`/
`_i64` (`:114`, `:130`, `:150`), a full type-section reader including GC
composite types and subtypes (`:203-438`), an instruction-immediate skipper
(`:446-536`), import/export descriptor decoders (`:2252`, `:2311`), custom
section readers (`:2353`, `:2391`), and eleven `validateFork*` functions
(`:1050-1947`).

`crates/fork-instrument` already parses and rewrites wasm in Rust with `walrus`
0.26.4 + `wasmparser` 0.247 (`crates/fork-instrument/Cargo.toml`). This is a
census correction with real weight — it is duplicated wasm-format authority, not
a shim — but it is **K12's**, not K5's. Recorded here so it is not lost.

---

## 4. Where it should live

### 4.1 The constraint that decides it (same shape as K10 §3.0, different answer)

The linker must **mutate the guest's own `WebAssembly.Table` and linear
memory**, and must **instantiate modules into the guest's import graph**.
Neither is reachable from the kernel worker: a `WebAssembly.Table` cannot be
transferred or shared between workers, and the kernel only ever sees the syscall
channel. **`crates/runtime-core` behind kernel exports is refuted for the
executor**, exactly as K10 refuted option (a).

But the K10 answer — *put the whole thing in a co-resident PIC module* — does
**not** transfer cleanly, and this is the sharpest finding in this grounding:

> **K10's `wasi-module` works because every act a WASI call performs is a
> syscall on the channel, which wasm can do unaided. K5's acts are JS-API
> object constructions, which wasm fundamentally cannot perform.**

A co-resident `dylink-module` could do #6 (`table.grow`/`get`/`set` on an
imported table) and #7 (`memory.grow`) natively. It **cannot** do #1
(`new Module`), #3 (`new Instance`), #4/#5 (`new Global`, `Global.value`), #8
(`new Tag`), or #9 (import object). Those would have to become imports of the
dylink module — a new process-worker↔module capability contract. That is host
surface growth wearing a Rust disguise, and V4 forbids it without proof of
necessity.

### 4.2 The recommended shape: one Rust core, three thin executors

```
crates/dylink            no_std, no wasm assumptions, no JS assumptions.
                         dylink.0 parsing; placement arithmetic; symbol scope
                         and interposition; the GOT plan; the dependency graph;
                         the element-segment→table-index map; the staged
                         dlopen/dlsym/dlclose state machine; handle allocation.
                         Emits an ordered `Vec<LinkAct>` and consumes
                         `Vec<ActResult>`. Unit-tested with plain `cargo test`.

fork-codec::dylink_archive   ALREADY EXISTS (decoder). Gains the encoder and the
                         SHA-256 template digest. Reads/writes the KFLA image in
                         guest memory. Zero acts.

executors (thin):
  host/src/dylink-exec.ts     ~250-400 lines. Performs the 8 act kinds.
  crates/host-native          performs them with wasmtime. NEW CAPABILITY.
  (browser/Node only)         the counting import Proxy stays here, ~25 lines.
```

`LinkAct` is a typed enum — `Compile{bytes}`, `NewGlobal{ty, init}`,
`SetGlobal{id, value}`, `TableGrow{delta}`, `TableSet{index, func_id}`,
`NewTag{ty}`, `Instantiate{module_id, bindings: Vec<ImportBinding>}`,
`ReadExports{instance_id}` — and `ImportBinding` is **ordered per import
declaration**, which is what makes both the JS counting-Proxy and
`wasmtime::Instance::new`'s positional slice fall out naturally (§2.2).

**Where does the Rust core execute in the browser?** Two sound answers, and the
grounding deliberately does not pick between them because they are separable and
the first is cheaper:

- **(α) Compile `crates/dylink` to a small wasm module that the process worker
  instantiates with no guest coupling.** It imports `env.memory` (to read the
  `.so` bytes the guest handed to `__wasm_dlopen_prepare`, and to read/write the
  KFLA archive) and nothing else, exactly like `fork-module`'s import list. Acts
  are drained from a queue in guest memory by the JS executor. Zero new imports
  on either side.
- **(β) Fold it into the existing `crates/fork-module`.** It already imports the
  guest memory, already reasons about N dlopen activations
  (`crates/fork-module/src/lib.rs:22-23`, `:304`, `:1873-1874`, `:2732`,
  `:4032`), already receives the dlopen generation-fence address, and
  `fork-codec::dylink_archive`'s own doc names the co-resident module as the
  destination (`dylink_archive.rs:65-72`). No new artifact, no new build/staging/
  Vite-alias/freshness machinery — which K10 identified as its real cost.

**(β) is cheaper and better-precedented; (α) is cleaner isolation.** This is a
NEEDS-DEFER-DECISION (D3, §10).

**Crucially, neither choice gates the V1 prize.** `crates/host-native` links
`crates/dylink` as an **ordinary Rust library** — no wasm module, no queue, no
JS. Native `dlopen` is deliverable before any browser decision is made (§9).

### 4.3 D3 ADJUDICATED (2026-09-10, K5 I7): (β) is refuted, (α) is forced

§4.2 offered two placements for the Rust core on the JavaScript hosts and
called **(β) fold it into `crates/fork-module`** "cheaper and better-
precedented". **That recommendation is wrong, and the reason is the
generic-first rule (value plan §1, BINDING).**

**(β) is REFUTED.** The co-resident fork-module is instantiated inside
`if (hasForkInstrumentation) {` (`host/src/worker-main.ts:3473`, the module
required-or-fatal at `:3566-3577`). The dlopen imports are **not** so gated:
`buildDlopenImports` has three call sites, and the one at
`host/src/worker-main.ts:5533` sits in the **non**-instrumented branch —
directly after `kernel_fork` is stubbed to throw "reached without complete
wasm-fork-instrument exports" (`:5525-5530`). So a process with no fork
instrumentation has full `dlopen` today.

Folding the planner into the fork-module would make `dlopen` reachable only
from fork-instrumented processes. `dlopen`/`dlsym`/`dlclose` are POSIX
interfaces with no relationship to `fork`, and coupling them to a Kandelo
build-time instrumentation pass is exactly the "facility for the packages that
happen to use it today" that generic-first forbids — PHP is fork-instrumented,
so the regression would be invisible in the only artifact that exercises the
path. Instantiating the fork-module unconditionally instead is not a repair:
it charges every non-forking process the ~5.4 MiB co-resident region.

**A third option was considered and is also refuted.** (ζ) link `crates/dylink`
into the **kernel** and drive it from the process worker over the syscall
channel — attractive because new kernel exports cost no host surface, no new
build artifact exists to stage, and `PlanStep::Host`'s `SYS_MMAP` steps would
become internal. It fails on memory access: the kernel reaches a process's
linear memory only through `HostIO` (`crates/runtime-core/src/memory.rs:1515`
`process_memory_len`) and channel scratch, never directly. Both of the
linker's large inputs — the `.so` image and the KFLA archive — live in guest
linear memory, so every `dlopen` would marshal them across the channel. It
also puts `ld.so`, which is per-process userspace state, inside the shared
kernel.

**(α) is therefore forced**: a standalone wasm module the process worker
instantiates. One property makes it cleaner than §4.2 assumed — it needs
**zero imports**, not even `env.memory`. The driver already copies the `.so`
bytes out of guest memory before calling in (`worker-main.ts:2009-2019`), so
the module can own its linear memory outright and the driver reads results
back out of it. That is a smaller host contract than fork-module's ten
`env.*` imports.

**(α)'s cost is now measured, and it is the part to plan around: 14
integration points**, in four clusters —

1. **Build (3):** workspace member, `crate-type = ["cdylib", "rlib"]`, and a
   `build-wasm.sh` modeled on `crates/fork-module/build-wasm.sh` that stages to
   **both** `local-binaries/` and `host/wasm/` and writes a `.build-key`.
2. **Freshness (2):** `tools/xtask/src/cargo_closure.rs` `BUILD_TOOL_CRATES`
   and a `verify_fresh_*` in `tools/xtask/src/local_build.rs:842`. The story is
   two-layer: `build-wasm.sh --verify-fresh` checks the staged artifact against
   its stamp, while `xtask verify-fresh` checks the **projected** copy against
   the recomputed closure and the manifest's size/sha256. Implementing only the
   first reproduces the failure recorded at `local_build.rs:818-826`.
3. **Projection (4):** `ensure_*_built`, a projection node, node append plus
   member staging, and the clean-no-op fast path (`local_build.rs:1794-1797`,
   `:2302-2482`, `:2551-2573`, `:1984`).
4. **Hosts (5):** `host/src/binary-resolver.ts:1730-1742` projection
   admission; the Node compile site and `InitData` fields
   (`host/src/node-kernel-worker-entry.ts:166-196`,
   `host/src/worker-protocol.ts:49,179`); and **four** independent browser
   registrations — the capability contract
   (`apps/browser-demos/browser-module-contract.mjs:26-35`), the Vite alias
   (`apps/browser-demos/vite.config.ts:363-386`), a `?url` artifact module plus
   the fetch/transfer/compile chain (`host/src/browser-fork-module-artifact.ts`
   as the model, `host/src/browser-kernel-host.ts:217-222,429,502,526`,
   `host/src/browser-kernel-protocol.ts:76`,
   `host/src/browser-kernel-worker-entry.ts:151-162,1391-1392` and the six init
   spread sites). A miss in any browser registration fails **only** in a
   SourceOnly browser build, never in Node tests.

**`crates/wasi-module` is the negative example and should be read as one.** It
has a correct `build-wasm.sh` with a correct freshness stamp and **zero**
pipeline integration: no `ensure_*_built`, no projection node, no
`binary-resolver` admission, no Vite alias, no host compile site. Its only
consumers are `crates/host-native` and a manual `node` harness. Cluster 1 done
and clusters 2-4 missing is not partial progress toward a browser cutover; it
is the state K10 I6 is still owed from.

---

## 5. The fork seam

### 5.1 The seam is narrow and already an interface

`dylink.ts` reaches fork through exactly one interface,
`DylinkForkActivationOwner` (`dylink.ts:629-632`), with a four-method
`PreparedDylinkForkActivation` (`:608-627`):

```
prepare(request) -> PreparedDylinkForkActivation
  .activationId
  .env                          // fork/frame/module/reference/exception/GC imports
  .savedMutableGlobalImport?()  // exact KFMS value for a mutable scalar
  .wrapImports(imports)         // wraps the lazy import object pre-instantiation
  .register(instance) / .unregister()
```

The implementation lives on the fork side (`createProcessDylinkActivationOwner`,
`worker-main.ts:756-950`) and is *already* Phase-6-inverted: `:875` and `:905`
are the module-backed FRAME FLIP and REFERENCE FLIP. **The completed fork
inversion sits behind this seam, not inside `dylink.ts`.**

### 5.2 The three entanglement points, precisely

1. **`wrapImports` observes the engine's exact property reads** (`:1877-1881`).
   This is the one place where a Rust core's output shape is constrained by the
   fork side: an eager, name-keyed import map would break duplicate-`(module,
   name)` provider capture. §2.2's ordered `Vec<ImportBinding>` satisfies it.
   This is the single hardest constraint in K5 and it must be honored by
   construction, not discovered by test.

2. **The KFLA archive is shared state with three readers.** `dylink.ts` writes
   it via `DylinkForkArchive` (`dylink-fork-archive.ts:399`); a fork child
   replays it before `wpk_fork` rewind; every pthread worker of the process must
   reconcile to the latest generation (`DylinkForkTableReplica`, `:112`;
   `createProcessTableReplicationOwner`, `worker-main.ts:2919+`). The replica
   exists because **`WebAssembly.Table` is per-worker**: each pthread Worker
   instantiates the program separately and therefore owns its own table and its
   own side-module instances. That is an inherent wasm property, and it is
   equally true of wasmtime (tables are `Store`-bound), so the Rust core serves
   both. This is not a browser quirk to be deleted.

3. **Fork-artifact admission is checked inside the loader**
   (`dylink.ts:1275-1400`): complete `wpk_fork_*` side exports, the
   `FORK_CAP_ACTIVATION_STATE_SAFE` capability claim, `__abi_version` equality
   with `ABI_VERSION`, and `describeWasmForkArtifactContractFailures`. These are
   K12's contracts evaluated at K5's call site.

### 5.3 Verdict

**K5 can proceed without disturbing the completed fork inversion**, on three
conditions:

- The Rust core produces an **ordered** import binding list (§2.2), and the JS
  executor's counting Proxy is fed from it. Anything that flattens to a name map
  breaks (1).
- `crates/dylink` treats `DylinkForkActivationOwner` as an **opaque trait**
  implemented by the executor, not something it re-implements. The fork side
  keeps ownership of activations, frame flips and reference flips.
- The KFLA encoder proves **byte-for-byte equivalence** with the TS writer
  before either side is deleted. The decoder half is already written and can be
  used as an independent cross-check today (`dylink_archive.rs`).

Two things the fork side must be told, because they are *improvements* K5 makes
and the fork tests will observe:

- `functionTableIndex` (`dylink.ts:875-884`) is an **O(n) linear scan of the
  whole table comparing JS `Function` identity**, run once per GOT.func symbol.
  For `intl.so` that is 1,646 scans of a ≥2,357-entry table. A Rust core does
  not need identity comparison at all: it maintains `symbol → table index` as it
  installs entries, and for the *main module's* pre-existing functions it derives
  the map by parsing the element segments and export section — deterministic
  over the final bytes. This removes a quadratic path and an identity operation
  in one move. It is a behavior-preserving change with a **measurable**
  performance consequence, so it needs benchmark evidence before any claim
  (`docs/agent-guidance/performance.md`).
- `refreshGlobalGotEntries` (`:997-1023`) silently writes `0` for an unresolved
  GOT symbol (`:1022`). That is a NULL that surfaces later as a guest crash
  rather than a loader error. Whether that is correct lazy-binding behavior or a
  truthful-failure violation is a real question (§10, D4) — it must be
  adjudicated, not ported blind.

---

## 6. Who actually uses `dlopen` (the regression surface)

The prior campaign claim — "php, php-fpm and redis-server do runtime `table.set`
via `env.__wasm_dlopen`" — is **partially confirmed and wrongly worded**.

**The import name is dead.** Nobody imports monolithic `env.__wasm_dlopen`. All
three import the ABI 43 staged triple. The instrumenter *rewrites* the legacy
form (`crates/fork-instrument/src/legacy_dlopen.rs:22-26`) and publication
rejects it (`tools/xtask/src/build_deps.rs:14805-14817`; the check itself is
`constants.ts:1963-1970`).

VERIFIED with `wasm-objdump -j Import -x`:

| artifact | staged dlopen imports | `dylink.0` | real runtime dlopen? |
|---|---|---|---|
| `local-binaries/source-only-v1/programs/wasm32/php/php.wasm` | yes | no (main) | **YES** |
| `…/php/php-fpm.wasm` | yes | no (main) | **YES** (+ fork-replays dlopens into workers) |
| `local-binaries/programs/wasm32/redis/redis-server.wasm` | yes | no (main) | **NO** — see below |

**Redis must be reclassified.** Its `dlopen` caller is Redis's own module API
(`packages/registry/redis/redis-src/src/module.c:12147`), pulled in by upstream's
`src/Makefile:149` (`FINAL_LIBS += -ldl`). **No Redis module `.so` is built or
shipped anywhere in this repo**: `packages/registry/redis/package.toml:21-27`
declares only `redis-server` and `redis-cli`, and
`images/vfs/products/browser-redis.toml` ships `outputs = ["redis-server"]`. It
is a *link-time symbol retainer with no loadable modules*, not a runtime
consumer.

**PHP is the entire product regression surface.** Six side modules, all built
with `wasm32posix-cc -shared -fPIC` in `packages/registry/php/build-php.sh`:
`opcache.so` (`:1191`), `curl.so` (`:1221`), `phar.so` (`:1246`),
`zend_test.so` (`:1270`), `zip.so` (`:1283`), `intl.so` (`:1328`, adds
`-Wl,--export=__tls_base`). Two support packages exist *only* to feed them:
`libcxx` builds a second `-fPIC` variant of libc++/libc++abi
(`packages/registry/libcxx/build-libcxx.sh:328-337`) and `icu` is `-fPIC`
because it is absorbed into `intl.so`
(`packages/registry/icu/build-icu.sh:227-236`).

**Shipped in images:** `browser-lamp.toml:20`, `browser-wordpress.toml:20`,
`browser-nginx-php.toml:20` each ship `["php", "php-fpm", "opcache"]`;
`test-php.toml:20-21` ships all six plus `icu-data`. The builders write the
`.so` and the `zend_extension=` ini line
(`images/vfs/scripts/build-lamp-vfs-image.ts:219,222,557-558`;
`build-wp-vfs-image.ts:214,217,465-466`;
`build-nginx-php-vfs-image.ts:132,260,338-339`;
`build-php-test-vfs-image.ts:309-310,424-479` enforces the `intl.so` ⇄ `icu.dat`
pairing).

**Other `dylink.0` users** (not via `dlopen()`): `fork_module32/64.wasm` — the
existing co-resident PIC module, host-loaded. **Examples/tests:**
`examples/dlopen/{main.wasm,hello-lib.so}`,
`host/test/fixtures/{vfork-side-module.c,vfork-side-main.c,dlopen-main-scope.c}`.

**Explicit negatives, VERIFIED (0 dlopen imports despite upstream plugin
architectures):** `perl`, `ruby`, `cpython`, `tcl`, `node`, `nginx`, `mariadbd`,
`spidermonkey-node`, `sqlite3`, `vim`, `git`, `curl`, `redis-cli`. `-ldl`
reaches several (`git/build-git.sh:204`, `libcurl/build-libcurl.sh:166,427`) but
`dlopen` is never referenced so the glue is GC'd; `tcl/build-tcl.sh:88-91`
strips `-ldl` outright.

**Consequence for the gate: WordPress, LAMP and nginx-php browser demos are
K5's real acceptance test**, because every one of them `dlopen`s `opcache.so` at
PHP startup. Per the browser contract, K5's cutover is not complete from code
reasoning or Node alone.

---

## 7. Test coverage today

| file | cases | level |
|---|---|---|
| `host/test/dylink.test.ts` | 80 (77 `it`, 3 `it.each`) | 39 pure-unit + ungated; 32 gated on `wasm32posix-cc`; 8 gated on `WebAssembly.Tag`; 1 on `wasm64posix-cc` + memory64; 4 on `wat2wasm` |
| `host/test/dylink-fork-archive.test.ts` | 12 | pure unit — round-trip, ordering, generation publication, sealed table root, patch journal, hash-corruption / record-cycle / duplicate-identity rejection, pointer-width binding. **No fixtures.** |
| `host/test/dlopen-host-imports.test.ts` | 8 | unit over `buildDlopenImports`; side module is a hex literal (`:41-51`) |
| `host/test/dlopen-e2e.test.ts` | 5 | full guest via `runCentralizedProgram`; builds `.so` + main at test time; one wasm64 case |
| `host/test/fork-dlopen-replay-e2e.test.ts` | 6 | full guest + real fork; runs `scripts/run-wasm-fork-instrument.sh` on each `.so` (`:90-113`) |
| `host/test/fork-from-dlopen-side-module-e2e.test.ts` | 7 | full guest + real side modules; `:513` resolves a real DT_NEEDED closure through `MemoryFileSystem` |
| `host/test/process-table-replication.test.ts` | 3 | unit; imports `DylinkForkArchive` / `DylinkForkTablePatch` (`:7-9`) |
| `examples/dlopen/test.test.ts` | 1 | full guest; in-scope via `host/vitest.config.ts:34-40` |
| `apps/browser-demos/test/dlopen-main-scope.spec.ts` | 1 | Playwright, `dlopen(NULL)` main scope |
| `apps/browser-demos/test/borrowed-fork-replay.spec.ts` | 1 | Playwright; drives `loadSharedLibrarySync` inside a browser Worker (120 s timeout) |

Notes that matter for planning:

- **`dylink-fork-archive.test.ts`'s 12 cases are a ready-made differential
  target.** They are pure-unit with no fixtures, which means a Rust encoder can
  be held to the same 12 assertions plus byte equality.
- **No `@slow` tag on any dylink/dlopen test.** Both Playwright specs run in the
  `test:fast` browser lane (`apps/browser-demos/package.json:11`). So the
  browser gate is cheap to run.
- Two env escapes turn silent skips into hard failures and should be set for
  K5's gate: `KANDELO_REQUIRE_CPP_DYLINK_FORK_E2E=1`
  (`fork-dlopen-replay-e2e.test.ts:81`) and
  `KANDELO_REQUIRE_SIDE_MODULE_FORK_E2E=1`
  (`fork-from-dlopen-side-module-e2e.test.ts:45`).
- Coverage is **thin exactly where PHP lives**: nothing exercises 2,469 GOT
  cells, TLS side-module bases (`intl.so`'s `--export=__tls_base`), or a
  six-module dependency closure. Like K10's `.wat` fixtures, **fixture breadth is
  the gate, not polish.**

### 7.0 The deletion gate SKIPS SILENTLY on a fresh worktree (measured 2026-09-10)

Every `dlopen` suite that proves a real load — `dlopen-e2e`,
`fork-dlopen-replay-e2e`, `fork-from-dlopen-side-module-e2e`, **18 tests, the
entire Node half of I7's deletion gate** — is guarded by
`describe.skipIf(!hasSysroot || !hasKernel || !hasCompiler())`
(`host/test/dlopen-e2e.test.ts:74`, `:23-26`). `hasKernel` tests for
`binaries/kernel.wasm` **or** `local-binaries/kernel.wasm`.

`./run.sh setup` on a fresh worktree does **not** produce either path. It
leaves the kernel at `local-binaries/source-only-v1/kernel.wasm` — the
projection — and the ambient symlink the tests look for is absent (the stale-
projection defect recorded in `docs/future-improvements.md`, in its
never-created form rather than its stale form). It also stages no
`fork_module32.wasm`.

So the first run reports **`3 passed | 3 skipped`, exit 0 on the suites that
matter, and 100 green unit tests**. An agent who runs "the dlopen Vitest
suites", sees green, and concludes the linker still works after a cutover will
have proven **nothing about `dlopen` at all** — only that the pure-unit parsers
still parse. This is the exact shape of the "narrow check supporting a broad
claim" the validation contract forbids, and it is pre-armed: the skip is
silent and the exit code is zero.

**Provision all three before believing a dlopen result:**

```
scripts/dev-shell.sh npm --prefix host install     # vitest is a host/ devDep;
                                                   # root has no workspaces
scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh
WASM_POSIX_LOCAL_INSTALL_SOURCE=$PWD/local-binaries/source-only-v1/kernel.wasm \
WASM_POSIX_LOCAL_INSTALL_SESSION=<session> \
  scripts/dev-shell.sh scripts/xtask.sh build-deps --arch wasm32 \
    --binaries-dir local-binaries install-local-artifact kernel kandelo-kernel.wasm
```

**Baseline once provisioned (base `8a89c2f4a`, Node, this worktree):
`Test Files 1 failed | 5 passed`, `Tests 116 passed | 2 failed` of 118.** The
two failures are the tracked pthread-hosted `__wpk_fork_frame_reserve` import
gap (`docs/future-improvements.md`, and §7.1 below) — pre-existing, not K5's,
and the number I7 must still show after the cutover. Anything other than
exactly those two is a regression the cutover introduced.

### 7.1 The two pthread-hosted failures are NOT K5's

VERIFIED tracked at `docs/future-improvements.md:758-786`:

> **Wire the pthread worker's fork-module frame imports so a dlopen'd
> fork-instrumented side module can instantiate on a foreign pthread.** The two
> pthread-hosted dlopen tests in `host/test/fork-dlopen-replay-e2e.test.ts`
> ("replays pthread-hosted dlopen table state into a fresh fork child" and
> "blocks a foreign pthread until the staged loader owner commits") fail with
> `WebAssembly.Instance(): Import "env" "__wpk_fork_frame_reserve": function
> import requires a callable`. This is pre-existing (baseline red before the
> fork control-flow inversion, not caused by it) … Root cause: the pthread
> worker in `host/src/worker-main.ts` builds `threadForkModuleInstance` /
> `threadForkModuleBackend` but never constructs a thread-side
> `ForkModuleTrampolines`, and `replicaActivationOwner` is created without a
> `forkModuleFrameFlip`…

The two cases are `fork-dlopen-replay-e2e.test.ts:494` and `:575`. The three
main-thread siblings (`:265`, `:340`, `:419`) pass; the sixth (`:707`, C++
throw/catch) is separately gated on `libc++-pic.a`.

**Confirmed still-tracked, cause unchanged, fix located in
`host/src/worker-main.ts`'s fork wiring — not in the linker.** There is no
`it.skip`/`it.fails` marker, so they are genuinely red when prerequisites are
present. **K5 must not fix them and must not be blamed for them.** They are
K12's or a dedicated follow-up's. K5's own gate must record them as expected-red
by name, the way §2e/§2f record the campaign's other pre-existing failures.

*(Not re-run. Running anything under `host/vitest.config.ts` triggers
`globalSetup: ["test/global-setup.ts"]`, which compiles C fixtures and writes
`.wasm` into the tree — outside this grounding's read-only mandate. The
confirmation above is from the tracked entry and from name-matching the two
cases.)*

---

## 8. Native `dlopen`: what it takes

### 8.1 STRONG DOUBT discharged — there is no wasmtime wall

Every one of the eight acts has a wasmtime-48 API, VERIFIED in the vendored
source at
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/wasmtime-48.0.1`:

| act | wasmtime API | note |
|---|---|---|
| compile | `Module::new` | already used throughout `guest.rs` |
| instantiate | `Instance::new` (`src/runtime/instance.rs:115`) | takes an **ordered `&[Extern]`** — solves §2.2 for free |
| new global | `Global::new` (`externals/global.rs:99`) | |
| global get/set | `Global::get` `:148` / `Global::set` `:233` | |
| table grow/get/set | `Table::grow` (`externals/table.rs:324`), `get` `:202`, `set` `:255` | |
| memory grow | `Memory::grow` | unused in production anyway (§2.4) |
| new tag | `Tag::new` (`externals/tag.rs:36`) | **already used**: `guest.rs:5276`, `:8520` |
| import object | n/a — the ordered slice *is* the import object | strictly simpler than the browser |

Wasmtime 48 was already adopted for the exceptions proposal
(`crates/host-native/Cargo.toml`), which is what makes `Tag::new` available.
The claim "native dlopen needs a wasmtime feature we do not have" is **refuted**.

### 8.2 Sizing native `dlopen`

What host-native must add, given `crates/dylink`:

1. **A `LinkAct` executor** over `Store<()>` — the eight acts above, plus an
   `Extern` id table. **~300-450 lines.** Mechanical.
2. **The six `env.__wasm_dl*` `func_wrap` registrations** (`lib.rs` currently
   registers 20 `env` imports plus 9 defines and traps ~60). They read the
   `.so` bytes and the path out of guest memory — and **K2 just landed the
   widened `proc_read_bytes`/`proc_write_bytes` primitive with a native
   implementation** (value plan §2g), so the copy-in is already available.
   **~150-250 lines.**
3. **Dependency resolution.** `worker-main.ts:1700-1850` opens `DT_NEEDED`
   libraries through ordinary `open`/`read`/`close` syscalls with a candidate
   path list (`/lib`, `/usr/lib`, `/usr/local/lib`). Native reads them through
   the same kernel, so this is the *same Rust code* once it lives in
   `crates/dylink` behind a byte-provider trait. **~0 additional** if the trait
   is designed for it.
4. **Tag identity.** The main module may export `__c_longjmp` /
   `__cpp_exception`, in which case that export is the process authority
   (`worker-main.ts:1889-1902`). Native must adopt the same rule. **~30 lines.**
5. **A native test.** `crates/host-native --test dylink_module`, in the shape of
   K10's `--test wasi_module`. `examples/dlopen/{main.wasm,hello-lib.so}` is the
   right first fixture: it is tiny, it already builds
   (`examples/dlopen/build.sh:44-63`), and it exercises the full path with one
   `.so`. **~150 lines.**

**Total ≈ 650-900 lines of Rust, plus `crates/dylink` itself.** No new host
capability, no ABI motion, no wasmtime upgrade.

**Deliberately out of a first native increment:** fork-after-dlopen (the KFLA
replay) and pthread table replication. Native `fork()` exists (N1-I4/I5) but
combining it with dlopen replay multiplies two hard surfaces. A native
`dlopen` + `dlsym` + `dlclose` that works and a native fork that refuses
truthfully when the archive is non-empty is the honest first boundary.

---

## 9. Implementation plan

Each increment lands behind a dormant flag and cuts over, per the value plan's
§7 rule for K3/K4/K5.

### I0 — Probe, no product code. GATES THE BROWSER PATH ONLY.

Two questions, both cheap, both in the shape of the K0/K10 probe discipline
(Node + Chromium + WebKit):

1. **Does a stateful counting `Proxy` fed from an ordered list reproduce today's
   duplicate-`(module, name)` behavior byte-for-byte?** Build a `.so` with two
   identically-named imports of different types and assert the same provider is
   captured as today. This is the one behavior the fork seam depends on and the
   only genuine correctness risk in the whole item.
2. **Can the process worker instantiate a second no-guest-coupling wasm module
   and drain an act queue from guest memory synchronously inside a
   `__wasm_dlopen_prepare` import frame?** (`libc/glue/dlopen.c`'s contract
   forbids re-entering wasm while that frame is live, so the queue must be
   drained without calling the guest.)

*Not needed:* the K10 region-placement probe. §2.4 settles it from code —
dlopen guests are SDK-built and mmap through the kernel.

### I1 — `crates/dylink`, pure, wired to nothing

`dylink.0` parsing, placement arithmetic, symbol scope/interposition, GOT plan,
dependency graph, element-segment→table-index map, the staged state machine,
handle allocation. Every `match` exhaustive. Unit-tested on the host target.

### I2 — Differential harness. **The deletion gate.**

`cargo xtask dump-dylink-plan` + a Vitest equivalence test, TS vs Rust, over the
six real PHP `.so` files, `hello-lib.so`, `libvfork-side.so`, and the synthetic
`buildDylinkWat` fixtures from `dylink.test.ts:85`. Assert identical `LinkAct`
sequences. This is K10's I2 pattern and it is the same gate.

### I3 — KFLA encoder in `fork-codec`, byte-equivalence proven

Finish `dylink_archive.rs` (add the encoder + the SHA-256 template digest;
`fork-instrument` already depends on `sha2` so a `no_std` sha2 is precedented).
Gate: byte-identical archives against the TS writer across the 12
`dylink-fork-archive.test.ts` scenarios, and cross-decode each with the existing
Rust decoder. **This increment alone retires ~2,150 lines and touches no JS-API
act.**

### I4 — host-native gains `dlopen`. **THE V1 PROOF.**

§8.2. Independent of every browser decision. This is where K5 stops being a
relocation and becomes a capability.

### I5 — the dlopen lock's offsets move to `crates/shared`

Additive snapshot regeneration, no `ABI_VERSION` bump (ABI 44 amendment rule).

### I6 — browser/Node executor + cutover

Requires the D3 decision (§10). Gate: full `host/test` dlopen suite with both
`KANDELO_REQUIRE_*` escapes set, **plus `./run.sh browser` on the WordPress and
LAMP demos**, since both `dlopen` `opcache.so` at PHP startup. Per CLAUDE.md
this cannot be claimed from Node or code reasoning.

### I7 — delete `dylink.ts` / `dylink-fork-archive.ts`

Only after I2 and I3 are green and I6's browser evidence exists.

---

## 10. NEEDS-DEFER-DECISION

**D1 — Re-scope K5: move `patchWasmForThread`, `encodeStartupMetadata` +
`STARTUP_E*`, and `verifyProgramAbi` out of K5 and into K4/K13.**
*What:* three `worker-main.ts` pieces the census assigned to K5 (~900 lines).
*Why:* none of them touches dynamic linking (§3). `patchWasmForThread` is called
from *both* kernel-worker entries, which is K4's exact duplication thesis.
*Cost now:* one paragraph of re-planning; K5 shrinks from ~9,000 to ~8,100 and
K4 grows by the same.
*Cost later:* K5 carries unrelated risk into a browser cutover, and K4 is
under-sized — the two items most likely to collide.
*Recommendation:* **re-scope.** Maintainer's call.

**D2 — Reclassify redis-server from "dlopen consumer" to "link-time symbol
retainer."**
*What:* the campaign's inherited claim that redis does runtime `table.set`.
*Why:* VERIFIED — no Redis module `.so` is built or shipped anywhere
(`packages/registry/redis/package.toml:21-27`,
`images/vfs/products/browser-redis.toml`).
*Cost now:* nil.
*Cost later:* K5's regression surface is over-stated by one binary, and a future
agent may build a fixture module to "test" a path no product reaches.
*Recommendation:* **reclassify**, and record it so it is not re-derived.

**D3 — Where does the Rust core execute in the browser: (α) a new no-guest-
coupling `dylink-module`, or (β) folded into the existing `crates/fork-module`?**
*What:* the one genuinely architectural choice in K5.
*Why it cannot be self-decided:* (β) is cheaper — no new build/staging/Vite-alias/
freshness machinery, which K10 identified as its real cost — and it is
pre-endorsed by `fork-codec/src/dylink_archive.rs:65-72`, which names the
co-resident module as the destination. But it welds the linker to the fork
module, and the maintainer's standing direction is that fork TS shrinks toward a
floor; growing the fork *module* is a different question with a different answer.
(α) keeps the two separable at the cost of a second artifact.
*Cost now:* (α) ≈ 1-2 days of build/staging/alias/freshness plumbing on top of
the port; (β) ≈ 0 plumbing but a larger, more coupled fork module.
*Cost later:* choosing (β) and regretting it means extracting a module later,
which is mechanical but touches the fork artifact's ABI custom sections.
*Recommendation:* **(β)**, on the strength of the existing precedent and the
already-written decoder — but this is the maintainer's call and I am not taking
it.

**D4 — `refreshGlobalGotEntries` writes `0` for an unresolved GOT symbol
(`dylink.ts:1022`). Port it, or make it a truthful failure?**
*What:* an unresolved `GOT.mem`/`GOT.func` symbol silently becomes a NULL the
guest dereferences later.
*Why:* it may be correct lazy-binding semantics (an `RTLD_LAZY` symbol legitimately
unresolved until used) or it may be the exact "silent success" the platform-values
contract forbids. The source comment at `:1605-1614` shows the *seeding* case was
already a real bug ("opcache.so reads `sapi_module.name` as NULL, accel_find_sapi
fails at startup"), which suggests the zero path has bitten before.
*Cost now:* an afternoon to determine which symbols actually hit it under PHP.
*Cost later:* a faithful port carries a possible truthful-failure violation into
Rust and into host-native, where it becomes three implementations of the same
ambiguity.
*Recommendation:* **investigate during I1 and adjudicate explicitly**, in the
shape K10 used for its six defects (implement the correct behavior, pin the old
one in the differential harness as a documented divergence). Not a port-blind.

**D5 — The `functionTableIndex` O(n) scan becomes an O(1) index. Performance
claim or not?**
*What:* §5.3's second bullet. `intl.so` does 1,646 linear scans of a ≥2,357-entry
table today.
*Why:* this is a syscall-adjacent, user-visible startup path (PHP boot in three
browser demos). `docs/agent-guidance/performance.md` requires benchmark evidence
before any "faster" claim, and the change is not optional — a Rust core has no
reason to reproduce the scan.
*Cost now:* one before/after measurement of PHP+opcache boot on Node and browser.
*Cost later:* an unmeasured improvement gets claimed, or an unmeasured regression
in `intl.so`'s 2,469 Global constructions gets missed.
*Recommendation:* **measure it as part of I6's gate**, and make no claim before
then.

---

## 11. STRONG DOUBT

**1. Any plan that adds a host capability.** K5 needs none, and the eight acts
are already performed by the process worker's own JS today — no `env.host_*`, no
`HostIO` method, no `EXPECTED_HOST_IMPORT_COUNT` movement. If a design reaches
for `host_wasm_instantiate` or similar, the design drifted: the acts belong in a
thin executor on the JS side of the same worker, driven by data, not in the
kernel's host contract.

**2. Any ABI bump demand.** The only ABI-adjacent motion is I5 (four offset
pairs into `crates/shared`), which is additive and lands under the ABI-44
amendment rule (`docs/abi-versioning.md:790-794`, per §2e). The guest-facing
`__wasm_dl*` protocol does not change. If a plan demands a bump, ask what
semantic changed.

**3. Any "wasmtime cannot do this" claim.** §8.1 refutes it API by API against
the vendored 48.0.1 source. Four inherited floors have now been disproved in
this campaign (wasmtime-exnref, the E1 GC blockers, the V8 epoll bug, and — in
this document — the four-act linker floor). Re-verify before inheriting a fifth.

**4. The claim that `crates/runtime-core` behind kernel exports is a candidate.**
It is not, for the executor: tables are worker-local and the kernel never sees a
dlopen. It *is* correct for the pure core, and the brief's two candidates
collapse into "pure Rust core + placement question," which is D3.

**5. Do not treat the two pthread-hosted `__wpk_fork_frame_reserve` failures as
K5 scope.** They are pre-existing, tracked, and located in fork wiring
(§7.1). An agent that "fixes them along the way" has widened K5 into K12 and
made the gate unreadable.

**6. Coverage optimism.** 80 `dylink.test.ts` cases sounds like a lot; 32 of them
do not run without `wasm32posix-cc`, and none exercise a six-module closure,
2,469 GOT cells, or TLS side-module bases. **The differential harness (I2) and
fixture breadth are the gate, not the existing suite.**

---

## 12. Honest sizing

**Bigger than the census said** in two ways:

- The JS-API floor is eight kinds, not four, and one of them (the counting
  import `Proxy`) encodes a fork-seam constraint that is easy to break silently.
- The real acceptance test is the browser: WordPress, LAMP and nginx-php all
  `dlopen` `opcache.so` at PHP startup, so K5 cannot be declared complete from
  Node.

**Smaller than the census said** in four ways:

- **~1,318 lines are already written** (`fork-codec/src/dylink_archive.rs`),
  reviewed, and wired to nothing — the K1 pattern.
- **~900 lines assigned to K5 are not K5** (D1).
- **The V1 prize is separable.** Native `dlopen` (I1+I4) needs no wasm module, no
  browser decision, and no fork interaction — ~650-900 lines of host-native Rust
  over the pure core.
- **Zero host capability, zero ABI motion.** The dlopen contract is a guest
  personality, not a host contract, exactly as WASI turned out to be.

**Net:** K5's real cost is `crates/dylink` (the ~3,500 lines of genuine `ld.so`
logic) plus a differential harness plus a browser cutover. Its real payoff is
that `host-native` gains `dlopen`, that a 2,150-line binary codec stops being
hand-written twice, and that eight JS-API acts become one typed executor
interface a new host implements once.
