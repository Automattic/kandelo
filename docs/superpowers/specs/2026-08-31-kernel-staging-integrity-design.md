# Build-staleness integrity: make every stale artifact fail loud

Date: 2026-08-31
Status: Design, awaiting review
Contracts touched: Package/Build (cache), ABI, Host runtime
(resolver, exec-time program checks), Validation

## Why

The local build/staging pipeline has silently served a **stale
`kernel.wasm`** at least three times. A stale kernel is the worst
failure mode here: the freshly-changed kernel code never runs, the
overlay/provider is silently a no-op, lazy read/exec "succeed" through a
fallback path, and the test suite goes **green against yesterday's
binary**. One agent burned real time misdiagnosing a "flag-independent"
bug that was purely the stale artifact; the ABI-43-vs-ABI-44 vim
incident (commit `5f593f7db`) was the same class one layer over.

This matters because Kandelo's north star is *truthful failure over
convenient illusion*. A stale artifact manufactures the appearance of
correctness on top of the wrong binary. Anyone validating a change — an
agent, a human before merge, CI's local build — can be handed a false
green with no signal.

**The purpose of this work: eliminate build-staleness as a class,
everywhere it is mechanically possible, and make the one irreducible
residual (see Non-goals) a documented, procedurally-fenced boundary
rather than a silent trap.**

The concrete failures, all confirmed by tracing the pipeline:

1. **The trusted cache can serve same-key/different-bytes.**
   `./run.sh setup` / `test` / `bootstrap` run the local-build engine
   with `verify_cache = false` (the deliberate 929s→7.5s no-op speed
   win). A cache *hit* is trusted **without re-hashing the bytes**
   (`build_deps.rs` `source_only_cache_entry_is_trusted` ~8798, trusted
   branch ~8683-8723, safety comment ~8794-8796). The whole guarantee
   rests on *"the cache key binds every input that affects the output."*
   But the input set is a **hand-maintained list** in `build.toml` plus
   a global toolchain list — and `.cargo/config.toml`, which sets the
   kernel's real codegen/link flags (`panic=immediate-abort`,
   `--import-memory`, `--shared-memory`, `--max-memory`,
   target-features), is in **neither**. Edit it (or add any
   compile-closure path the list doesn't enumerate) → different binary,
   *same* cache key → the trusted path serves the stale entry. Recurring
   class: PR #1328 was the same bug with `crates/runtime-core` omitted.

2. **The freshness guard is ABI-number-only.** `xtask verify-fresh`
   (`local_build.rs` `verify_fresh_report` ~784-815) only compares the
   staged kernel's `__abi_version` export to `ABI_VERSION`. A kernel
   change that does **not** bump the ABI — allowed for "pure internal
   refactors" (`docs/abi-versioning.md:132`) — passes clean even when
   the bytes are stale. There is **no source→artifact content check.**

3. **`userspace.wasm` and other mirrored artifacts have zero
   protection.** `verify-fresh` inspects only `kernel.wasm`;
   `userspace.wasm` exports no ABI, so nothing watches it for staleness.

4. **The fork-instrument tool has its own hand-maintained input hash.**
   `scripts/fork-instrument-tool-input-hash.sh` guards the native
   `wasm-fork-instrument` tool against source drift — but as a
   hand-listed input set, it is exposed to the same omission class as
   defect 1.

5. **Guest→kernel ABI is enforced only by number at exec.** Guests key
   off the abi-contract digest (`hash(abi/snapshot.json + ABI_VERSION)`)
   so they *rebuild* on structural ABI changes, but `verifyProgramAbi` /
   `describeWasmArtifactPolicyFailures` only check the ABI *number* at
   exec. A leftover guest whose number coincidentally matches a
   changed-snapshot kernel runs anyway.

6. **Legacy read-paths bypass the authoritative artifact.** Consumers
   read non-authoritative locations instead of the one authoritative
   staged kernel (`local-binaries/source-only-v1/kernel.wasm`):
   `host/wasm/kandelo-kernel.wasm` (`run.sh:1985-1989`,
   `host/package.json:101-102`); the filename alias in
   `host/src/binary-resolver.ts:233-234` (a `kernel.wasm` request also
   matches legacy `kandelo-kernel.wasm`); the hard-coded path in
   `host/test/teardown-reclaim.test.ts:27-30`; and the
   `local-binaries/kernel.wasm` / `binaries/kernel.wasm` fallbacks in
   `apps/browser-demos/vite.config.ts:319-321,353-357`.

## Goals

- A stale build artifact must **fail loud**, not false-green — for
  ABI-changing and same-ABI (internal) changes alike.
- No compile-closure input can be **silently omitted** from a cache key
  or a tool-input hash again (close the `.cargo/config.toml` /
  `runtime-core` class structurally).
- Exactly **one** authoritative artifact location per output; a missing
  authoritative artifact is a loud error, never a fall-through to a
  legacy/stale tier.
- **A guest can never silently run against a mismatched ABI contract.**
  Any structural ABI change that leaves a guest un-rebuilt is rejected
  loud at exec, even when the ABI version number coincides.
- **The committed ABI snapshot cannot be locally stale.** A committed
  `abi/snapshot.json` that has drifted from its authoritative sources
  fails loud in the local pre-test gate, not only in CI, so the value
  guest keys read is proven fresh before any suite runs.
- **Preserve the invalidation boundary:** guests rebuild / are rejected
  **only** when the ABI structure or version changes (i.e. when
  `abi/snapshot.json` or `ABI_VERSION` moves), never when a kernel
  internal changes.
- **Preserve the no-op speed win** (929s→7.5s): no `cargo` *compile* on
  the no-op path.

## Non-goals (the one irreducible residual)

Detecting a **pure semantic ABI change that touches no declared
surface** — e.g. silently altering a syscall's blocking behavior while
changing no struct, number, or `snapshot.json` entry. Nothing
structural moves, so no automated build-time or exec-time check can know
behavior changed (CLAUDE.md's "the snapshot check is necessary but not
sufficient"). This is closed only by the procedural ABI rule — bump the
version for any semantic change — which this design makes **triply
enforced** (see "ABI development" below), but cannot automate away.
Auto-detecting semantic ABI drift is a separate, much larger problem.

Also out of scope: cross-machine cache sharing semantics; changing how
guest/upstream (SDK+libc) packages compute their own source closure
(A applies to Rust **workspace-crate** repository packages only).

## The invalidation model this design preserves

Two distinct cache-graph edge types stay distinct.

| Edge | Whose key it is in | Folds in | Moves when |
|---|---|---|---|
| **Source-closure** | the package's own compiled bytes | that package's own compile-closure hash | that package's own source changes |
| **ABI-contract** | a *guest's* key (its dependency on the kernel) | `local_abi_contract_digest` = `hash(abi/snapshot.json + ABI_VERSION)` | ABI structure/version changes |

`local_abi_contract_digest` (`tools/xtask/src/local_abi_identity.rs:5-45`)
hashes the canonicalized **`abi/snapshot.json`** plus `ABI_VERSION` — it
hashes **no kernel `.rs` source**. So a guest's key (and, after Part C,
its exec-time acceptance) moves only when the committed ABI
snapshot/version changes. Everything below touches the source-closure
edge (for workspace-crate packages) and the ABI-contract edge's
*enforcement*; neither adds kernel source to a guest's inputs. Net
result, unchanged from today but now **enforced** rather than **hoped**:

- Guest rebuilds / is rejected ⟺ `abi/snapshot.json` / `ABI_VERSION`
  changes.
- Kernel rebuilds ⟺ its own cargo source closure changes.
- Kernel internal change, same ABI → kernel rebuilds, **guests do not.**

## Design

Five parts. B is the immediate loud safety net for produced artifacts; A
makes the input set structurally sound so B's expected key is
trustworthy; C extends loud enforcement to the guest↔kernel boundary; D
removes the legacy paths. Foundational assumptions (agreed in review):
the stamp is computed from *inputs* and written into the artifact, so it
never feeds back into its own key (no circularity); the build engine and
`verify-fresh` compute the expected key through **one shared function**,
never two reimplementations.

### Part A — Structural: a Cargo-derived input closure (`cargo:<crate>` tag)

Replace hand-maintained crate path-lists for Rust workspace-crate
repository packages with a **derivation tag**. A `build.toml` input entry
is either a concrete path (unchanged, for non-Rust inputs) or a tag —
`{ kind = "cargo-crate", crate = "kandelo" }` (shorthand `"cargo:kandelo"`).
The tag expands, in tooling, to the crate's **full Rust build closure**:

- the `cargo metadata` path-closure of that crate (its workspace
  path-deps: `runtime-core`, `shared`, …); **plus**
- the cargo config files that govern the build but which `cargo
  metadata` does **not** report as graph nodes — `.cargo/config.toml`
  (and any up the directory tree) and `rust-toolchain.toml`.

That second bullet is the fix: `.cargo/config.toml` — today's actual
bug — is not a crate, so cargo won't list it; folding it into the tag's
expansion means the tag captures **everything that determines the cargo
output**, closing the omission class by construction. Registry-crate
versions are already covered by `Cargo.lock` (an existing input).

Hand-listed path entries then remain **only** for genuinely non-Rust
inputs (Nix derivation files, patches, non-Rust assets) — the "both
crate and Nix inputs" case is `"cargo:kandelo"` plus explicit Nix/patch
paths side by side.

- **Cost / no-op speed:** `cargo metadata` measured at 0.07s warm /
  0.36s cold on this worktree; cache the expansion and re-run only when
  a graph-affecting file changed (`**/Cargo.toml`, `Cargo.lock`,
  `.cargo/config.toml`). No `cargo` *compile* introduced.
- **Loud drift check:** the tag's expansion is guaranteed to cover the
  crate's real closure by construction; the check guards against a
  package that builds a workspace crate but *forgot the tag* — it fails
  loud rather than silently keying on an incomplete input set. It is
  per-package and self-referential (compares a package's inputs against
  *its own* cargo graph), so it can never trigger a guest rebuild.
- **Second consumer — the fork-instrument tool-hash.** Make
  `fork-instrument-tool-input-hash.sh`'s input set derive from the same
  `cargo:fork-instrument` expansion, so the native `wasm-fork-instrument`
  tool's staleness guard cannot silently omit `.cargo/config.toml` /
  `shared` / etc. either. One mechanism, two consumers (cache keys and
  the tool-hash).

**Staging.** Kernel first (the reported fire), then generalize the tag
+ drift-check to the other Rust workspace-crate repository packages
(inventory during implementation; the `kernel` / `userspace` special
casing in `binary-resolver.ts:1729` is a starting hint). The drift check
makes any not-yet-migrated package fail loud rather than silently stale,
so each rollout step is safe.

### Part B — Loud, ABI-independent staleness backstop for produced artifacts

Split by **loaded vs. produces**:

**B1 — Loaded wasm artifacts (stamp + verify).** For every wasm
artifact produced from a workspace crate and mirrored to staging
(`kernel.wasm`, `userspace.wasm`, and any future ones):

- **Stamp** the artifact with the full cache key it was built under, as
  a Wasm custom section (e.g. `kandelo-build-key`, a 32-byte digest).
  Written into the **cached** artifact at cache-store time (so the
  belt-and-suspenders check below can read it), then mirrored verbatim
  to `source-only-v1/`.
- **Verify** in `verify_fresh_report`: recompute the expected key via
  the shared key function and compare to the stamp read from the staged
  artifact. On mismatch, hard-fail before any suite runs:
  ```
  local-binaries/source-only-v1/kernel.wasm is stale: it was built for
  key <stamp>, but the current source tree resolves to key <expected>.
  Rebuild with `./run.sh setup` (or `cargo xtask bootstrap`).
  ```
  This is ABI-independent: a same-ABI internal change moves the key, so
  the stamp no longer matches → loud. Cost: `cargo metadata` +
  a 3.9 MB source-closure sha256 measured at 0.03s → ~tens of ms on the
  7.5s no-op path.
- **Belt-and-suspenders:** the trusted cache-hit path also reads the
  stamped key from the cached artifact and confirms it equals the cache
  directory's key (a cheap section read, no full re-hash). This catches
  a corrupted/misfiled cache entry — the exact 933-vs-980 KB
  "wrong bytes at the right key name" symptom.

**B2 — Build-time native tools (source-input-hash).** Tools that
*produce* other artifacts (`wasm-fork-instrument`) are not loadable wasm
and get no stamp; their staleness is prevented by a source-input-hash
guard. `wasm-fork-instrument` already has one
(`fork-instrument-tool-input-hash.sh`, checked at
`run-wasm-fork-instrument.sh:26,46`). Part A makes that hash
cargo-derived so it cannot silently omit inputs. No new mechanism —
just soundness.

**B3 — Committed ABI snapshot drift (local loud check, no overwrite).**
The committed `abi/snapshot.json` feeds every guest's cache key (via the
abi-contract digest), so a snapshot that has drifted from its
authoritative sources would let guests read a stale contract and skip a
rebuild they should do. CI already catches this
(`scripts/check-abi-version.sh` → `dump-abi --check`), but only in CI.
Pull the same **check** — regenerate the snapshot *in memory* and
compare, **never overwrite the tracked file** — into the local pre-test
freshness gate alongside B1, so a stale committed snapshot fails loud
locally with a "run `bash scripts/check-abi-version.sh update` and
commit the result" message before any suite runs.

This deliberately does **not** auto-regenerate-and-commit the snapshot
at build time: overwriting it would kill the review forcing-function
(an incompatible ABI change must surface as a human-reviewed diff + a
conscious `ABI_VERSION` bump/additive decision), mutate tracked source
as a build side effect, force a kernel build before every build, and
couple guest keys to `dump-abi` runtime determinism. A loud *check*
gives the same freshness guarantee with none of those costs.

Cost: `dump-abi --check` builds the kernel to read its exports; this is
a bounded no-op `cargo build` when the kernel is already built, and the
check is gated to run only when `crates/shared` or the kernel sources
changed since the snapshot, keeping the true no-op path clean.

### Part C — Guest↔kernel: enforce the ABI *contract digest* at exec

Close the "numbers coincidentally match" hole in the exec-time program
check.

- **Stamp each guest** at build time with the abi-contract digest it was
  built against (`hash(abi/snapshot.json + ABI_VERSION)`), as a custom
  section — not merely the version number.
- **Verify at exec** (extend `verifyProgramAbi` /
  `describeWasmArtifactPolicyFailures`, `worker-main.ts:3145,3192`;
  `constants.ts:2403`): compare the guest's stamped contract-digest to
  the running kernel's current contract-digest. **Mismatch → loud
  rejection**, even when the ABI version numbers coincide.

Effect: any *structural* ABI change regenerates `snapshot.json` → the
digest changes → (a) guests rebuild via the key (existing), and (b) any
un-rebuilt straggler is **rejected loud at exec** (new). Belt (rebuild)
and suspenders (exec rejection). The digest moves only on
snapshot/version changes, so the boundary is preserved — a kernel
internal change neither rebuilds nor rejects guests.

- **Rollout (embedded decision — recommended: warn-then-enforce).**
  Introducing a *required* stamp that exec rejects-if-missing would
  break every existing guest → itself an incompatible artifact change
  needing an `ABI_VERSION` bump. To avoid a bump merely to introduce the
  mechanism, mirror the existing `verifyProgramAbi` legacy pattern:
  **warn** if the contract-digest stamp is absent (legacy artifact),
  **hard-fail only on a mismatch**; tighten to *required* at the next
  natural ABI bump (which is itself an ABI-observable tightening → a
  bump). Alternative: bite the bump now and require the stamp
  immediately. Recommendation: warn-then-enforce.

### Part D — One authoritative artifact; remove legacy read-paths

Collapse every consumer onto the single authoritative artifact; a miss
is a loud error, never a legacy fall-through.

- Remove the `kernel.wasm → kandelo-kernel.wasm` filename alias
  (`binary-resolver.ts:233-234`).
- Redirect/remove the `host/wasm/kandelo-kernel.wasm` staging
  (`run.sh:1985-1989`) and npm export (`host/package.json:101-102`) so
  the shipped kernel flows from the authoritative source, not a
  separately-copied legacy tree. (Decide during implementation: ship the
  authoritative name directly vs. drop the `./wasm` / `./kernel.wasm`
  exports.)
- Fix `host/test/teardown-reclaim.test.ts:27-30` to resolve through the
  resolver / source-only tier.
- Remove the `local-binaries/kernel.wasm` / `binaries/kernel.wasm`
  fallbacks and error strings in `vite.config.ts:319-321,353-357`.
- Fix the doc drift at `tools/xtask/src/main.rs:34-35`
  (`kandelo-kernel.wasm` vs. the `kernel.wasm` the code reads).
- Sweep for any remaining legacy kernel-path reference and remove it. A
  warning is a fallback only where a reference genuinely cannot be
  removed yet; the default is removal.

## ABI development (defect 2/5 during a version bump)

The kernel is **naturally, redundantly** invalidated on an ABI bump:
(a) the `abi_version` folded into its key (`build_deps.rs:15772`), (b)
the abi-contract digest, and (c) the `crates/shared` source content hash
(the edited `ABI_VERSION` const) — which A guarantees is in the derived
closure. A same-ABI iterative edit during development still moves the
source hash → rebuild, with B1's stamp failing loud on any stale mirror.
So kernel staleness during ABI development needs nothing ABI-specific.

The version-bump workflow is loud-fenced: `local_abi_contract_digest`
**errors** if `snapshot.json`'s `abi_version` ≠ the code's expected
version (`local_abi_identity.rs:30-35`), so bumping the const without
regenerating the snapshot fails the build.

Guest safety across a bump is now triply enforced: the build fails if
the snapshot isn't regenerated; guests rebuild via the contract-digest
key; and any un-rebuilt guest is rejected loud at exec (Part C).

The local dirty-tree window — sources edited but `snapshot.json` not yet
regenerated, so guest keys read a stale committed snapshot — is closed
by B3's local drift check: the pre-test gate fails loud until you run
`check-abi-version.sh update`, instead of quietly building guests
against yesterday's contract. The **only** residual is the Non-goals
case — a semantic change touching no declared surface — for which the
defense is procedural: bump the version for any semantic change.

## Data flow (after)

```
crates/kernel + runtime-core + shared + .cargo/config.toml + rust-toolchain.toml
        │  cargo:kandelo tag → derived closure (A)     ── same expansion feeds
        ▼                                                  fork-instrument tool-hash
cache key = f(derived closure, ABI_VERSION, abi-contract, deps)
        │  build → stamp key into artifact custom section (B1)
        ▼
local-binaries/source-only-v1/{kernel,userspace}.wasm   ← the ONE authoritative copy
        │  verify_fresh: expected key == stamped key? (B1) else LOUD FAIL
        ▼
resolver / vite / node host  ← no legacy alias, no legacy tier (D)

guest.wasm  ── stamped with abi-contract digest (C)
        │  exec: guest digest == kernel current digest? else LOUD REJECT (C)
        ▼
run against kernel
```

## Error handling

- B1 stamp mismatch in `verify-fresh` → loud stale-artifact error +
  rebuild command; non-zero exit before any suite.
- B1 trusted cache-hit stamp ≠ directory key → loud corrupt-cache error;
  treat as a miss and rebuild.
- A `build.toml` builds a workspace crate but lacks a `cargo:` tag →
  loud config-drift build error.
- B3 committed `abi/snapshot.json` drifted from sources → loud stale
  error in the local pre-test gate + "run check-abi-version.sh update";
  the tracked file is never overwritten by the check.
- C guest contract-digest ≠ kernel's → loud exec rejection; absent stamp
  → warn (legacy) during the warn-then-enforce rollout.
- D missing authoritative artifact at a consumer → loud "not found"
  error, never a legacy fall-through.

## Testing

- **Unit (xtask):** stamp round-trips the key; `verify_fresh_report`
  fails on stamp/expected mismatch, passes on match; the `cargo:kandelo`
  expansion includes `.cargo/config.toml` + `rust-toolchain.toml`; the
  drift check fails a workspace-crate package missing its tag; the
  fork-instrument tool-hash includes the same expansion.
- **Regression (the reported bug):** editing `.cargo/config.toml`
  changes the kernel key (omission closed); a same-ABI edit to a
  `crates/kernel` `.rs` file changes the key while `abi/snapshot.json` is
  untouched, and a guest program's key is **unchanged** (boundary
  preserved).
- **Snapshot drift (Part B3):** a deliberately-stale committed
  `abi/snapshot.json` fails the local pre-test gate; a fresh one passes;
  the check never modifies the tracked file; the gate is skipped when
  neither `crates/shared` nor the kernel changed since the snapshot.
- **Guest exec (Part C):** a guest stamped with an old contract-digest is
  rejected loud against a kernel with a new digest even when ABI numbers
  match; a matching digest is accepted; an unstamped legacy guest warns
  (not fails) during rollout. Run on **both** Node and browser hosts
  (Host Runtime contract).
- **Resolver/host (Node + browser):** with the alias removed, a
  `kernel.wasm` request resolves only the authoritative artifact; a stale
  legacy-named file does not satisfy it; `teardown-reclaim` and the
  browser demos resolve through the authoritative path.
- **End-to-end speed:** build the kernel, then time `./run.sh test`
  before/after to confirm the no-op path stays within the measured
  ~sub-second overhead (Validation contract: measure the claim). Per the
  Validation/ABI contracts, kernel-touching changes also run the relevant
  conformance consideration, not just unit tests.

## Rollout / risk

- B is additive and independently valuable — lands first, immediately
  converting silent produced-artifact staleness to loud failure.
- A is kernel-first then generalized; the drift check makes any
  not-yet-migrated hand-listed package fail loud rather than silently
  stale.
- C uses warn-then-enforce to avoid an `ABI_VERSION` bump merely to
  introduce the stamp; it is cross-host (Node + browser) and needs
  both-host verification per the Host Runtime contract.
- D is mechanical but cross-host (Node + browser + npm).
- **No `ABI_VERSION` bump for B or the C mechanism**, provided every
  existing artifact-policy reader ignores unknown custom sections. This
  is the single thing that could invalidate the "additive, no-bump"
  framing and **must be verified during implementation** across the four
  readers: host `describeWasmArtifactPolicyFailures` / `extractAbiVersion`
  (`constants.ts`), build-layer `wasm_artifact_policy_failures_for`
  (`build_deps.rs`), and fork-instrument `artifact_identity`
  (`contract_inventory`). Confirm the new sections do not collide with
  `wasm-posix-abi` / `__abi_version`.
