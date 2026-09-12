# Lane U1 — census of build automation, ranked by blast radius

**Date: 2026-09-11. Status: complete.**

Lane U's own instruction was to rank by blast radius, not size: a script
that computes a cache key or emits a manifest can produce a wrong
artifact silently; a script that runs a test suite fails loudly. **Only
the first kind earns migration.** This census performs that ranking.

## The tier that matters

**14 non-Rust scripts compute a build-freshness digest.** Excluding test
scripts, the ones that can silently produce a wrong artifact:

| Script | Lines | Why it is tier 1 |
|---|---|---|
| `build-step-input-hash.sh` | 108 | **The shared cache-key primitive.** Consumed by `build-host.sh`, `build-rootfs.sh` **and `tools/xtask/src/local_build.rs`** |
| `fork-instrument-tool-input-hash.sh` | 29 | The script `build-step-input-hash.sh` says it "mirrors" — two copies of the folding logic |
| `generate-rootfs-package-manifest.mjs` | 689 | Already indicted by lane S: emits `sudo` setuid-root as a lazy ref with no integrity digest |
| `package-build-roots.sh` | 870 | Package build-root identity |
| `browser-binary-package-roots.mjs` | 770 | The browser half of the same job |
| `build-local-vfs-asset-group.ts` | 764 | Asset-group staging |
| `vfs-product-deployment.ts` | 764 | Product deployment identity |
| `install-local-binary.sh` | 618 | Publishes into the artifact tiers lane R measures |
| `vfs-product-catalog.mjs` | 327 | Catalog identity |

The remainder — release verification, CI deployment checks, workspace
packing — **fail loudly** and are tier 2.

## The finding: a cache-key primitive in shell, crossing into Rust

`build-step-input-hash.sh` is the archetype and it is worse than a shell
script doing shell work. It is a **content-identity digest primitive**,
folding each input's `git hash-object` blob hash into one value precisely
so that mtimes cannot make a stale tree look fresh — and `xtask
local_build.rs` consumes it.

So the build's freshness decision is computed by a shell script that
nothing type-checks, and a Rust program depends on its output.

**This repo has already been bitten by exactly this.** The kernel build's
cache key once omitted `crates/runtime-core` and silently served a stale
kernel despite green unit tests. The fix that came out of it —
closure-derived cache keys, `cargo_closure_paths` in
`tools/xtask/src/build_deps.rs` — is the pattern this lane should extend,
and it already exists in Rust beside the shell scripts that do not use it.

**Two shell scripts fold the same logic.** `build-step-input-hash.sh`'s
own comment says it "mirrors `fork-instrument-tool-input-hash.sh`'s
content-identity approach … but generalizes it". That is a copy that was
generalised rather than a shared implementation.

## The gate

`buildAutomationShell` (25,658 → 8,000) and `buildAutomationScript`
(10,921 → 4,000) were line counts over everything in `scripts/`. They
measure size, which the lane's own text says is the wrong axis, and they
would be satisfied by rewriting loud, harmless test runners.

**Replaced by `buildFreshnessDigestsOutsideRust`** — non-Rust scripts
computing a build-freshness digest. **Ceiling 14, target 6.** Target is
not 0: release verification and CI deployment checks legitimately compute
digests in shell and fail loudly when wrong.

## Revised increments

- **U1 — this census.** Done.
- **U2 — one content-identity digest implementation in Rust**, replacing
  both `build-step-input-hash.sh` and `fork-instrument-tool-input-hash.sh`,
  on the `cargo_closure` pattern that already exists.
- **U3 — `generate-rootfs-package-manifest.mjs`.** It is tier 1 on its own
  merits and lane S needs it anyway for the setuid integrity digest. **Land
  these together.**
- **U4 — the package-root and asset-group emitters.**
- **U5 — leave test runners, CI checks and dev conveniences in shell**, and
  say so, so a later pass does not migrate them for tidiness.

## Ranking against the campaign

**This lane still does not serve goal V4**, and nothing in the census
changes that: no part of build automation is host API surface. It is
ranked last of the new lanes.

**But U2 and U3 are cheap and have already-realised failure modes**, which
is a different argument from "migrate the scripts". If any of this lane is
done early, it is those two.

## Estimate

From **15–30 agent-days, low** to **12–25 agent-days, low** overall — but
the tier-1 subset (U2 + U3) is **3–6 agent-days** and carries nearly all
the risk reduction. The rest of the range is tier-2 work the census
recommends not doing.

## What this census did not establish

- **Whether the 14 scripts' digests are currently correct.** They were
  classified by what they compute, not audited.
- **Whether `xtask` consuming a shell digest has caused a failure**, only
  that it is the shape that caused one before.
- **The 25,658 lines of shell were not read.** They were classified by
  pattern; tier 2 was assumed loud rather than demonstrated loud.
