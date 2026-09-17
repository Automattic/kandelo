# Bring the kernel into the keyed discipline the packages already have

**Status: proposal, 2026-09-17. Rewritten twice the same day**, both times
because checking something this document listed as unchecked changed what it
should say. The thesis survived both; the argument for it got shorter and the
work got smaller.

Requested by the maintainer after *"why is there a kernel.wasm that isn't named
or addressed by cache key at all?"* and its follow-up: *which route would
simplify both testing and releasing while ensuring freshness for each?*

Nothing here is implemented.

## The short version

**The route already exists and already works — for every ordinary package.** A
package's artifacts live at
`local-binaries/.kandelo-local-generations/<arch>/<pkg>/<cache-key>/…`, so the
key IS the path, freshness is structural, and the artifacts inside carry no
stamp at all because none is needed.

**The kernel is the exception**, and it is where the freshness failures happen.
It is projected to a fixed name, `local-binaries/source-only-v1/kernel.wasm`,
with its key stamped *inside the bytes* as a `kandelo.build.key` custom section,
and freshness handled by a bespoke gate that reads the stamp and compares it to
a recomputed key.

So this is not a proposal to invent a mechanism. **It is a proposal to stop
special-casing one artifact.**

## Measured, 2026-09-17

| | ordinary package (bzip2, git, nginx, redis, vim, wget, less…) | kernel |
|---|---|---|
| lives at | `<store>/<arch>/<pkg>/<cache-key>/<session>/x.wasm` | `source-only-v1/kernel.wasm`, a fixed name |
| key recorded as | the directory name | a custom section inside the bytes |
| internal stamp | **none** — `bzip2.wasm` has no `kandelo.build.key` | `dfd6ebfb…` at offset 1,430,734 |
| newest generation | **Sep 16** — still written on every build | **Sep 12** — none written in four days |
| freshness is | structural: wrong key ⇒ different path ⇒ unreachable | a comparison, in `verify_fresh_kernel_artifact` |

The `.build-key` **sidecar** files next to `local-binaries/*.wasm` are a third
form again, used by the ambient side modules; a sidecar does not survive a copy.

The kernel's own history shows the drift. Its 21 stored generations all carry
one mtime, `2026-09-12 10:53:36`, and **not one directory name matches the stamp
inside its own artifact** — `aded8633…` holds a kernel stamped `0c2a0675…`,
`0c021ff5…` holds `ec9e9ee1…`, `0c91200f…` holds `56cff738…`, and `1124611e…`
holds one with no stamp at all. Two keys for two purposes, in one place, with
nothing reconciling them.

## Why the exception is the expensive one

**1. Two fixed names for one artifact, and only one was refreshed.**
`local_build.rs` records it in its own comment: on **2026-09-09** a `./run.sh
rebuild kernel` refreshed the SourceOnlyV1 projection and left the ambient
`local-binaries/kernel.wasm` three days stale. `verify-fresh` reported green —
it only checked the tier copy — while every host-native test failed to
instantiate on an import-type mismatch, because `crates/host-native/src/lib.rs`
loads the ambient path directly. The fix was to teach the gate about both names.
**A fixed name is a thing the gate must be told about; a keyed path is not.**

**2. The cheap provisioning path and the freshness gate contradict each other,
and `build_deps.rs` says so in as many words.** Only the local-build engine
stamps `kandelo.build.key`. An artifact installed by `build-deps
install-local-artifact` — the documented cheap path for a fresh worktree —
carries no stamp, so the gate refuses it and points at `./run.sh setup`, the
expensive path the reader was told not to run. The installer *correctly* refuses
to stamp: its source argument is caller-supplied, so a stamp there would let a
stale file or a copy from another worktree acquire a claim of engine provenance.
**The contradiction is a consequence of provenance living inside the bytes.** A
package has no such problem, because putting bytes at a keyed path is a claim
the installer can simply decline to make.

**3. It is the artifact most likely to be stale and the one it hurts most.**
Today, in this lane worktree, `source-only-v1/kernel.wasm` is stamped for a key
the tree no longer resolves to — which is what blocks the browser cycle. No
package is in that state, because a package cannot be.

## The route

1. **Publish the kernel as a generation, like every other package.** It already
   was, until Sep 12. `<store>/<arch>/kernel/<key>/kernel.wasm`, written by the
   same engine path that writes bzip2's.

2. **Keep the stable name as an indirection, not a copy.** `source-only-v1/`
   gets an index — name → key — that the resolver reads. Consumers keep asking
   for `kernel.wasm`.

   *An index file rather than symlinks.* A symlink is the obvious
   implementation and the wrong one: it makes the layout depend on filesystem
   and archive behaviour this project must keep working across macOS, Linux and
   CI artifact upload. An index is a file, and a file copies everywhere.

3. **Retire the stamp and the sidecars as FRESHNESS records.**
   `kandelo.build.key` may stay as provenance a released artifact carries, but
   nothing reads it to decide freshness, and `verify_fresh_kernel_artifact`'s
   stamp comparison goes with it. The ABI-version check in the same function is
   independent and stays.

4. **Hand-staging gets an honest home.** `build-deps install-local-artifact`
   writes to an explicitly unkeyed slot the resolver uses only under an opt-in
   flag, and the gate reports *"the unkeyed slot is in use"* — a place, not a
   missing stamp. The cheap path and the gate stop contradicting because they
   stop making claims about the same object.

**Which key names the store.** The existing directories are named by the package
cache-identity key (`manifest_cache_key_sha`), while the kernel's stamp is the
SourceOnlyV1 cache key (`expected_source_only_cache_key`). Both come from
`manifest_cache_key_sha_for_policy` under different `ResolvePolicy` values. **The
packages' choice should win** — the kernel joins the scheme that already works
rather than the scheme joining it — which means the kernel's freshness question
becomes "is there a generation for my cache identity?" and stops being a
separate derivation.

## Why this simplifies testing

- A test cannot get a stale kernel by accident, because the wrong bytes are at a
  different path — the property packages already have.
- The `verify-fresh` stamp comparison disappears from test setup. A suite asks
  the resolver and gets an artifact or a miss.
- The 2026-09-09 class of bug cannot recur: there is nothing to refresh twice.

## Why this simplifies releasing

- **A release becomes a selection of keys.** Publishing is copying the keyed
  directories a manifest names, and provenance is the path, so it survives any
  copy — unlike a sidecar, which does not.
- Nothing re-derives identity from inside the bytes, so the release path needs
  no wasm parser to answer "which build is this?".
- One artifact's identity stops being three encodings that can disagree — which,
  as the kernel's own 21 generations show, they already do.

## Costs, honestly

- **Every consumer that hardcodes a kernel path must go through the resolver**:
  `crates/host-native/src/lib.rs`, `scripts/build-rootfs.sh`, the browser
  build's `@binaries/` alias, and whatever a census adds. The census is the
  first implementation step, not an afterthought.
- **The store needs a prune policy.** It is load-bearing under this route, and
  21 kernel generations are already on disk.
- **An index can go stale too.** It must be written in the same atomic publish
  as the generation, so it cannot drift without the write failing. That has to
  be enforced, not assumed.
- **Migration is not free.** Both layouts must work while consumers move.
- **The old kernel generations cannot be re-keyed from what is on disk**, since
  their stamps do not match their directory names and one has no stamp. They
  should be discarded rather than reconciled.

## What I did not check

- ~~Whether the generation store is pruned.~~ **Checked.** Not pruned, and not
  dead: ordinary packages get new generations on every build. Only the kernel
  stopped, which is what turned this from "revive a store" into "stop
  special-casing one artifact".
- **What moved the kernel out of the generation scheme on 2026-09-12, and
  whether that was deliberate.** I established that it happened; I did not find
  the commit. **If it was deliberate there is a reason I have not heard, and it
  belongs in this document before anyone implements against it.** This is the
  one remaining question that could still invalidate the route.
- **Whether `dash` stopping too is the same cause.** It has one generation, also
  Sep 12, but it may simply not have been rebuilt since.
- **The full consumer census.**
