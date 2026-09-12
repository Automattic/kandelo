# K10 I0 probes — can WASI translation become a co-resident Rust side module?

Throwaway harness for increment **I0** of
`docs/plans/2026-09-09-k10-wasi-shim-grounding.md` (§8). I0 gates every later
increment: it tests the three mechanical assumptions the recommended design
(§3.3 — a PIC wasm side module, `crates/fork-module` pattern) rests on, on
every engine Kandelo supports.

No product code was changed to produce this. Nothing here is wired into the
build; the `.wasm` files are committed so the results are reproducible without
a wabt in `PATH`.

## Running it

```
scripts/dev-shell.sh bash -c 'cd docs/plans/probes/2026-09-09-k10 && node collect.mjs'
```

`collect.mjs` runs `run-node.mjs` (Node, probes 1+2+3) and `run-browsers.mjs`
(Chromium + WebKit under COOP/COEP, since a shared memory needs
`SharedArrayBuffer`) and writes `results.json`. Browsers need `npm install` at
the worktree root for `playwright`. Rebuild the `.wasm` with:

```
wat2wasm --enable-threads p1-shim.wat -o p1-shim.wasm    # and p1-guest, p2-chan
```

Harness shape follows `2026-09-09-k0/` (inline bytes, per-engine JSON) and
`2026-09-09-k0c-epoll/` (COOP/COEP server + dedicated worker for a blocking
agent). `wasm-tools` is not needed here — unlike K0 these probes use atomics
and PIC placement, not Wasm GC, so wabt 1.0.37 assembles them.

## Engines

| engine | version |
|---|---|
| Node | v24.15.0 |
| Chromium | 151.0.7922.34 |
| WebKit | 26.5 |

## Result: probes 1-3 PASS; probe 4 finds a real boundary

All engines agree on every row. Probes 1, 2, and 3 clear the design for the
`wasiModuleImportsMemory` category — the only one Kandelo runs. Probe 4 shows
the `wasiModuleDefinesMemory` category cannot be served by a co-resident side
module at all, and that Kandelo's existing hard refusal of it is correct.

Raw output in `results.json`. Every row below is **VERIFIED** — observed in
that file — unless marked otherwise.

### Probe 1 — a side module's exports as the guest's imports

`p1-shim.wat` stands in for `crates/wasi-module`: it imports the guest's shared
memory plus the PIC placement globals (`__memory_base`, `__stack_pointer`) and
exports real `wasi_snapshot_preview1` signatures. `p1-guest.wat` stands in for
a WASI guest: it imports `wasi_snapshot_preview1.{fd_write,fd_seek}` and its
memory, exactly as `wasiModuleDefinesMemory` already requires
(`host/src/worker-main.ts:3291`). The host hands `shim.exports.fd_write`
straight through as the guest's import — no JS wrapper.

| observation | node | chromium | webkit |
|---|---|---|---|
| `exports_are_functions` | true | true | true |
| `guest_instantiated` | true | true | true |
| `_start()` (shim wrote 11 into the guest's buffer) | 11 | 11 | 11 |
| shim wrote its own `__memory_base`-relative region (`0x5157`) | 20823 | 20823 | 20823 |
| `fd_seek` i64 `0x0123456789ABCDEF` → `+1`, exact | true | true | true |
| `fd_seek` i64 `-1` → `0`, sign-extension exact | true | true | true |

**PASSES.** A side module's exported function is directly usable as another
instance's import, and a full-width i64 survives the crossing. That last row
matters: `0x0123456789ABCDEF` is not exactly representable as a JS number, and
the TypeScript shim carries `checkedSignedI64Scalar` / `splitSignedI64Words`
(~35 lines, `wasi-shim.ts:113,126`) *only* because a JS import frame cannot
hold an i64. Those helpers have no reason to exist in the Rust design.

`WebAssembly.Function` is undefined on all three engines, so the probe could
not assert the export's *type*; it asserted its behavior instead. **Not
claimed:** that the engine emits no JS trampoline. The probe shows the
mechanism works and is numerically exact; it does not measure call cost, and
per the grounding (§2.4) **no performance claim is made.**

### Probe 2 — `memory.atomic.wait32` vs `Atomics.notify` on one word

`p2-chan.wat` reimplements `WasiShim.doSyscall`'s wait
(`host/src/wasi-shim.ts:527-531`) in wasm, preserving the re-wait loop:
`while (Atomics.wait(...) === "ok")` becomes `while (result == 0)`, so a
spurious wake that leaves the word at `CH_PENDING` goes back to sleep. The
waiter always runs in a dedicated worker — a browser main thread may not block,
and the real shim runs in the process worker anyway. The driver thread plays
the kernel worker.

| observation | node | chromium | webkit |
|---|---|---|---|
| A: JS `Atomics.notify` woke the wasm waiter (`notify` return) | 1 | 1 | 1 |
| A: wasm waiter blocked ~200 ms then returned | 204 ms | 201 ms | 201 ms |
| A: re-sleeps before the word moved | 1 | 1 | 1 |
| A: final wait result (1 = NOT_EQUAL, word had moved) | 1 | 1 | 1 |
| A: status word reset to `CH_IDLE` by the module | 0 | 0 | 0 |
| B (control): waiting on a value the word lacks returns NOT_EQUAL at once | 1 @ 0 ms | 1 @ 0 ms | 1 @ 0 ms |
| C: wasm `memory.atomic.notify` woke a JS `Atomics.wait` waiter | 1 | 1 | 1 |
| C: JS waiter result / value seen | `ok` / 5 | `ok` / 5 | `ok` / 5 |

**PASSES, in both directions.** The A-row shape is exactly the TypeScript's:
block → woken by the kernel's `Atomics.notify` → re-wait → see the word moved →
return NOT_EQUAL → reset to idle. Probe B rules out a wait that blocks
unconditionally. This closes STRONG DOUBT 3(b) of the grounding: the module's
channel wait can behave like the TS `Atomics.wait` spin, on all three engines.

### Probe 3 — region placement for a guest that grows its own memory

The grounding (STRONG DOUBT 4) said to treat this as **likely false** until
proven, because `fork-module` places itself with a kernel `SYS_MMAP` →
`find_gap`, which is sound only because SDK guests route *all* address-space
growth through the kernel, and **a WASI guest does not.**

**That suspicion was correct about the recipe and wrong about the consequence.**
The `fork-module` placement recipe must *not* be inherited — but the reason is
that it is unnecessary here, not that placement is hard. Two independent
code-level facts:

- **VERIFIED:** `grep -n 'SYS_MMAP\|SYS_BRK\|SYS_MUNMAP\|SYS_MREMAP'
  host/src/wasi-shim.ts` → **no matches.** A WASI process never asks the
  kernel for address space at all, so the kernel is never told about the
  guest's real memory extent. A `find_gap` placement for a WASI guest would be
  an allocator reasoning from information it does not have.
- **VERIFIED:** the host is already the placement authority for a WASI
  process. `memory` and `channelOffset` arrive in `initData`
  (`worker-main.ts:3273`) from `computeProcessMemoryLayout`
  (`host/src/process-memory.ts:230-300`), which sets
  `controlBase = pageAlignUp(max(heapBase, minPages * 64K))` — where
  `minPages` already includes the guest's own
  `importedMemoryMinimumPages(programBytes)` — and then lays the syscall
  channel and thread arena **above** it. A host-owned band above the guest's
  declared minimum is not a new idea to invent; it is where the syscall
  channel already lives.

So probe 3 tested host-side placement, in both available forms.

| observation | node | chromium | webkit |
|---|---|---|---|
| **3a** grow-once-before-guest: `grow()` returned the old page count | true | true | true |
| 3a base / bytes after grow | 524288 / 1048576 | same | same |
| 3a region fits inside committed memory | true | true | true |
| 3a module wrote both ends of its region (`0x454E44`) | 4542020 | 4542020 | 4542020 |
| 3a module saw the host's `__memory_base` | true | true | true |
| **3b** guest's own `memory.grow(4)` returned previous size | 16 | 16 | 16 |
| 3b **guest heap base lands above the host region** | true | true | true |
| 3b host region intact after the guest grew | true | true | true |
| 3b region end still `0x454E44` after the guest grew | true | true | true |
| **3c** growing a *shared* memory did not detach cached host views | true | true | true |
| 3c old view still readable but its length is now stale | true | true | true |
| **3d** placement in the host-owned band, no growth at all (base 262144, 256 KiB) | 4542020 | 4542020 | 4542020 |

**PASSES.** The decisive row is **3b**: `memory.grow` returns the *previous*
page count, which is precisely what wasi-libc's `sbrk` uses as its new break,
so a self-growing WASI guest always lands **above** anything the host has
already placed. Host-side placement is therefore sound without the kernel
knowing anything, and **no kernel `SYS_MMAP` and no new channel traffic is
needed.** 3d shows the simpler variant also works: place the module in the
committed host-owned band above the guest's minimum, growing nothing.

**Design consequence:** `crates/wasi-module` should be placed by the host, in
the process-memory layout, alongside the channel and thread arena — *not* by
`continuationMmap`. This makes the design strictly smaller than the
`fork-module` precedent, and it needs no ABI motion (grounding §7, STRONG
DOUBT 2).

**3c is a gotcha to carry into the implementation:** after a growth, a cached
`Int32Array(memory.buffer)` keeps working but reports a stale length. Anything
host-side that caches a view over process memory must re-derive it after a
guest growth, or bound itself to the region it owns.

### Probe 4 — the guest that DEFINES its own memory

`host/src/wasi-detect.ts` distinguishes two categories:
`wasiModuleImportsMemory` (`:34`) and `wasiModuleDefinesMemory` (`:44`).
Probes 1-3 all test the first. The second is what a **default wasi-sdk link
emits** — the module owns its linear memory outright and Kandelo never supplies
it — and it is the category most likely to break the side-module recipe, so it
gets its own probe. Two obstacles are separable, and the probe separates them.

| observation | node | chromium | webkit |
|---|---|---|---|
| fixture exports its own memory / imports none | true / false | true / false | true / false |
| **4a** side module cannot instantiate without a memory | throws | throws | throws |
| 4a guest cannot instantiate without the side module | throws | throws | throws |
| **4b** self-defined memory's buffer is shared | **false** (`ArrayBuffer`) | false | false |
| 4b linking the side module to it | **fails: shared-state mismatch** | same | same |
| **4c** `memory.atomic.wait32` on a non-shared memory | throws "Atomics.wait cannot be called in this context" | same | traps "Out of bounds memory access" |
| 4c `Atomics.notify` on a non-shared buffer | **0 — silent no-op** | 0 | 0 |
| **4d** self-defined but `shared`, via a JS trampoline | 11 (works) | 11 | 11 |

**The recipe does NOT hold for this category — and the probe shows Kandelo's
existing refusal is correct rather than merely cautious.**

- **4a — the wiring is a cycle.** The side module needs the guest's memory at
  *its* instantiation; the guest needs the side module's exports at *its*
  instantiation. Neither order works. Direct wasm→wasm wiring is only possible
  when the *host* owns the memory, i.e. category one.
- **4b — the blocking obstacle is shared-ness, not the cycle.** A default
  wasi-sdk memory is **not shared**, so the side module (which must declare
  `shared` to use `memory.atomic.wait32`) cannot even be linked against it.
  Instantiation fails on all three engines with a shared-state mismatch.
- **4c — and the syscall channel is impossible there anyway**, in either
  language. The wait half fails loudly; note that the **notify half fails
  silently** (returns 0), which is the more dangerous of the two and worth an
  assertion if this category is ever revisited.
- **4d — the one serviceable sub-case is not worth having.** A guest that
  defines its memory but declares it `shared` can be served, but only by
  breaking the cycle with a JS trampoline that forwards every WASI call. That
  reinstates exactly the per-call JS frame the migration exists to remove, so
  it buys nothing. No such artifact exists in the repo.

**Design consequence:** `worker-main.ts:3292` already throws for
`wasiModuleDefinesMemory`, and that refusal must be **preserved as a loud
failure**, not softened. Probe 4 upgrades it from a limitation to a documented
platform boundary with a proven cause: without a host-supplied shared memory
there is no syscall channel, so there is no way to run the guest at all. The
migration neither widens nor narrows the set of WASI modules Kandelo accepts.

## Residual risk, stated rather than hidden

**INFERRED, not probed:** 3b covers a guest whose heap comes from
`memory.grow`. It says nothing about a guest whose allocator starts at a
link-time `__heap_base` constant *below* the current memory top. That hazard is
not new — it would already corrupt the syscall channel today — and
`computeProcessMemoryLayout` is what answers it, by deriving `controlBase` from
the program's own `heapBase`. The wasi-module region must be placed by that
same computation for the same reason, and the implementation should assert it.

**A real gap for I2, the deletion gate.** The grounding calls the fixture work
"the gate, not polish" (STRONG DOUBT 5), and the fixtures need a real
wasi-libc guest to exercise `path_open`, `fd_readdir` across batches, and the
`__heap_base` case above. **VERIFIED: the declared toolchain cannot build
one.**

- `clang --target=wasm32-wasi` fails in the dev shell (no wasi sysroot; the
  nix cc-wrapper also rejects the cross target), and `grep -in wasi flake.nix`
  → no matches, so no wasi-libc is declared.
- The pinned Rust toolchain has std for `aarch64-apple-darwin` and
  `wasm32-unknown-unknown` only — no `wasm32-wasip1`.

`crates/wasi-module` itself is unaffected: it builds on
`wasm32-unknown-unknown` with `-Z build-std=core,alloc`, exactly as
`crates/fork-module/build-wasm.sh:119` does. It is only the *guest-side
fixtures* that are blocked. See the NEEDS-DEFER-DECISION recorded with this
probe in the campaign report.

## Files

| file | role |
|---|---|
| `p1-shim.wat` / `.wasm` | stand-in for `crates/wasi-module`: PIC-shaped, imports memory + placement globals, exports WASI signatures incl. i64 |
| `p1-guest.wat` / `.wasm` | stand-in for a WASI guest: imports `wasi_snapshot_preview1` + memory, grows its own memory |
| `p2-chan.wat` / `.wasm` | the channel wait in wasm, mirroring `wasi-shim.ts:527-531` |
| `p4-guest-owns.wat` / `.wasm` | guest defining + exporting its own NON-shared memory (default wasi-sdk shape) |
| `p4-guest-owns-shared.wat` / `.wasm` | the same but declaring the memory `shared`, isolating the cycle from shared-ness |
| `p4-chan-unshared.wat` / `.wasm` | the channel wait over a non-shared memory |
| `probe-core.js` | probes 1 and 3 (non-blocking, runs on any thread) |
| `probe4-core.js` | probe 4 (the defines-its-own-memory category) |
| `chan-core.js` | probe 2 waiter + driver |
| `chan-waiter-node.mjs`, `chan-waiter.js` | worker entry points (Node / browser) |
| `run-node.mjs`, `run-browsers.mjs`, `index.html` | per-engine drivers |
| `collect.mjs` | runs everything, writes `results.json` |
| `results.json` | raw results for all three engines |
