# Wasm Dependency Management V2 — Chunk F (capstone — first release cut)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` if running
> in a separate session, otherwise drive sequentially in the current session.
> Several steps are long-running (stage-release builds the entire registry ×
> {wasm32, wasm64} from a cold cache; expect 30–90 minutes).

**Goal:** Cut the first V2 binary release (`binaries-abi-v1`) for wasm32
+ wasm64, backfill `[binary]` blocks into in-tree consumer `deps.toml`s,
update binaries.lock, and verify the full producer→publish→consumer
loop works end-to-end against the live GitHub release.

**Architecture:** Three phases.

  1. **Replace.** Delete the legacy v1-vintage release at the
     `binaries-abi-v1` tag (49 plain `.wasm` assets cut on 2026-04-20).
     Cut a new release with the V2 `.tar.zst` archive layout via
     `scripts/stage-release.sh` + `scripts/publish-release.sh`. The
     `ABI_VERSION` is currently `1`; no kernel ABI bump is needed
     because Chunk E was host-side tooling only.

  2. **Wire.** Backfill `[binary] { archive_url, archive_sha256 }`
     blocks into every in-tree `examples/libs/<name>/deps.toml` that
     has a corresponding entry in the published manifest. Update
     `binaries.lock` with the new manifest sha so
     `scripts/fetch-binaries.sh` works against the published release.

  3. **Verify.** With the cache cleared, prove the loop:
     `cargo xtask build-deps resolve <lib>` hits the remote-fetch path
     (decision 14 chain — sha + target_arch + abi_versions +
     cache_key_sha verified) and installs the cached artifact without
     running the build script. Document the deferred future work
     (`docs/dependency-management-future-work.md`); update README +
     `docs/architecture.md` cross-references.

**Tech Stack:** bash (release scripts), gh CLI (release upload),
Rust + xtask (resolver), TOML (manifest editing), GitHub Releases
(asset hosting).

**Design reference:**
`docs/plans/2026-04-22-deps-management-v2-design.md` — sections "Resolver
behaviour", "Release tooling", "First release cut".

**Implementation predecessor:** Chunk E (PR #361, branch
`deps-cache-v2-e-release-tooling`) which shipped `xtask::stage_release`,
`xtask::install_release`, `xtask::archive_stage`, the schema extension,
and the round-trip vitest test.

**Stack base:** `deps-cache-v2-e-release-tooling` @ `0e0dc8b69` (PR #361).

**Branch:** `deps-cache-v2-f-capstone`.

**Final PR base:** `deps-cache-v2-e-release-tooling`. Do NOT merge —
user is holding all V2 PRs until V2 is fully done. Chunk F closes V2.

---

## Acceptance criteria

- The `binaries-abi-v1` GitHub release is replaced with V2-shape
  assets: a flat `manifest.json` plus `<name>-<v>-rev<N>-<arch>-<sha>.tar.zst`
  archives for libraries (wasm32 + wasm64) and programs (mostly
  wasm32; wasm64 partial).
- Every staged archive's embedded `[compatibility]` block is honored
  by `xtask install-release` end-to-end against the live release.
- Every in-tree `examples/libs/<name>/deps.toml` whose name appears in
  the published `manifest.json` carries a `[binary]` block with the
  correct `archive_url` (pointing at the `binaries-abi-v1` release)
  and `archive_sha256`.
- `binaries.lock`'s `manifest_sha256` matches the published manifest.
  `scripts/fetch-binaries.sh` succeeds against the live release.
- A clean-cache run of `cargo xtask build-deps resolve <lib>` for at
  least one library and one program completes via remote-fetch (no
  build script invoked — verified with a sentinel pattern matching
  the round-trip test).
- `docs/dependency-management-future-work.md` exists and captures the
  deferred items from the design doc.
- README + `docs/architecture.md` cross-references point at V2 docs.
- All 6 gates green; ABI snapshot in sync.

---

## Caveats

- **Long-running stage step.** `scripts/stage-release.sh` builds every
  registered lib + program × {wasm32, wasm64}. From a cold cache this
  is ~30–90 minutes on a workstation. Most wasm64 program builds will
  fail (programs are wasm32-only at present); `--continue-on-error`
  catches these. Acceptance criterion is "wasm32 archives for
  everything that builds; wasm64 partial."
- **Replace, don't append, the existing release.** The legacy
  `binaries-abi-v1` cut on 2026-04-20 has 49 plain `.wasm` assets
  (V1-vintage). Delete that release (and tag) before publishing V2 to
  avoid asset collisions.
- **xtask requires `--target aarch64-apple-darwin`.** Documented in
  `xtask/README.md`.
- **Pre-existing dirty `examples/libs/{...}-src/*` files.** These are
  build trees, not source modifications. NEVER `git add` them.
- **Build-host string for `[compatibility].build_host`.** We use
  `darwin-aarch64` (or whatever `<os>-<arch>` returns from
  `std::env::consts`) for archives produced on this machine. This is
  informational only — consumers don't dispatch on it.
- **Build timestamp.** Set explicitly via `--build-timestamp <iso>` to
  the moment the staging starts, so re-runs against the same staging
  dir are idempotent (the embedded compat block doesn't drift).
- **Programs that need `local-binaries/` mirroring at fetch time.**
  Multi-output programs (git, php, mariadb, redis, diffutils,
  findutils) install their wasms into
  `local-binaries/programs/<program>/<output>.wasm`. Single-output
  programs install at `local-binaries/programs/<output>.wasm`. The
  consumer-side mirror logic landed in E.5; F just exercises it.

---

## How to execute

This plan runs sequentially in one session. Several steps need user
authorization (deleting the GitHub release, publishing the new one) —
the user has pre-authorized for this execution.

Each step below is small enough to commit independently. Don't batch
commits; one commit per logical change so the plan-doc commit stack
mirrors the task ordering.

---

## Plan of record

### Task F.1: Branch + plan-doc commit (THIS DOCUMENT)

**Files:**
- Create: `docs/plans/2026-04-27-deps-management-v2-chunk-f.md`
- Branch: `deps-cache-v2-f-capstone` off `deps-cache-v2-e-release-tooling` @ `0e0dc8b69`

**Steps:**

1. `git checkout -b deps-cache-v2-f-capstone deps-cache-v2-e-release-tooling`
2. Write this plan doc.
3. Commit: `docs: deps-management V2 chunk F implementation plan`

---

### Task F.2: Delete the legacy `binaries-abi-v1` release

The user authorized: "It can completely replace the current release we
created early on in this worktree. In fact, let's delete the early
release to avoid confusion."

**Steps:**

1. Confirm only one release exists at that tag:
   ```
   gh release view binaries-abi-v1 --json tagName,publishedAt,assets --jq '{tagName, publishedAt, asset_count: (.assets|length)}'
   ```
2. Delete the release AND the tag (so the tag can be reused by the
   new publish-release.sh):
   ```
   gh release delete binaries-abi-v1 --cleanup-tag --yes
   ```
3. Confirm gone:
   ```
   gh release view binaries-abi-v1 2>&1 | head -3   # expect "release not found"
   ```

No commit — this is a remote-state change, not a repo change.

---

### Task F.3: Stage the release locally

**Long-running.** Cold-cache staging across both arches will take
~30–90 minutes. Use `--continue-on-error` so wasm64 program failures
don't abort the staging.

**Steps:**

1. Pick a staging dir. Use `/tmp` so it doesn't pollute the worktree:
   ```
   STAGING=/tmp/wpk-release-2026-04-27
   rm -rf "$STAGING"
   ```
2. Run staging:
   ```
   bash scripts/stage-release.sh --out "$STAGING" --abi 1 \
     2>&1 | tee /tmp/wpk-stage-2026-04-27.log
   ```
   (The script reads ABI from `crates/shared/src/lib.rs` if `--abi`
   is omitted; we pass `--abi 1` explicitly to be safe.)

3. Inspect output:
   ```
   ls "$STAGING"/                    # V1 entries (kernel.wasm, etc.) at root
   ls "$STAGING"/libs/ | wc -l       # expect 14 = 7 libs × 2 arches
   ls "$STAGING"/programs/ | wc -l   # mostly wasm32; some wasm64
   wc -c < "$STAGING/manifest.json"
   jq '.entries | length' "$STAGING/manifest.json"
   ```
4. Inspect failures:
   ```
   grep -E 'WARN .* (wasm32|wasm64): ' /tmp/wpk-stage-2026-04-27.log
   ```
   Expected: many wasm64 program failures, ~zero wasm32 failures.
   Per-manifest total-failure (every requested arch failed) is fatal
   only without `--continue-on-error` — we use the flag, so partial
   coverage is acceptable.

No commit yet (the staging dir lives in `/tmp`, not the repo).

---

### Task F.4: Round-trip verify the staging dir locally

Before publishing to GitHub, confirm the staging dir's archives can be
installed against by `xtask install-release` and that a subsequent
`build-deps resolve` cache-hits without rebuilding. This mirrors the
host vitest test pattern (`host/test/release-roundtrip.test.ts`) but
against the real registry.

**Steps:**

1. Pick an isolated cache + local-binaries:
   ```
   ROUNDTRIP_CACHE=/tmp/wpk-rt-cache-2026-04-27
   ROUNDTRIP_LOCALBIN=/tmp/wpk-rt-localbin-2026-04-27
   rm -rf "$ROUNDTRIP_CACHE" "$ROUNDTRIP_LOCALBIN"
   ```
2. Install:
   ```
   cargo run -p xtask --target aarch64-apple-darwin --quiet -- \
     install-release \
       --manifest "$STAGING/manifest.json" \
       --archive-base "file://$STAGING" \
       --cache-root "$ROUNDTRIP_CACHE/wasm-posix-kernel" \
       --local-binaries-dir "$ROUNDTRIP_LOCALBIN" \
       --abi 1
   ```
3. Spot-check a few canonical paths exist:
   ```
   ls "$ROUNDTRIP_CACHE"/wasm-posix-kernel/libs/zlib-* | head
   ls "$ROUNDTRIP_LOCALBIN"/programs/dash.wasm
   ```
4. Resolve test (cache-hit, no rebuild):
   ```
   XDG_CACHE_HOME="$ROUNDTRIP_CACHE" \
   cargo run -p xtask --target aarch64-apple-darwin --quiet -- \
     build-deps resolve zlib --arch wasm32
   # expect path under $ROUNDTRIP_CACHE/wasm-posix-kernel/libs/
   ```

If any step fails: don't proceed to publish. Diagnose and fix the
producer (xtask::archive_stage / stage_release) or consumer
(xtask::install_release) bug, return to F.3.

No commit.

---

### Task F.5: Publish to GitHub

**Steps:**

1. Dry-run first to confirm the asset list:
   ```
   DRY_RUN=1 bash scripts/publish-release.sh \
     --tag binaries-abi-v1 --staging "$STAGING"
   ```
   Expected: prints all assets with sizes; exits before
   `gh release create`.

2. Real publish:
   ```
   bash scripts/publish-release.sh \
     --tag binaries-abi-v1 --staging "$STAGING"
   ```

3. Confirm:
   ```
   gh release view binaries-abi-v1 --json tagName,assets \
     --jq '{tagName, asset_count: (.assets|length)}'
   ```
   Expected: tagName matches, asset_count matches the local staging.

No commit yet (the publish is a remote-state change).

---

### Task F.6: Update `binaries.lock`

The lock file pins the manifest sha so consumers cloning the repo
fetch the right version. Compute the new sha and write it.

**Steps:**

1. Compute manifest sha:
   ```
   MANIFEST_SHA=$(shasum -a 256 "$STAGING/manifest.json" | awk '{print $1}')
   ```
2. Update `binaries.lock`:
   ```json
   {
     "abi_version": 1,
     "release_tag": "binaries-abi-v1",
     "manifest_sha256": "<new sha>"
   }
   ```
3. `git add binaries.lock`
4. Commit (will commit alongside F.7 which is the same logical
   change): hold for now.

---

### Task F.7: Backfill `[binary]` blocks in consumer deps.toml

For every entry in the published `manifest.json` that has an
`archive_name`, write a `[binary]` block to its source `deps.toml`
with:

```toml
[binary]
archive_url = "https://github.com/brandonpayton/wasm-posix-kernel/releases/download/binaries-abi-v1/<archive_name>"
archive_sha256 = "<archive_sha256>"
```

Important detail: the cache-key sha (and therefore archive name)
depends on `target_arch`. So `zlib` has separate archives for wasm32
and wasm64 but ONE `deps.toml`. The `[binary]` block points at one
archive — by convention the wasm32 one (since that's what the local
default is). The wasm64 archive's URL is implied by parallel naming
and doesn't need to be encoded — `xtask install-release` constructs
URLs from the release manifest, not from `[binary]`. The consumer
resolver path's `[binary]` block is for `xtask build-deps resolve`,
which always operates on a single `--arch`.

Wait — that's a real gap. Let me think this through.

`Binary` struct has only `archive_url` + `archive_sha256` (one URL).
For a `--arch wasm64` resolve, the resolver needs a wasm64 archive
URL. But the `[binary]` block can carry only one URL.

Two options:
1. **Make `[binary]` block per-arch keyed**, e.g.
   ```toml
   [binary.wasm32]
   archive_url = "..."
   archive_sha256 = "..."
   [binary.wasm64]
   archive_url = "..."
   archive_sha256 = "..."
   ```
   Schema change. Resolver looks up the per-arch entry.

2. **Construct the URL at resolve time** by templating: store
   `archive_url_template = "https://.../<name>-<v>-rev<N>-{arch}-{sha}.tar.zst"`
   plus a per-arch sha map.

3. **Defer multi-arch [binary] support to Chunk G** (if/when wasm64
   programs are ready). For F: only fill in wasm32 in `[binary]`. A
   `--arch wasm64` resolve falls through to source build (existing V2
   behavior — `[binary]` is optional). This is a **minimal first cut**
   and matches the design doc's "decision 6: Each arch is independently
   buildable, releaseable, and fetchable. Build failures of one arch
   don't block the other from shipping."

I recommend option 3 (defer). Rationale:
  - Wasm64 programs aren't a priority right now (kernel is wasm64,
    user programs are wasm32).
  - The `[binary]` block was always envisioned as the wasm32 default;
    the schema doc never required multi-arch.
  - Schema change for option 1 is backwards-incompatible work that
    belongs in a future chunk.

**Steps:**

1. Use a small bash/jq script to drive the backfill:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   STAGING="${STAGING:-/tmp/wpk-release-2026-04-27}"
   REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
   TAG="binaries-abi-v1"
   BASE="https://github.com/brandonpayton/wasm-posix-kernel/releases/download/$TAG"

   jq -r '.entries[] | select(.archive_name != null and .arch == "wasm32") |
     [.program, .archive_name, .archive_sha256] | @tsv' \
     "$STAGING/manifest.json" |
   while IFS=$'\t' read -r program archive_name archive_sha; do
       deps_toml="$REPO_ROOT/examples/libs/$program/deps.toml"
       if [ ! -f "$deps_toml" ]; then
           echo "skip $program (no deps.toml at $deps_toml)"
           continue
       fi
       # Idempotent: replace any existing [binary] block, else append.
       # Use python for robust TOML editing.
       python3 - "$deps_toml" "$BASE/$archive_name" "$archive_sha" <<'PY'
   import sys, re, pathlib
   path = pathlib.Path(sys.argv[1])
   url, sha = sys.argv[2], sys.argv[3]
   text = path.read_text()
   block = f'\n[binary]\narchive_url = "{url}"\narchive_sha256 = "{sha}"\n'
   # Strip existing [binary]...next-section.
   stripped = re.sub(r'\n\[binary\][^\[]*', '\n', text, flags=re.S)
   # Append fresh.
   stripped = stripped.rstrip() + block
   path.write_text(stripped)
   PY
       echo "wrote [binary] for $program"
   done
   ```
2. Save as `scripts/backfill-binary-blocks.sh`, make executable, run.
3. Spot-check one or two: `cat examples/libs/zlib/deps.toml` should
   end with the new `[binary]` block.
4. Commit alongside `binaries.lock` from F.6:
   ```
   git add examples/libs/*/deps.toml binaries.lock scripts/backfill-binary-blocks.sh
   git commit -m "feat(deps): wire [binary] blocks to binaries-abi-v1 release + lock manifest sha"
   ```

---

### Task F.8: Verify remote-fetch end-to-end against the live release

Now that the release is live AND the `[binary]` blocks point at it,
prove a clean-cache resolve goes through the remote-fetch path.

**Steps:**

1. Pick an isolated cache and clear it:
   ```
   VERIFY_CACHE=/tmp/wpk-verify-cache-$(date +%s)
   rm -rf "$VERIFY_CACHE"
   ```
2. Resolve a lib with a sentinel:
   ```
   SENTINEL_DIR=/tmp/wpk-verify-sentinel-$(date +%s)
   rm -rf "$SENTINEL_DIR"; mkdir -p "$SENTINEL_DIR"

   XDG_CACHE_HOME="$VERIFY_CACHE" \
   WASM_POSIX_LOCAL_SENTINEL_DIR="$SENTINEL_DIR" \
   cargo run -p xtask --target aarch64-apple-darwin --quiet -- \
     build-deps resolve zlib --arch wasm32

   # If the build script ran, $SENTINEL_DIR would have files.
   # Expected: 0 files in $SENTINEL_DIR (cache hit via remote-fetch).
   ls "$SENTINEL_DIR" | wc -l   # expect 0
   ```
   Note: this requires the zlib build script to write to
   `$WASM_POSIX_LOCAL_SENTINEL_DIR` when set — a hand-edit to
   `examples/libs/zlib/build-zlib.sh` to match the round-trip test
   pattern. Skip if the build script doesn't already support this
   (the assertion would then be: `cargo run` completes in <30s, which
   is too fast to have rebuilt zlib from source).

3. Resolve a program too:
   ```
   XDG_CACHE_HOME="$VERIFY_CACHE" \
   cargo run -p xtask --target aarch64-apple-darwin --quiet -- \
     build-deps resolve dash --arch wasm32
   ```

If either fails, the most likely cause is a `cache_key_sha` mismatch
between the producer (stage-release) and the consumer (`compute_sha`
at resolve time). Re-stage and re-publish.

No commit — this is a verification step.

---

### Task F.9: Documentation finalization

**Files:**
- Create: `docs/dependency-management-future-work.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Steps:**

1. Create `docs/dependency-management-future-work.md` with the
   "Future work" items from the design doc:
   - WASI artifact caching
   - Sibling source archive (GPL-modified software)
   - Semver range resolution
   - Compound version constraints for host-tools
   - Auto-install of host tools
   - Per-platform tool name aliases
   - CI-driven dep builds
   - Lint: hard-coded version strings in build scripts
   - `--format=json` for `build-deps env`
   - `--gc` cron-style cache clean
   - Multi-arch fat archives
   - **Multi-arch `[binary]` blocks** (new, surfaced by F.7 above)

2. README updates:
   - Find the "Build" or "Dependencies" section.
   - Reference `docs/dependency-management.md` for the V2 dep system.
   - Note that `scripts/fetch-binaries.sh` pulls pre-built archives
     from the `binaries-abi-v1` release and places them in
     `local-binaries/programs/`.

3. `docs/architecture.md` updates:
   - Find any reference to `abi/program-metadata.toml` (deleted in B)
     or the V1 cache layout. Update to V2 per-dir manifests under
     `examples/libs/<name>/deps.toml`.

4. Commit:
   ```
   git add docs/dependency-management-future-work.md README.md docs/architecture.md
   git commit -m "docs: V2 capstone — future-work doc + README + architecture cross-refs"
   ```

---

### Task F.10: Gauntlet + open Chunk F PR

**Steps:**

1. Run all 6 gates:
   - `cargo test -p xtask --target aarch64-apple-darwin --bin xtask`
   - `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
   - `cd host && npx vitest run`
   - `scripts/run-libc-tests.sh`
   - `scripts/run-posix-tests.sh`
   - `scripts/run-sortix-tests.sh --all`
   - `bash scripts/check-abi-version.sh`

2. Push branch and open PR:
   ```
   git push -u origin deps-cache-v2-f-capstone
   gh pr create --base deps-cache-v2-e-release-tooling \
     --title "deps V2 chunk F: capstone — first release cut + binary backfill + final docs" \
     --body "..."
   ```

3. **Do NOT merge.** User holds the entire V2 stack (PRs #341, #347,
   #348, #352–#360, #361, #362) until ready to merge as a unit.

4. Update `memory/project_dependency_management.md` to reflect Chunk
   F shipped + V2 complete.

---

## Plan complete

Plan is sequential — each task feeds the next. Estimated wall time:

  - F.1: 5 minutes (this doc + commit).
  - F.2: 1 minute.
  - F.3: **30–90 minutes** (long-running build).
  - F.4: 1–2 minutes.
  - F.5: 1–2 minutes (depends on upload speed; total release size
    likely ~50–200 MB).
  - F.6+F.7: 5 minutes (script + commit).
  - F.8: 1–2 minutes per resolve.
  - F.9: 15–30 minutes (docs editing).
  - F.10: 30–60 minutes (sortix is the long pole).

**Total: ~2–3 hours.**

Most of the wall time is in F.3 (cold-cache build) and F.10 (sortix).
Both can run while user attends to other things.
