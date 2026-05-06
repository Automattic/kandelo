# Decoupled Package Builds & Software Sources — Design

Date: 2026-05-05
Branch: `decoupling-package-builds-and-enabling-individual`

## §1. Context & goals

The package management system landed in PRs #341/#347/#348/#352–#360/#361/#362, with PR-staging publish flow designed in `2026-04-29-pr-package-builds-design.md`. Today:

- One `binaries-abi-v<N>` GitHub release holds every package as a `.tar.zst`.
- A central `binaries.lock` pins each package's `cache_key_sha` against that release.
- The CI publish step runs as a single monolithic job. If any package build fails, **no package publishes** — the whole staging step exits non-zero.
- Per-package `examples/libs/<name>/deps.toml` files declare each package's metadata, dependencies, and per-arch archive URL+sha.
- Third-party packages have no first-class story; everything assumes first-party origin under one release tag.

This design replaces the single-monolithic-job publish flow with **per-package matrix builds** that publish independently, and introduces a **software source** concept that makes individual built packages addressable by URL — usable by first-party CI, third-party indexes (e.g. a fun-pack with Doom / NetHack / ScummVM), or any HTTP-served directory.

Goals:

1. **Decouple package builds.** mariadb failing must not block bash from publishing.
2. **URL-addressable packages.** Each `.tar.zst` is the addressable unit, fetchable by any consumer.
3. **Third-party software sources.** Any HTTP host that serves a manifest + archive directory can act as a source.
4. **Partial publish is a first-class state.** When a package fails to rebuild in a given run, consumers transparently use the last-green sha (subject to a hard ABI-floor check).
5. **Migration from today's `binaries.lock` model is staged**, with each phase shipping behind a clear review boundary.

Non-goals (v1):

- **Fork-PR support.** Fork PRs continue to use the resolver's source-build fallback, as in the existing PR-package-builds design.
- **Package signing.** Deferred to a follow-up; trust is rooted in `archive_sha256` + HTTPS. See `docs/package-management-future-work.md`.
- **Auto-updates** ("is there a newer version of X?"). The infrastructure supports it (sources publish manifests), but the resolver does not poll automatically.
- **Garbage collection of stale archives.** Storage is cheap; old shas remain reachable indefinitely. Revisit when storage actually becomes a problem.

## §2. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│ Software source (e.g. binaries-abi-v6, fun-pack-v6)         │
│                                                             │
│   index.toml   ◄── manifest (lists packages, archive URLs)  │
│   <pkg-A>-wasm32-<sha>.tar.zst                              │
│   <pkg-A>-wasm64-<sha>.tar.zst                              │
│   <pkg-B>-wasm32-<sha>.tar.zst                              │
│   ...                                                       │
└─────────────────────────────────────────────────────────────┘
                       ▲
                       │ HTTP fetch by archive_url + sha
                       │
┌─────────────────────────────────────────────────────────────┐
│ Consuming repo                                              │
│                                                             │
│   examples/libs/<pkg-A>/package.toml  (β: source of truth)  │
│   examples/libs/<pkg-A>/package.pr.toml  (PR overlay,       │
│                                          gitignored)        │
│   ...                                                       │
└─────────────────────────────────────────────────────────────┘
```

A **software source** is a URL pointing at an `index.toml`. The first-party source is `https://github.com/wasm-posix-kernel/wasm-posix-kernel/releases/download/binaries-abi-v<N>/index.toml`. The fun-pack lives in a separate repo at its own URL. Third parties publish wherever they like.

A consumer's repo holds one `package.toml` per package they depend on. That file is the source of truth: it carries `archive_url`, `archive_sha256`, `kernel_abi`, dependencies, and provenance. The central `binaries.lock` is removed.

CI publishes packages as **per-file uploads** under one ABI-versioned release tag, plus a generated `index.toml` listing them.

## §3. Schema

### §3.1 `package.toml` (renamed from `deps.toml`)

```toml
name      = "mariadb"
version   = "10.5.28"
revision  = 1
kernel_abi = 6                          # NEW: optional in Phase A-bis, required after Phase B

depends_on = ["pcre2-source@10.44"]

[source]                                # existing — upstream tarball pin
url    = "https://archive.mariadb.org/mariadb-10.5.28/source/mariadb-10.5.28.tar.gz"
sha256 = "0b5070208da0116640f20bd085f1136527f998cc23268715bcbf352e7b7f3cc1"

[license]                               # existing
spdx = "GPL-2.0-or-later"
url  = "https://mariadb.com/kb/library-license/"

[build]                                 # required for first-party, optional for third-party
script_path = "examples/libs/mariadb/build-mariadb.sh"            # NEW: repo-relative (was: package-dir-relative `script`)
repo_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel.git"   # NEW: clonable URL
commit      = "8424f4fec"               # NEW: CI fills at publish; absent/empty allowed for never-published

[binary.wasm32]                         # existing — CI-managed
archive_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel/releases/download/binaries-abi-v6/mariadb-wasm32-abc123.tar.zst"
archive_sha256 = "abc123..."

[binary.wasm64]
archive_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel/releases/download/binaries-abi-v6/mariadb-wasm64-def456.tar.zst"
archive_sha256 = "def456..."
```

**Changes from today's `deps.toml`:**

- File renamed to `package.toml` to reflect what it actually is (package manifest, not just deps).
- `kernel_abi = N` is added. Resolver compares against current `ABI_VERSION` and refuses on mismatch. No range or wildcard — the kernel ABI surface (channel layout, syscall numbers, marshalled structs) is too tightly coupled to user binaries for cross-version compatibility to be safely declared. Ship a separate archive per ABI if you want to support multiple. Optional in Phase A-bis (parser accepts absence); validation tightens to required after Phase B's CI gating wires it into the matrix.
- `[build]` block is **required for first-party, optional for third-party.** New fields:
  - `script_path` — repo-relative path to the build script. **Renames** the existing `[build].script` field (which was package-dir-relative) to make the path canonical and disambiguate scripts named `build.sh` across packages.
  - `repo_url` — clonable URL with `.git` suffix. SCM is implicitly git today; a future `vcs` field would extend to other SCMs additively (default `vcs = "git"` would preserve all current files unchanged).
  - `commit` — the building-repo commit that produced the published archive. CI fills at publish time (same lifecycle as `[binary].archive_url` and `archive_sha256`). Allowed empty/absent for newly-created packages that haven't published yet.
- `archive_url` in `[binary.<arch>]` is always **absolute** in `package.toml`. Resolver does not attempt URL-reference resolution against any base.
- `[binary.<arch>]` stays in `package.toml` (rather than being moved to `index.toml`) per the (P1) decision: the resolver fetches with `package.toml` alone, no round-trip to a catalog. The duplication with `index.toml` (which also lists each package's URL) is CI-managed — both files are co-published from the same source. If/when auto-update lands and the resolver needs to consult catalogs at runtime, revisit this.
- **Dropped from earlier drafts:** the top-level `software_source = "<URL>"` catalog pointer (YAGNI for v1; revisit when auto-update lands), and the parallel `[provenance]` block (its build-script-URL and build-commit fields are now folded into `[build]`).

### §3.2 `index.toml` (source manifest)

Generated by CI alongside per-file archive uploads, hosted at the same path as the archives:

```toml
abi_version = 6
generated_at = "2026-05-05T12:34:56Z"
generator    = "wasm-posix-kernel CI @ 8424f4fec"

[[packages]]
name    = "mariadb"
version = "10.5.27"

[packages.binary.wasm32]
archive_url    = "mariadb-wasm32-abc123.tar.zst"          # relative
archive_sha256 = "abc123..."

[packages.binary.wasm64]
archive_url    = "mariadb-wasm64-def456.tar.zst"
archive_sha256 = "def456..."

[[packages]]
name = "doom"
version = "1.10"

[packages.binary.wasm32]
archive_url    = "https://other-host.example/doom-wasm32-789xyz.tar.zst"  # absolute
archive_sha256 = "789xyz..."
```

**URL reference semantics:**

- An `archive_url` in `index.toml` is a URI reference per RFC 3986. **Relative refs resolve against the manifest's own URL.**
- This makes a self-contained source directory (manifest + archives) bit-identically mirrorable to any other HTTP host without rewriting the manifest.
- Curated indexes that aggregate packages from multiple origins use absolute URLs. The curator pins integrity via `archive_sha256` but not availability — if an upstream archive 404s, the curated index is effectively broken until the curator re-points or re-mirrors. This is an acceptable trade for the flexibility; it must be documented.

When the install tool generates a local `package.toml` from a manifest entry, it **resolves any relative URL to absolute** at that moment. Local `package.toml` files always have absolute URLs; they do not depend on knowing where they came from.

### §3.3 `package.pr.toml` (PR overlay, gitignored)

Mirrors today's `binaries.lock.pr` pattern, but per-package and per-file:

```toml
# examples/libs/mariadb/package.pr.toml — gitignored
[binary.wasm32]
archive_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel/releases/download/pr-372-staging/mariadb-wasm32-newsha.tar.zst"
archive_sha256 = "newsha..."

[binary.wasm64]
archive_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel/releases/download/pr-372-staging/mariadb-wasm64-othersha.tar.zst"
archive_sha256 = "othersha..."
```

The resolver merges `package.pr.toml` over `package.toml` field-by-field. Only fields present in the overlay take effect. CI generates these during PR builds; they are deleted at merge time and replaced by an updated `package.toml` (URLs pointing at the production release) via `c2 pre-merge amend`.

`.gitignore` adds:

```
examples/libs/*/package.pr.toml
```

## §4. Software sources

A **source** is an HTTP-fetchable `index.toml`. Adding a source means recording its manifest URL.

The first-party source for this repo:

```
https://github.com/wasm-posix-kernel/wasm-posix-kernel/releases/download/binaries-abi-v<N>/index.toml
```

A third-party source (e.g. the fun-pack):

```
https://github.com/wasm-posix-fun-pack/wasm-posix-fun-pack/releases/download/binaries-abi-v<N>/index.toml
```

**There is no source registry, schema field for source-name, or central source list.** A consumer adds a source by URL; that URL is the identity. The optional `source` field in `package.toml` records where a package was originally fetched from for human traceability; the resolver does not use it for fetching.

**Tooling (post-Phase-C):**

- `wasm-posix-pkg sources add <url>` — fetches the manifest, validates ABI compat, stores in `~/.config/wasm-posix-pkg/sources.toml`.
- `wasm-posix-pkg search [--source <url>]` — lists packages across configured sources; uses `index.toml` for discovery.
- `wasm-posix-pkg add <name> [--source <url>]` — finds the package in a configured source's manifest, writes a local `package.toml` to `examples/libs/<name>/` with absolute URLs.

(Tooling commands are post-design follow-up; the schema and resolver are the design.)

## §5. Publishing

### §5.1 Per-package matrix CI

The CI workflow that today runs `xtask stage-pr-overlay` as a single job becomes a **GHA matrix** with one job per (package, arch). Toolchain (musl + libc++ + sysroot) is restored from a shared cache layer at the start of each matrix entry.

Matrix entries are independent: mariadb's failure does not affect bash. Each entry uploads its `.tar.zst` to the release tag (production or PR-staging) on success; on failure, no upload, and the job is marked failed in the PR's check list.

A thin layering exists for the few foundational *-source packages and the toolchain-cache job: a `needs:` edge ensures these complete before the per-package matrix fans out.

### §5.2 Content-hash gating (D3)

Before the matrix runs, a fast pre-flight job computes each package's `cache_key_sha` (the same algorithm the resolver cache uses internally) and probes the target release for an existing archive at that sha. The matrix is then narrowed to only entries whose sha is not already published.

This gating:

- Catches transitive changes (toolchain bump, kernel ABI bump, build-script edit) automatically — the sha changes when any input changes.
- Skips work entirely (no job startup) when the package is unchanged. Cheaper than "run, hit cache, finish fast."
- Falls out free for kernel-ABI-bump PRs: every package's sha changes, so the entire matrix runs.

**Reproducibility audit (prerequisite for Phase B).** D3 is only sound if `cache_key_sha` is bit-reproducible across CI runs and developer machines. Known leaks must be hunted before relying on the gate:

- The Homebrew clang vs. Nix LLVM 21 producer divergence surfaced in PR #407 (memory: `feedback_always-use-nix-shell-for-builds.md`) is exactly the failure mode that breaks content-hash gating.
- Any timestamp, locale-dependent string, or non-pinned tool that ends up in archive bytes will cause spurious mismatches.
- Audit checklist (rough): rebuild every package twice on the same Nix shell, diff the archives byte-for-byte, fix any non-determinism. Then rebuild on a clean macOS-Homebrew vs. Linux-Nix shell, diff again. Ship the audit log alongside Phase B.

If reproducibility cannot be made tight, fall back to D2 (file-path change detection) for the affected packages and accept the over-rebuild cost.

### §5.3 Per-file uploads

Each successful matrix entry uploads its single `.tar.zst` directly to the target release tag. No combined-archive step; no `manifest.json` artifact in the old monolithic shape.

After the matrix completes, a single follow-up job generates `index.toml` from the asset list and uploads it to the same release tag. If the matrix had failures, the `index.toml` lists only the green packages. Failed packages are visible in the F2 status artifact (§6.3) but absent from the manifest.

**Release tag is single and undated per ABI: `binaries-abi-v<N>`.** Today's flow creates a fresh dated tag (`binaries-abi-v<N>-YYYY-MM-DD[-<seq>]`) on every prepare-merge / force-rebuild publish, and the central lockfile pins to that specific tag. With content-addressed per-file archives, the sha already encodes "when/what was built"; dated tags add no information. Under the new model, the tag is stable per ABI version and archives accumulate. This drops one moving part (no tag computation, no per-publish tag list), simplifies URL stability (a URL points at a specific archive sha forever), and matches the "URL is the addressable unit" goal. Existing dated tags from before Phase C remain in place — no re-tagging or migration of historical archives.

### §5.4 PR overlay flow

For PR builds, the target release tag is `pr-<NNN>-staging`. The matrix uploads to that tag; the post-matrix job generates a staging `index.toml`; the resolver fetches via `package.pr.toml` overlays.

`c2 pre-merge amend` (existing infrastructure) at merge time:

1. Re-runs the matrix against tip-of-main to produce production-tag artifacts.
2. Updates each affected `package.toml` with production URLs and shas (deleting any matching `package.pr.toml`).
3. Commits the result onto the PR before merge.

`pr-<NNN>-staging` releases are deleted on PR close, as in the existing design.

### §5.5 Force-rebuild (escape hatch)

`.github/workflows/force-rebuild.yml` is the manually-triggered escape hatch for refreshing durable archives when a `cache_key_sha` is suspected incomplete (e.g., a toolchain pin was bumped without invalidating package archives, and the maintainer wants to confirm the published bytes match a fresh source build). Today it cuts a new dated release tag, runs the resolver with `--force-rebuild` flags, runs all five test suites, publishes, and opens a bot PR bumping `binaries.lock`.

Under the new design, force-rebuild becomes a thin wrapper around the per-package matrix:

- **Trigger surface is unchanged.** Inputs (`packages`, `arches`, `ref`, `skip_tests`, `bump_lockfile`) keep the same meaning. `packages=all` fans out the full matrix; a comma-separated list narrows it.
- **Force-rebuild bypasses D3.** Selected packages skip the content-hash skip-check (§5.2) and rebuild from source unconditionally. Other packages — those *not* in the `packages` list — keep their D3 behaviour (skip if already published).
- **Same target release tag.** `binaries-abi-v<N>` (single, undated). New archives are uploaded alongside existing ones; identical bytes are no-ops, divergent bytes get new shas.
- **`index.toml` regenerated** from the post-matrix asset list, as in §5.3.
- **`bump_lockfile=true` (default) opens a per-package PR.** The bot generates a branch updating each rebuilt package's `package.toml` (`archive_url` + `archive_sha256`, possibly `[provenance]` if rebuild metadata changed) instead of bumping `binaries.lock`. Same `merge-gate` status posting; same auto-merge.
- **`bump_lockfile=false` is diagnostic-only** with cleaner semantics than today: archives upload and `index.toml` regenerates, but no `package.toml` changes. Consumers continue to use whatever URL their existing `package.toml` already points at; the freshly uploaded archive (if it has a new sha) sits in the release for inspection without affecting `main`.
- **Test-before-publish ordering preserved.** `install-release` is replaced by a per-package equivalent that fetches the freshly-built archives via the matrix's outputs, places `binaries/` symlinks, and runs the five test suites before the upload step. If any suite fails, no archives publish — same safety property as today.
- **Concurrency singleton preserved.** `force-rebuild` and `prepare-merge` continue to share the `prepare-merge-singleton` group. Two concurrent runs would race on `index.toml` upload; serializing them avoids the race.

The workflow file's restructure happens in Phase B (the new matrix infra) with the bot-PR shape switched in Phase C (when `package.toml` becomes the source of truth). See §8.

## §6. Resolver

### §6.1 Source of truth: per-package `package.toml` (β)

After Phase C, the resolver reads `examples/libs/<name>/package.toml` directly. No `binaries.lock`, no central manifest. For each package, the resolver:

1. Reads `package.toml`.
2. If `package.pr.toml` exists for that package, merges it over the base (field-by-field).
3. Verifies `kernel_abi` matches the host's current `ABI_VERSION`. Mismatch → hard error.
4. Resolves via the existing chain: `local-libs/` → cache → `archive_url` (HTTP fetch + sha verify) → source build.

### §6.2 Partial-publish semantics

Per the per-package matrix model, individual packages can be in a "build failed in this round" state without affecting others. The resolver behavior:

- **Last-green fallback.** When a package fails to rebuild in a given run, its `package.toml` simply continues to point at the last-green archive URL+sha from a prior successful publish. The resolver fetches that archive normally; consumers are unaffected.
- **Hard ABI-floor failure.** A separate concern: if no archive has *ever* been published for the current kernel ABI version (e.g. immediately after an ABI bump, before any package has been rebuilt), the resolver hard-fails. There is no silent fallback to the source build for ABI-mismatched archives — that would mask a real config error.
- **Failed rebuilds are surfaced loudly** via §6.3, not silently absorbed.

### §6.3 Failure surfacing (F1 + F2)

**F1 (free, from per-package matrix):** Each matrix job is its own GHA check. PR reviewers see per-package green/red in the PR check list. "Re-run failed jobs" works per-package.

**F2 (CI-generated status artifact):**

A post-matrix job emits `publish-status.json`:

```json
{
  "abi_version": 6,
  "release_tag": "pr-372-staging",
  "packages": [
    { "name": "bash",    "arch": "wasm32", "status": "built",       "sha": "abc..." },
    { "name": "mariadb", "arch": "wasm32", "status": "failed",      "previous_sha": "old...", "error_log_url": "..." },
    { "name": "vim",     "arch": "wasm32", "status": "cached-skip", "sha": "..." }
  ]
}
```

A bot renders this as a sticky PR comment table. The same JSON is attached to the merge commit (and persisted in the production release for history). A future `wasm-posix-pkg status` command consumes it for local lookups.

The status artifact is the single source of truth for "what happened in CI"; PR reviewers, the merger, and future debuggers all read the same data.

## §7. Trust model

- **Integrity root: `archive_sha256`** in the local `package.toml`. The resolver verifies every archive against this sha before extraction. A mirror returning different bytes fails verification.
- **Transport: HTTPS.** Manifest fetches and archive fetches are over HTTPS. This handles random-network-adversary tampering.
- **Initial trust on `sources add`: TOFU.** The first time a consumer adds a third-party source URL, they trust whatever bytes that URL returns. Signing would help here only if the publisher's key were known out-of-band; absent that, TOFU is the model.
- **Curated indexes pin integrity, not availability.** A curator's `archive_sha256` guarantees the bytes haven't changed. It does not guarantee the upstream still serves them. Curators using absolute URLs to upstream-controlled archives accept that responsibility.
- **Package signing is deferred.** See §10 and `docs/package-management-future-work.md`.

## §8. Migration plan

Three phases, each with a clear review boundary and rollback story.

### Phase A — Rename `deps.toml` → `package.toml`

Mechanical, pure rename. CI continues to use `binaries.lock`; behavior is unchanged.

- Rename every `examples/libs/*/deps.toml` → `package.toml`.
- Rename `xtask` symbols / functions / variables (`deps_*` → `pkg_*` where applicable). The in-flight `deps-cache-v2-f-capstone` branch's `3b5e18a75` commit does *symbol/doc* renames (sha domain `wasm-posix-deps.v2` → `wasm-posix-pkg`, doc titles); it does NOT rename `deps.toml` files. If that branch lands, it can rebase on top of Phase A; the conflict surface is small.
- Update CI scripts, docs, references.

One PR. Low risk; mostly find-and-replace. Implementation plan: `docs/plans/2026-05-05-decoupled-package-builds-phase-a-plan.md`.

### Phase A-bis — Optional schema fields

Adds the new fields described in §3.1. Pulled out from Phase A because Phase A intentionally shipped as a pure rename; this layer carries actual schema changes.

- **Parser update** (`xtask/src/pkg_manifest.rs`):
  - Rename `[build].script` → `[build].script_path` with new repo-relative semantics. Reject the old field name with a "use script_path" error to surface stale data.
  - Add `[build].repo_url` and `[build].commit` (both `Option<String>` initially; tightened to required for first-party in a follow-up).
  - Add top-level `kernel_abi: Option<u32>` (parsed but not yet enforced).
  - Make `[build]` required when the package isn't a `*-source` kind. Error wording calls out third-party packages can omit it but lose source-rebuild capability.
- **Resolver update** (`xtask/src/build_deps.rs`): when invoking the build script, resolve `script_path` against the repo root (not the package dir). Falls back to the existing `build-<name>.sh` convention only when `[build]` is absent (third-party rebuild — out of scope today, but the fallback keeps the resolver behaving sensibly if it ever happens).
- **Backfill all 61 first-party `package.toml` files:**
  - The 10 existing `[build].script = "build-<name>.sh"` entries → `[build].script_path = "examples/libs/<name>/build-<name>.sh"`.
  - The 51 packages without a `[build]` block → create one with the same repo-relative path.
  - Every package gets `[build].repo_url = "https://github.com/wasm-posix-kernel/wasm-posix-kernel.git"`.
  - `[build].commit` left empty/absent; CI fills on next publish.
- **CI update** (publish flow): when `force-rebuild.yml` or the per-package matrix uploads an archive, also update the package's `[build].commit` to the building commit (same patch that updates `[binary].archive_url` + `archive_sha256`). Same lifecycle, same pre-merge amend pattern.
- **Schema docs update**: `abi/manifest.schema.json` (the published-manifest schema) + `docs/package-management.md` (developer-facing).

One PR. Schema-shaped but mechanical: the parser changes + 61 file edits + a small CI patch. The fields are *additive* — nothing depends on `kernel_abi` being populated yet, and `[build].commit` empty-state is allowed.

### Phase B — New CI infrastructure (additive)

Stand up the per-package matrix, content-hash gating, per-file uploads, and `index.toml` generation **alongside** the existing flow. The resolver still reads `binaries.lock`; the new artifacts are published in parallel but unconsumed by `main`.

- Run reproducibility audit; fix any leaks (Homebrew vs. Nix LLVM, etc.) before relying on D3 gating.
- Implement per-package matrix workflow with `needs:` for *-source packages and toolchain cache.
- Implement D3 content-hash gating (pre-flight + matrix narrowing).
- Implement per-file uploads.
- Implement `index.toml` generation (post-matrix job).
- Implement F2 status artifact + sticky PR comment.
- Restructure `force-rebuild.yml` (§5.5) to drive the per-package matrix with selected packages bypassing D3. The bot PR step still bumps `binaries.lock` in this phase; switched to per-package `package.toml` updates in Phase C.
- Switch the durable release tag from dated (`binaries-abi-v<N>-YYYY-MM-DD[-<seq>]`) to undated (`binaries-abi-v<N>`). Archives published in this phase target the new undated tag; the resolver reads from `binaries.lock` which still pins the prior dated tag, so this is safely additive.
- Make `kernel_abi` field **required** in `package.toml` (CI validates).

One or two PRs depending on size. Additive — failures don't break existing flows. The new release artifacts are publishable but not yet consumed.

### Phase C — Resolver cutover

The smallest, highest-stakes phase. Single commit cutover with careful test coverage.

- Switch resolver to read `package.toml` directly; ignore `binaries.lock`.
- Switch PR overlay to `package.pr.toml`; gitignore added; `c2 pre-merge amend` updated.
- Switch `force-rebuild.yml`'s bot PR step to update individual `package.toml` files instead of `binaries.lock`.
- Remove `binaries.lock` from the repo.
- Remove the old monolithic publish-step code.
- Verify every demo (Node + browser hosts) and every test path (vitest, libc-test, sortix, POSIX, ABI snapshot) green.

One PR. Rollback = revert that commit; the Phase B infrastructure remains in place.

### Phase D (deferred)

- Fork-PR support (continues to use source-build fallback in interim).
- `wasm-posix-pkg` CLI commands for source management (`sources add`, `search`, `add`).
- `wasm-posix-fun-pack` repo bring-up (validates the third-party source flow against real consumers).

## §9. Risks & open questions

- **D3 reproducibility.** The reproducibility audit is the single most important Phase B prerequisite. If it fails for some packages, those packages must fall back to D2 (file-path detection) and the partial-publish guarantees weaken for them.
- **`c2 pre-merge amend` complexity.** Today's amend touches one file (`binaries.lock`); after Phase C it touches N `package.toml` files plus deletes any matching `package.pr.toml`. The amend logic needs explicit testing across "0 packages changed", "1 package changed", "N packages changed", and "package failed to build" scenarios.
- **`index.toml` consistency.** Generated post-matrix; must atomically reflect either "all matrix entries' state at end-of-run" or be regenerated on every change. A partial `index.toml` upload (matrix-entry succeeds but `index.toml` upload fails) is an inconsistency window. Mitigation: upload `index.toml` last; on resolver fetch, prefer `index.toml`'s sha but verify against `archive_sha256` either way (sha is the integrity root, not the manifest).
- **Resolver behavior when `package.toml` and `package.pr.toml` disagree on `kernel_abi`.** Should never happen (overlay only contains URL+sha), but the merge logic needs a guardrail.

## §10. Future work

Listed in `docs/package-management-future-work.md`:

- Package signing (cryptographic authenticity for manifests and archives).
- Auto-update flow (resolver checks for newer versions against source manifests).
- Garbage collection of stale archives.
- `kernel_abi` range/set declaration (only relevant if a stable user-facing sub-ABI is introduced).
- Fork-PR staging builds.
- `wasm-posix-pkg` source-management CLI commands.
