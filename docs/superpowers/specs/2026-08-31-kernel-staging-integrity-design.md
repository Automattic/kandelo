# Kernel staging integrity: make a stale kernel fail loud

Date: 2026-08-31
Status: Design, awaiting review
Contracts touched: Package/Build (cache), ABI, Host runtime
(resolver), Validation

## Why

The local kernel build/staging pipeline has silently served a **stale
`kernel.wasm`** at least three times. A stale kernel is the worst
possible failure mode here: the freshly-changed kernel code never runs,
the overlay/provider is silently a no-op, lazy read/exec "succeed"
through a fallback path, and the test suite goes **green against
yesterday's binary**. One agent burned real time misdiagnosing a
"flag-independent" bug that was purely the stale artifact; the ABI-43
vs ABI-44 vim incident (commit `5f593f7db`) was the same class one
layer over.

This matters because Kandelo's north star is *truthful failure over
convenient illusion*. A stale kernel is the exact opposite: it
manufactures the appearance of correctness on top of a wrong platform
binary. Anyone validating a kernel change — an agent, a human before
merge, CI's local build — can be handed a false green with no signal.

The three concrete failures, all confirmed by tracing the pipeline:

1. **The trusted cache can serve same-key/different-bytes.**
   `./run.sh setup` / `test` / `bootstrap kernel` run the local-build
   engine with `verify_cache = false` (the deliberate 929s→7.5s no-op
   speed win). A cache *hit* is then trusted **without re-hashing the
   artifact bytes** (`build_deps.rs` `source_only_cache_entry_is_trusted`
   ~line 8798, trusted branch ~8683-8723; safety comment ~8794-8796).
   The entire guarantee rests on *"the cache key binds every input that
   affects the output."* But the input set is a **hand-maintained list**
   in `packages/registry/kernel/build.toml` plus a global toolchain
   list — and `.cargo/config.toml`, which sets the kernel's real
   codegen/link flags (`panic=immediate-abort`, `--import-memory`,
   `--shared-memory`, `--max-memory`, target-features), is in **neither**.
   Edit it (or add any compile-closure path the list doesn't enumerate)
   and you get a different binary at the *same* cache key; the trusted
   path serves the stale entry with no byte check. This is a recurring
   class: PR #1328 was the same bug with `crates/runtime-core` omitted.

2. **The freshness guard is ABI-number-only.** `xtask verify-fresh`
   (`local_build.rs` `verify_fresh_report` ~784-815), run before the
   suites, only compares the staged kernel's `__abi_version` export to
   `wasm_posix_shared::ABI_VERSION`. A kernel change that does **not**
   bump the ABI — explicitly allowed for "pure internal refactors"
   (`docs/abi-versioning.md:132`) — passes clean even when the staged
   bytes are stale. There is **no source→artifact content check
   anywhere.**

3. **Legacy read-paths still bypass the authoritative artifact.**
   Multiple consumers read non-authoritative locations instead of the
   one authoritative staged kernel
   (`local-binaries/source-only-v1/kernel.wasm`):
   - `host/wasm/kandelo-kernel.wasm` — written by `run.sh` clean path
     (`run.sh:1985-1989`) and shipped by the npm package
     (`host/package.json:101-102`).
   - The filename alias in `host/src/binary-resolver.ts:233-234`: a
     request for `kernel.wasm` also matches legacy `kandelo-kernel.wasm`
     in the ambient tiers.
   - `host/test/teardown-reclaim.test.ts:27-30` hard-codes
     `../../local-binaries/kernel.wasm`, bypassing the resolver, the ABI
     check, and freshness policy entirely.
   - `apps/browser-demos/vite.config.ts:319-321,353-357` documents and
     falls back to `local-binaries/kernel.wasm` / `binaries/kernel.wasm`.

## Goals

- A stale kernel `.wasm` must **fail loud**, not false-green — for both
  ABI-changing and same-ABI (internal) kernel changes.
- No compile-closure input can be **silently omitted** from the cache
  key again (close the `.cargo/config.toml` / `runtime-core` class
  structurally).
- Exactly **one** authoritative artifact location; a missing
  authoritative artifact is a loud error, never a fall-through to a
  legacy/stale tier.
- **Preserve the invalidation boundary the user requires:** guest
  programs (vim, ruby, python, …) rebuild **only** when the ABI
  structure/version changes, never when a kernel internal changes.
- **Preserve the no-op speed win** (929s→7.5s). The fix must not
  reintroduce a `cargo` *compile* on the no-op path.

## Non-goals

- Strengthening the separate, pre-existing risk that a kernel change
  could alter real ABI behavior without someone regenerating
  `abi/snapshot.json` (CLAUDE.md's "the snapshot check is necessary but
  not sufficient"). We preserve the current boundary; we do not weaken
  or repair it here.
- Changing how guest/upstream (SDK+libc) packages compute their own
  source closure. A-general applies to Rust **workspace-crate**
  repository packages only.
- Cross-machine cache sharing semantics.

## The invalidation model this design preserves

The cache graph has two distinct edge types, and they stay distinct.

| Edge | Whose cache key it is in | Folds in | Moves when |
|---|---|---|---|
| **Source-closure** | the package's own compiled bytes | that package's own compile-closure hash | that package's own source changes |
| **ABI-contract** | a *guest's* key (its dependency on the kernel) | `local_abi_contract_digest` = `hash(abi/snapshot.json + ABI_VERSION)` | ABI structure/version changes |

`local_abi_contract_digest` (`tools/xtask/src/local_abi_identity.rs:5-45`)
hashes the canonicalized **`abi/snapshot.json`** plus `ABI_VERSION` — it
hashes **no kernel `.rs` source**. Therefore a guest program's key moves
only when the committed ABI snapshot/version changes. This design
touches **only the source-closure edge, and only for workspace-crate
packages**; it never adds kernel source to a guest's inputs. Net
result, unchanged from today but now *enforced* rather than *hoped*:

- Guest rebuilds ⟺ `abi/snapshot.json` / `ABI_VERSION` changes.
- Kernel rebuilds ⟺ its own cargo source closure changes.
- Kernel internal change, same ABI → kernel rebuilds, **guests do not.**

## Design

Three parts. Part B is the immediate loud safety net (ABI-independent,
catches drift now). Part A makes the cache key's input set structurally
sound so B's "expected key" can be trusted. Part D removes the legacy
paths so there is one authoritative artifact.

### Part B — Loud, ABI-independent staleness backstop (build-key stamp)

**Stamp** every built kernel `.wasm` with the full cache key it was
built under, embedded as a Wasm custom section (e.g.
`kandelo-build-key`, a 32-byte digest). This is written once, only on a
real rebuild, by the local-build engine at mirror time (near
`local_build.rs:935` / `6130-6131`, where `kandelo-kernel.wasm` →
`kernel.wasm`).

**Verify** in `verify_fresh_report` (`local_build.rs:784-815`): recompute
the *expected* cache key from current source (the engine already
computes this key to decide hit/miss — reuse it, do not recompute
independently) and compare it to the stamp read from the staged
`kernel.wasm`. On mismatch, hard-fail with a rebuild instruction,
exactly like the existing ABI-stale message:

```
local-binaries/source-only-v1/kernel.wasm is stale: it was built for
key <stamp>, but the current source tree resolves to key <expected>.
Rebuild with `./run.sh setup` (or `cargo xtask bootstrap`).
```

This is ABI-independent: a same-ABI internal change moves the cache key,
so the stamp no longer matches → loud failure. It is cheap: the
component costs measured on this worktree are `cargo metadata` 0.07s
warm / 0.36s cold and a 3.9 MB source-closure sha256 in 0.03s — the
verify step adds ~tens of ms to the 7.5s no-op path. No `cargo`
*compile* is introduced.

**Belt-and-suspenders:** also make the trusted cache-hit path verify the
stamped key matches the cache directory's own key (a cheap section read,
no full re-hash). This catches a corrupted or misfiled cache entry —
the exact 933-vs-980 KB "wrong bytes at the right key name" symptom.

B alone can still be fooled by an input the key *fails to include*
(because the "expected" key is computed from the same incomplete input
set). That is what A fixes.

### Part A — Structural: derive the workspace-crate compile closure

Replace the hand-maintained `inputs` list for **Rust workspace-crate
repository packages** (the kernel today) with a closure derived from
Cargo, so no compile-closure path can be silently omitted.

- **Source of truth:** `cargo metadata` gives the crate-**path** closure
  (which workspace crates are in the compile). Measured cheap: 0.07s
  warm / 0.36s cold. (The nightly `--unit-graph` is more precise but
  needs the nightly channel; `cargo metadata` is sufficient for the
  path closure and runs on stable.)
- **Non-graph build inputs** that Cargo's graph does *not* express as
  nodes — `.cargo/config.toml` and `rust-toolchain.toml` — are added
  explicitly to the derived closure / `GLOBAL_PACKAGE_TOOLCHAIN_INPUTS`
  (`build_deps.rs:6894-6917`). `.cargo/config.toml` is the concrete
  omission behind today's bug; `rust-toolchain.toml` pins the compiler.
- **Caching the derivation** to protect the no-op path: re-run
  `cargo metadata` only when a graph-affecting file changed
  (`**/Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`); otherwise reuse
  the cached closure. On a true no-op this adds ~0, not even the 0.07s.
- **Loud drift check (the general fire-break):** at build time, for a
  workspace-crate package, assert that the package's declared
  `build.toml` `inputs` (if any remain hand-listed for staged rollout)
  **cover** every path the derived closure requires. A `build.toml` that
  under-declares fails loud with a "config drift: input list is missing
  `<path>`" error instead of silently producing a stale-prone key. This
  is per-package and self-referential — it compares a package's inputs
  against *its own* cargo graph and says nothing about guests, so it
  cannot trigger a guest rebuild.

**Staging.** Land the kernel first (the reported fire): kernel switches
to derived closure + the two explicit toolchain inputs, gains the stamp
+ verify. Then, in the same spec's second stage, extend the derivation
and drift-check to the other Rust workspace-crate repository packages
(inventory them during implementation; the special-cased `kernel` /
`userspace` names in `binary-resolver.ts:1729` are a starting hint).

### Part D — One authoritative artifact; remove legacy read-paths

Collapse every consumer onto the single authoritative artifact and make
a missing authoritative artifact a loud error rather than a fall-through:

- Remove the `kernel.wasm → kandelo-kernel.wasm` filename alias in
  `host/src/binary-resolver.ts:233-234` so a stale legacy-named file can
  never satisfy a `kernel.wasm` request through the ambient tiers.
- Redirect/remove the `host/wasm/kandelo-kernel.wasm` staging in
  `run.sh:1985-1989` and the npm export in `host/package.json:101-102`
  so the shipped/kernel artifact flows from the authoritative source,
  not a separately-copied legacy tree. (Determine during implementation
  whether the npm package should ship the authoritative name directly or
  the export should be dropped.)
- Fix `host/test/teardown-reclaim.test.ts:27-30` to resolve through the
  resolver / source-only tier instead of hard-coding
  `../../local-binaries/kernel.wasm`.
- Remove the `local-binaries/kernel.wasm` / `binaries/kernel.wasm`
  legacy fallbacks and error strings in
  `apps/browser-demos/vite.config.ts:319-321,353-357`; the browser path
  resolves through the source-only projection or the resolver, and a
  miss is a loud error.
- Fix the doc drift at `tools/xtask/src/main.rs:34-35` (names
  `kandelo-kernel.wasm` where the code reads `kernel.wasm`).
- Sweep for any remaining reference to a legacy kernel path and remove
  it. A build-time or startup warning is a fallback only where a
  reference genuinely cannot be removed yet; the default is removal.

## Data flow (after)

```
crates/kernel + runtime-core + shared + .cargo/config.toml
        │  (cargo metadata → derived closure; A)
        ▼
cache key = f(derived closure, ABI_VERSION, abi-contract, deps)
        │  build → stamp key into kernel.wasm custom section (B)
        ▼
local-binaries/source-only-v1/kernel.wasm   ← the ONE authoritative copy
        │  verify_fresh: expected key == stamped key? (B) else LOUD FAIL
        ▼
resolver / vite / node host  ← no legacy alias, no legacy tier (D)
```

## Error handling

- Stamp mismatch in `verify-fresh` → loud stale-artifact error with a
  rebuild command; non-zero exit before any suite runs.
- Trusted cache-hit stamp ≠ directory key → loud corrupt-cache error;
  treat as a miss and rebuild.
- `build.toml` under-declares vs. derived closure → loud config-drift
  build error naming the missing path.
- Missing authoritative artifact at a consumer → loud "not found" error
  (existing behavior), never a legacy fall-through.

## Testing

- **Unit (xtask):** stamp round-trips the key; `verify_fresh_report`
  fails on a stamp/expected mismatch and passes on a match; derived
  closure includes `.cargo/config.toml` + `rust-toolchain.toml`; drift
  check fails a deliberately under-declared `build.toml`.
- **Regression (the reported bug):** editing `.cargo/config.toml`
  changes the kernel cache key (proves the omission is closed); a
  same-ABI edit to a `crates/kernel` `.rs` file changes the key while
  `abi/snapshot.json` is untouched, and a guest program's key is
  **unchanged** (proves the invalidation boundary is preserved).
- **Resolver/host (Node + browser):** with the legacy alias removed, a
  `kernel.wasm` request resolves only the authoritative artifact; a
  stale legacy-named file does not satisfy it; `teardown-reclaim` and
  the browser demos resolve through the authoritative path.
- **End-to-end speed:** build the kernel, then time `./run.sh test`
  before/after to confirm the no-op path stays within the measured
  ~sub-second overhead (Validation contract: measure the claim, don't
  assert it). Per the Validation/ABI contracts, kernel-touching changes
  also run the relevant conformance consideration, not just unit tests.

## Rollout / risk

- Part B is additive and independently valuable — it lands first and
  immediately converts silent staleness to loud failure even before A.
- Part A kernel-first, then generalized; the drift check makes any
  not-yet-migrated hand-listed package fail loud rather than silently
  stale, so the staged rollout is safe at each step.
- Part D is mechanical but cross-host (Node + browser + npm); it needs
  both-host verification per the Host Runtime contract.
- No `ABI_VERSION` bump: the stamp is a new custom section in a
  locally-built artifact, not an ABI-observable change to programs or
  the host/kernel contract. Confirm during implementation that the stamp
  section is ignored by every existing artifact-policy reader and does
  not collide with `wasm-posix-abi` / `__abi_version`.
