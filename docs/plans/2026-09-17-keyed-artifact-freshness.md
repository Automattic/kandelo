# Make the resolved path carry the build key

**Status: proposal, 2026-09-17. Revised the same day**, after checking one of the three things it listed as unchecked; the answer changed step 1 and added a step 0. Requested by the maintainer after the question
*"why is there a kernel.wasm that isn't named or addressed by cache key at
all?"*, and its follow-up: *which route would simplify both testing and
releasing while ensuring freshness for each?*

Nothing here is implemented. It is written to be accepted or rejected before
code moves, because it touches the build system rather than one lane.

## The short version

A build key is recorded **three different ways** today, and the one thing that
is *not* keyed is the path a consumer resolves. So a stale artifact is present
and served rather than absent, and freshness becomes a check someone has to
remember to run.

The proposal is to make the resolved path carry the key: consumers resolve a
stable name through a per-tier index to `<store>/<key>/…`. Present means fresh
by construction; absent means build it. There is nothing to compare, and nothing
to forget.

## What exists now

| record | where | shape | survives a copy? |
|---|---|---|---|
| generation store | `local-binaries/.kandelo-local-generations/<arch>/<pkg>/<cache-identity>/…` | a directory named by a package cache-identity key — **not** the key freshness is judged on; see below | yes |
| tier mirror | `local-binaries/source-only-v1/kernel.wasm` | `kandelo.build.key` custom section, inside the wasm | yes, but only for wasm |
| ambient sibling | `local-binaries/fork_module32.wasm` | `.build-key` sidecar file | **no** |

Verified by reading the bytes: `source-only-v1/kernel.wasm` carries
`kandelo.build.key` followed by 32 raw bytes at offset 1,430,734 and has no
sidecar; `fork_module32.wasm` has a sidecar and no internal stamp.

`cargo xtask verify-fresh` compares a stamp against the key the current tree
resolves to, over the artifacts in `VERIFY_FRESH_KERNEL_ARTIFACTS` —
`source-only-v1/kernel.wasm` and `kernel.wasm`.

## Three failures already on the record

**1. Two fixed names for one artifact, and only one was refreshed.**
`local_build.rs` records it in its own comment: on **2026-09-09** a `./run.sh
rebuild kernel` refreshed the SourceOnlyV1 projection and left the ambient
`local-binaries/kernel.wasm` three days stale. `verify-fresh` reported green —
it only checked the tier copy — while every host-native test failed to
instantiate on an import-type mismatch, because `crates/host-native/src/lib.rs`
loads the ambient path directly. The fix was to teach the gate about both names.
**A second fixed name is a second thing the gate must be told about.**

**2. The cheap provisioning path and the freshness gate contradict each other,
and `build_deps.rs` says so in as many words.** Only the local-build engine
stamps `kandelo.build.key`. An artifact installed by `build-deps
install-local-artifact` — the documented cheap path for a fresh worktree —
carries no stamp, so the gate refuses it and points at `./run.sh setup`, the
expensive path the reader was told not to run. The installer *correctly* refuses
to stamp: its source argument is caller-supplied, so a stamp there would let a
stale file or a copy from another worktree acquire a claim of engine provenance.
The contradiction is structural, not an oversight.

**3. The generation store is not the record it looks like.** This was listed as
unchecked in the first draft of this document, with the note that it *"would
change step 1 if it comes out the wrong way"*. It did. Measured 2026-09-17:

* **The directory name is not the artifact's build key.** A generation directory
  is `package_generations.join(cache_key_sha)` — build_deps.rs calls it the
  *"package cache-identity generations root"* — while the stamp `verify-fresh`
  compares is `expected_source_only_cache_key(repo, "kernel")`. Both come from
  `manifest_cache_key_sha_for_policy`, but parameterised by different
  `ResolvePolicy` values, so they are **two keys for two purposes** and not
  interchangeable.
* **Sampled four generations; none matched.** `aded8633…` holds a kernel stamped
  `0c2a0675…`; `0c021ff5…` holds `ec9e9ee1…`; `0c91200f…` holds `56cff738…`;
  and `1124611e…` holds a kernel with **no stamp at all**.
* **The store is not pruned — it is simply not written any more.** All 21 kernel
  generations carry one identical mtime, `2026-09-12 10:53:36`, which is a
  single bulk operation rather than 21 builds. The mirror is `2026-09-16 23:12`.
  Every kernel build in those four days refreshed the mirror **without writing a
  generation**.

So the store cannot be adopted as the authority by taking its directory name,
which is what step 1 below originally proposed. It would have to be **re-keyed**
first, on a decision about which of the two keys names it.

## The proposed route

0. **First, decide which key names the store** — the prerequisite the finding
   above created, and the reason this is step zero rather than a detail of step
   one. The freshness question is *"were these bytes built from this source?"*,
   which is what `expected_source_only_cache_key` answers, so that is the key
   the resolution path should carry. The package cache-identity key answers a
   different question — *"which package closure produced this?"* — and is the
   right name for a **build-input** cache, which is what the generation store
   appears to have become. They may both be worth keeping, under different
   roots and with the difference named.

1. **One record of the freshness key: the path.** Re-key the artifact side of
   the store on the build key, and make it the only authority.
   `kandelo.build.key` may stay as provenance metadata, but nothing reads it to
   decide freshness, and the `.build-key` sidecars go. **This is now a
   migration, not an adoption** — the existing directories are named by the
   other key, and one sampled artifact has no stamp to migrate from, so they
   cannot all be re-keyed from what is on disk. Some will have to be rebuilt or
   discarded, and saying which is part of accepting this.

2. **The stable name becomes an indirection, not a copy.** Each tier gets an
   index — `local-binaries/<tier>/index.json`, mapping artifact name → key —
   that the resolver reads. Consumers keep asking for `kernel.wasm` and are
   answered with `<store>/<arch>/kernel/<key>/kernel.wasm`.

   *Index file rather than symlinks.* A symlink is the obvious implementation
   and the wrong one here: it makes the layout depend on filesystem and archive
   behaviour, which this project has to keep working across macOS, Linux and CI
   artifact upload. An index is a file, and a file copies everywhere.

3. **Freshness stops being a comparison.** Compute the key, look for it. Present
   → fresh, because a wrong-key artifact is at a different path and cannot be
   reached by accident. Absent → a miss, and the build builds it. The
   compare-a-stamp step, and every place that must remember to run it, goes.

4. **Hand-staging gets an honest home.** `build-deps install-local-artifact`
   writes to an explicitly unkeyed slot that the resolver uses only under an
   opt-in flag. The gate then reports *"the unkeyed slot is in use"* — a place,
   not a missing stamp. The cheap path and the gate stop contradicting, because
   they are no longer making claims about the same object.

## Why this simplifies testing

- A test cannot accidentally get a stale artifact, because staleness is
  unrepresentable: the wrong bytes are at a different path.
- The `verify-fresh` pre-flight disappears from test setup. Today a suite that
  wants a fresh kernel has to run a gate and interpret its verdict; under this
  route it asks the resolver and either gets the artifact or gets a miss.
- The 2026-09-09 class of bug — one name refreshed, another not — cannot recur,
  because there is one name and it resolves through the key.

## Why this simplifies releasing

- **A release becomes a selection of keys.** Publishing is copying the keyed
  directories a manifest names. Provenance is the path it came from, so it
  survives any copy — unlike the sidecars, which do not.
- Nothing has to be re-derived from inside the bytes, so the release path does
  not need a wasm parser to answer "which build is this?".
- An artifact's identity is the same fact in the store, in the index, and in the
  release, rather than three encodings that can disagree.

## Costs, honestly

- **Every consumer that hardcodes a path must go through the resolver.** That is
  the real work: `crates/host-native/src/lib.rs`, `scripts/build-rootfs.sh`, the
  browser build's `@binaries/` Vite alias, and whatever else a census turns up.
  The census is the first implementation step, not an afterthought.
- **The store needs a prune policy.** Keeping generations costs disk. This is
  already true — 21 kernel generations are on disk now — but the route makes the
  store load-bearing, so the policy stops being optional.
- **An index is a file that can go stale too.** It is written by the engine at
  publish time, in the same operation that writes the generation, so it cannot
  drift from the store without the write itself failing. That property has to be
  enforced (one atomic publish), not assumed.
- **Migration is not free.** Both layouts must work while consumers move, which
  means a period where the old mirror is written *and* the index is, with the
  gate checking the index.

## What I did not check

- ~~Whether the generation store is pruned.~~ **Checked, 2026-09-17** — see
  failure 3. It is not pruned; it stopped being written. The answer cost step 1
  its original form, which is the argument for writing proposals with their
  unknowns listed rather than their conclusions polished.
- **What stopped writing generations on 2026-09-12, and whether that was
  deliberate.** I established THAT the mirror is refreshed without a generation;
  I did not find the commit or the code path that changed. If it was deliberate,
  the store is already considered obsolete by someone and this proposal should
  say so instead of reviving it.
- **Why one generation's artifact carries no `kandelo.build.key` at all.** An
  unstamped artifact inside the store is either a hand-staged install that
  reached it, or a build that predates stamping. Those have different
  consequences for a migration.
- **The full consumer census.** I named the consumers I tripped over, not all of
  them.
- **Whether any consumer needs a path it can compute without running a
  resolver** — a shell script or a Vite config that cannot easily read an index
  would push back on step 2.

These are the three things to settle first if the route is accepted.
