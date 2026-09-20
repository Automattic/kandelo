# Guidance extracted from CLAUDE.md for review

**Status: staged for maintainer review, 2026-09-20. Not authoritative.**

These passages were moved out of `CLAUDE.md` because they assert specific,
checkable facts about the code rather than contracts, values, or process.
Implementation truth in agent guidance goes stale silently: nothing fails when
a symbol is renamed, an enumeration grows, or a script's behaviour changes, so
the guidance keeps asserting yesterday's code with full confidence.

Two failures observed on branch `brandonpayton/lane-f-fork-inversion` in one
session motivated the extraction:

* The host-floor enumeration below names the resume `WebAssembly.Table` as
  irreducible. A design under active consideration (spec decision 12,
  `docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md`) proposes
  moving the code that writes that table into the fork-module. The guidance
  would have been read as forbidding the very change being designed.
* A spec census of "nine hand-maintained copies" of the SDK link contract was
  found by `git grep` to be eleven. An enumeration written once and never
  re-derived undercounted by two.

**The healthy pattern already exists in this repository.**
`fork_module_host_obligation_is_pinned` (`crates/host-native/src/lib.rs:1379`)
pins TWO exact lists, not one: the host FUNCTIONS at `:1489-1512` and the host
TABLES at `:1513-1521`. This file previously cited only the second while
describing the first. It pins the host obligation list in a Rust test
— it cannot go stale silently, because drift turns it red. `docs/surface-budget.json`
ceilings do the same for surface size. The question for each passage below is
therefore not "is this true?" but "what would fail if it stopped being true?"

Nothing here has been deleted. Each item records where it came from, so it can
be restored, rewritten as a contract, or converted into an assertion.

---

## A. The ABI enumeration

Removed from the ABI Contract section, immediately after the `ABI_VERSION`
bump requirement (which stayed in `CLAUDE.md` — it is a contract).

> The ABI includes syscall numbers and marshalling, channel layout, process
> memory layout, host-reserved control regions, `repr(C)` structs, kernel Wasm
> exports, ABI custom sections, process-expected globals, `wpk_fork_*` exports,
> generated TypeScript ABI constants, and VFS image metadata that binds Wasm
> programs to a kernel ABI.

Why it was moved: this is a list of what the ABI currently contains. It grows
whenever the ABI grows, and nothing reminds anyone to update it. An agent
reading it may conclude something absent from the list is outside the ABI.

Candidate resolution: derive it from `abi/snapshot.json`'s own structure, or
assert the list in the snapshot-drift test rather than in prose.

---

## B. The irreducible host floor

Removed from the Rust-First Kernel And Fork Contract. The surrounding rule —
Rust-first, discuss before growing the host surface, the direction of travel is
one way — stayed in `CLAUDE.md`.

> ... unless it is the irreducible host floor: worker spawn, the `fork()`
> syscall + syscall-channel transport, `resolve_externref` identity
> materialization, anyref-transit `Table.grow` sizing, PIC placement globals,
> the resume `WebAssembly.Table`, and the Node/browser platform bridges.

Why it was moved: this is the passage that prompted the extraction. A floor is
exactly the kind of claim that should shrink over time, and this campaign's own
guidance says it does ("TS fork/kernel glue shrinks toward the floor over time;
it does not grow"). Writing the members down in prose makes each one read as
settled, when several are settled only until someone probes them. A 2026-09-03
probe already found externref/exnref/anyref-transit/GC-`ref.eq` migratable to
Wasm, leaving a much smaller floor than this list implies.

Candidate resolution: pin the floor as an exact-list assert the way
`fork_module_host_obligation_is_pinned` pins host obligations, so removing an
item is a deliberate, reviewed edit that turns a test red rather than a prose
diff nobody validates.

**Follow-up, 2026-09-20.** Moving this list out of `CLAUDE.md` did not achieve
its purpose on its own, because the same list was still asserted as settled in
both guides `CLAUDE.md` routes to. Two things were then found by reading the
code rather than the prose:

* The quoted list above has SEVEN members; both guides carried EIGHT. It omits
  "the guest run-loop + the fork-unwind exception catch". A list small enough
  to quote in three places was already inconsistent across all three.
* The resume `WebAssembly.Table` entry — the one that prompted this
  extraction — was not merely contested, it was FALSE. The table is created
  and exported by the fork module
  (`crates/fork-module-inject/src/main.rs:1042-1044`) and imported by the
  guest (`crates/fork-instrument/src/runtime.rs:469-475`); the host reads it
  off the module's exports (`host/src/worker-main.ts:3788`, `:6496`) rather
  than minting it. Only the per-thunk `Table.set` is still host-side.

`docs/agent-guidance/host-runtime.md` is now the single home for the list, with
that entry corrected and the probe framing attached;
`docs/agent-guidance/debugging-and-posix.md` points there instead of keeping a
second copy. That is a mitigation, not the resolution: three prose copies
became one, but one prose copy still rots silently. The exact-list assert above
remains the real fix.

---

## C. The known-bad performance list

Removed from the Performance Contract. The contract itself — performance is
subordinate to correctness, no performance claims without benchmark evidence —
stayed in `CLAUDE.md`.

> Do not repeat known-bad syscall hot-path "optimizations" in
> `host/src/kernel-worker.ts`: syscall argument count tables, syscall
> classification sets, cached channel `DataView`/`Int32Array` objects, or
> conditional debug-ring logging for "trivial" syscalls.

Why it was moved: it names one file and four specific rejected designs. It is
genuinely useful institutional memory, and it is also the most likely passage
here to survive the code it describes — `kernel-worker.ts` is a migration
target, and the list will outlive it.

Candidate resolution: this reads like a docs/agent-guidance/performance.md
entry, which `CLAUDE.md` already points at, rather than a router-level rule.

---

## D. The musl rebuild behaviour

Removed from the Build, Documentation, And PR Contract.

> `./run.sh setup` does not rebuild musl once a sysroot already exists —
> it only re-syncs overlay headers. After editing `libc/musl-overlay/` or
> `libc/glue/channel_syscall.c`, run `scripts/build-musl.sh` before relying on
> `./run.sh setup`, Vitest, or conformance tests.

Why it was moved: it is a true-today statement about what a script does, and it
is a symptom rather than a rule. The same session found the related defect:
`run.sh:410 has_programs()` decides freshness from a roughly twelve-item
file-existence hand-list (`has_resolvable` at `:190` only asks the resolver
whether a path exists), so a link-contract change does not invalidate it and
`./run.sh setup` silently serves stale artifacts. Both are recorded in
`docs/future-improvements.md` under Build freshness.

Candidate resolution: fix the freshness check so the warning is unnecessary. A
build system that needs a prose warning to avoid serving stale output has the
defect in the build system, not in the documentation.

---

## Not extracted, and why

Judgment calls, recorded so the review can disagree with them:

* **The Key Directories and Contract Map tables.** Both are navigation, which
  is this file's stated purpose as a "contract router". Paths move less often
  than symbols, and a wrong path fails obviously on the first `cat`.
* **The `ABI_VERSION` bump requirement**, including its two file paths. The
  requirement is the contract; the paths are how you satisfy it.
* **The CI SHA-pinning rule**, including its example. It is a security control
  with a stated threat model, and `.github/` is already gated in review.
* **`WASM_POSIX_DEP_OUT_DIR` and `scripts/run-wasm-fork-instrument.sh`** in the
  package contract. These are operational requirements a build script must
  satisfy, not descriptions of how the code currently behaves. Borderline —
  they would rot on a rename.
