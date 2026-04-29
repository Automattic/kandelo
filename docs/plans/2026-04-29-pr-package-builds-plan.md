# PR Package Builds Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace today's manual two-PR release flow with a single-PR workflow where CI builds per-PR staging archives, reviewers consume them via a gitignored overlay, and a `ready-to-ship`-labeled PR is auto-merged with its lockfile bump in the same squash commit.

**Architecture:** Per-PR `pr-<NNN>-staging` GitHub pre-release for review, gitignored `binaries.lock.pr` overlay merged at fetch time by `scripts/fetch-binaries.sh`, three GitHub Actions workflows (`staging-build.yml`, `prepare-merge.yml`, `staging-cleanup.yml`), and a new `xtask stage-pr-overlay` subcommand that produces only changed archives + the overlay file.

**Tech Stack:** GitHub Actions, bash 3.x compatible (script must run on macOS contributors), Rust (xtask), `gh` CLI, `jq`, the existing content-addressed package management system (PR #365).

**Design doc:** `docs/plans/2026-04-29-pr-package-builds-design.md` — read first if any task feels under-specified.

---

## Pre-implementation checklist

Before starting Task 1, verify state:

```
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/package-management-for-pr-workflows
git status              # should be on package-management-for-pr-workflows branch
git log --oneline -3    # tip should be c28092a5d (design doc commit)
```

Run baseline tests so regressions are visible later:

```
bash scripts/check-abi-version.sh       # expect: exit 0
cargo test -p xtask --target aarch64-apple-darwin --quiet
```

(Skipping the full kernel test suite — this work doesn't touch the kernel.)

---

## Task 1: gitignore overlay file + fetch-binaries reads it from disk

**Goal:** When `binaries.lock.pr` exists in the repo root, `scripts/fetch-binaries.sh` consumes it as an overlay over `binaries.lock`, fetching listed packages from a different release tag than the durable pin.

**Files:**
- Modify: `.gitignore` — add `binaries.lock.pr` line
- Modify: `scripts/fetch-binaries.sh` — overlay parse + dual-source archive install
- Create: `scripts/test-fetch-binaries-overlay.sh` — fixture-driven test
- Modify: `docs/binary-releases.md` — short paragraph describing overlay behaviour (one paragraph; full doc updates land in Task 8)

### Step 1: Add the gitignore line

Add this line after the `/binaries/` entry in `.gitignore`:

```
# PR-build overlay file. Created by scripts/fetch-binaries.sh when
# checked out on a PR branch with a corresponding pr-<NNN>-staging
# pre-release. Never committed; see docs/binary-releases.md.
binaries.lock.pr
```

Verify:

```
touch binaries.lock.pr
git status --short binaries.lock.pr   # expect no output (ignored)
rm binaries.lock.pr
```

### Step 2: Write the fixture-driven test (failing)

Create `scripts/test-fetch-binaries-overlay.sh` that:

1. Creates a temp dir with stub `binaries.lock` + `binaries.lock.pr` files referencing fixture release tags.
2. Mocks the network using a `curl` shim on `PATH` that serves files from a local fixture dir.
3. Runs `scripts/fetch-binaries.sh` against it.
4. Asserts that override entries were fetched from the staging URL and non-override entries from the durable URL.

Use a minimal manifest fixture (1 override entry, 1 pass-through entry). Keep the fixture archive contents trivial (e.g. a `.tar.zst` containing a single 5-byte file).

Run it: `bash scripts/test-fetch-binaries-overlay.sh`. Expect failure — overlay logic doesn't exist yet.

### Step 3: Implement overlay parsing + dual-source install

In `scripts/fetch-binaries.sh`, after the `LOCK_MANIFEST_SHA=` line (~line 64) and before `REL_BASE=` (~line 66), add:

```bash
# --- Optional overlay (PR staging) -----------------------------------------
OVERLAY_FILE="$REPO_ROOT/binaries.lock.pr"
OVERLAY_TAG=""
OVERLAY_MANIFEST_SHA=""
OVERLAY_OVERRIDES_JSON="[]"
if [ -f "$OVERLAY_FILE" ]; then
    OVERLAY_TAG=$(jq -r .staging_tag "$OVERLAY_FILE")
    OVERLAY_MANIFEST_SHA=$(jq -r .staging_manifest_sha256 "$OVERLAY_FILE")
    OVERLAY_OVERRIDES_JSON=$(jq -c .overrides "$OVERLAY_FILE")
    [ "$OVERLAY_TAG" = "null" ] && { echo "ERROR: overlay missing staging_tag" >&2; exit 1; }
    [ "$OVERLAY_MANIFEST_SHA" = "null" ] && { echo "ERROR: overlay missing staging_manifest_sha256" >&2; exit 1; }
    echo "fetch-binaries: overlay tag=$OVERLAY_TAG ($(echo "$OVERLAY_OVERRIDES_JSON" | jq 'length') overrides)"
fi
```

After `REL_BASE=` is computed, add a parallel staging URL:

```bash
OVERLAY_REL_BASE=""
if [ -n "$OVERLAY_TAG" ]; then
    OVERLAY_REL_BASE="https://github.com/brandonpayton/wasm-posix-kernel/releases/download/$OVERLAY_TAG"
fi
```

In Step 1 (manifest fetch) the durable manifest path is unchanged. After it, if the overlay is set, fetch and verify the staging manifest:

```bash
if [ -n "$OVERLAY_TAG" ]; then
    OVERLAY_MANIFEST_OBJ="$OBJ_DIR/$OVERLAY_MANIFEST_SHA.json"
    # Temporarily swap REL_BASE so ensure_object can reuse its existing logic.
    REL_BASE_SAVE="$REL_BASE"; REL_BASE="$OVERLAY_REL_BASE"
    ensure_object "manifest.json" "$OVERLAY_MANIFEST_SHA"
    REL_BASE="$REL_BASE_SAVE"
    # Sanity: overlay manifest's abi_version matches.
    overlay_abi=$(jq -r .abi_version "$OVERLAY_MANIFEST_OBJ")
    if [ "$overlay_abi" != "$LOCK_ABI" ]; then
        echo "ERROR: overlay manifest abi=$overlay_abi != lock abi=$LOCK_ABI" >&2
        exit 1
    fi
fi
```

In Step 1.5 (the `xtask install-release` block, ~lines 210-221), split the call so override entries come from the staging release:

```bash
if jq -e '.entries[] | select(.archive_name != null)' "$MANIFEST_OBJ" > /dev/null 2>&1; then
    if [ "$OFFLINE" = "1" ]; then
        echo "fetch-binaries: skipping archive install (offline mode)"
    else
        HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"

        # Compute filtered manifests:
        #   durable_filtered = entries from durable manifest whose .name is NOT in overrides
        #   overlay_filtered = entries from overlay manifest whose .name IS in overrides
        # The two are installed against different archive bases.
        DURABLE_MANIFEST="$MANIFEST_OBJ"
        if [ -n "$OVERLAY_TAG" ]; then
            DURABLE_FILTERED=$(mktemp -t fetch-binaries-durable.XXXXXX).json
            jq --argjson overrides "$OVERLAY_OVERRIDES_JSON" '
                .entries |= map(select(.name as $n | $overrides | index($n) | not))
            ' "$MANIFEST_OBJ" > "$DURABLE_FILTERED"
            DURABLE_MANIFEST="$DURABLE_FILTERED"
        fi

        echo "fetch-binaries: installing archives via xtask install-release..."
        cargo run -p xtask --target "$HOST_TARGET" --quiet -- install-release \
            --manifest "$DURABLE_MANIFEST" \
            --archive-base "$REL_BASE" \
            --binaries-dir "$BIN_DIR"

        if [ -n "$OVERLAY_TAG" ]; then
            OVERLAY_FILTERED=$(mktemp -t fetch-binaries-overlay.XXXXXX).json
            jq --argjson overrides "$OVERLAY_OVERRIDES_JSON" '
                .entries |= map(select(.name as $n | $overrides | index($n)))
            ' "$OVERLAY_MANIFEST_OBJ" > "$OVERLAY_FILTERED"
            echo "fetch-binaries: installing overlay archives from $OVERLAY_TAG..."
            cargo run -p xtask --target "$HOST_TARGET" --quiet -- install-release \
                --manifest "$OVERLAY_FILTERED" \
                --archive-base "$OVERLAY_REL_BASE" \
                --binaries-dir "$BIN_DIR"
            rm -f "$DURABLE_FILTERED" "$OVERLAY_FILTERED"
        fi
    fi
fi
```

The Step 2 loop (legacy non-archive entries) doesn't need changes — none of the override-eligible packages today use the legacy path.

### Step 4: Run the fixture test, verify it passes

```
bash scripts/test-fetch-binaries-overlay.sh
```

Expect: PASS, with stdout showing "installing archives via xtask install-release" once and "installing overlay archives from <tag>" once.

### Step 5: Smoke test against the real durable release (no overlay path)

With no `binaries.lock.pr` present:

```
rm -rf binaries/
bash scripts/fetch-binaries.sh
ls binaries/programs/ | head -5     # expect: existing programs (dash, bash, etc.)
```

Confirms backwards compatibility — no overlay → byte-identical behaviour.

### Step 6: Add a one-paragraph note to docs/binary-releases.md

Find the section discussing `binaries.lock` (search for `binaries.lock`). After the existing description of the lockfile, insert:

```
### PR-staging overlay (`binaries.lock.pr`)

When a PR's CI publishes per-PR archives to `pr-<NNN>-staging`, it also
uploads a `binaries.lock.pr` overlay listing which packages were rebuilt.
`scripts/fetch-binaries.sh` reads this file (gitignored, never committed)
and merges it over `binaries.lock`: override entries are fetched from the
staging release, the rest from the durable release. The overlay schema is
`{ staging_tag, staging_manifest_sha256, overrides }`. See
`docs/plans/2026-04-29-pr-package-builds-design.md` §3 for full schema.
```

### Step 7: Commit

```
git add .gitignore scripts/fetch-binaries.sh scripts/test-fetch-binaries-overlay.sh docs/binary-releases.md
git commit -m "feat(fetch-binaries): support binaries.lock.pr overlay

When a binaries.lock.pr file is present, fetch-binaries.sh splits archive
installation into two passes: durable-release entries minus overrides, and
staging-release entries for overrides only. The overlay file lists the
staging tag, its manifest sha256, and which entries to override by package
name. Foundation for the per-PR staging release flow described in
docs/plans/2026-04-29-pr-package-builds-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Auto-detect PR + download overlay file

**Goal:** A reviewer running `scripts/fetch-binaries.sh` on a checked-out PR branch automatically downloads `binaries.lock.pr` from the corresponding `pr-<NNN>-staging` release. No flags or env vars required for the common case; `--pr <N>` is the explicit override.

**Files:**
- Modify: `scripts/fetch-binaries.sh`

### Step 1: Write the failing test

Extend `scripts/test-fetch-binaries-overlay.sh` with a second scenario:

1. No `binaries.lock.pr` on disk.
2. Git remote configured to a fake `OWNER/REPO`.
3. `curl` shim returns a fixture JSON listing one PR for the current HEAD sha.
4. `curl` shim serves a fixture `binaries.lock.pr` from the staging release URL.
5. Assert: after running fetch-binaries, the fixture overlay's overrides were applied.

Run it; expect FAIL (auto-detect doesn't exist).

### Step 2: Implement the `--pr <N>` flag

In the arg-parsing loop in `scripts/fetch-binaries.sh` (~line 37), add:

```bash
        --pr) PR_NUMBER="$2"; shift 2 ;;
```

And initialize `PR_NUMBER=""` at the top of the script.

### Step 3: Implement PR auto-detect

After the existing prerequisite check (~line 56) and before reading `binaries.lock`, add:

```bash
# --- PR auto-detect (only if no overlay file already present) -------------
auto_detect_pr() {
    # Returns PR number on stdout, empty if not found.
    local origin head_sha owner repo url pulls_json pr_num
    origin=$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null) || return 0
    head_sha=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null) || return 0
    # Parse owner/repo from common origin URL formats.
    case "$origin" in
        git@github.com:*)        owner_repo="${origin#git@github.com:}";   owner_repo="${owner_repo%.git}" ;;
        https://github.com/*)    owner_repo="${origin#https://github.com/}"; owner_repo="${owner_repo%.git}" ;;
        *) return 0 ;;
    esac
    owner="${owner_repo%%/*}"
    repo="${owner_repo#*/}"
    [ -z "$owner" ] || [ -z "$repo" ] && return 0

    # Prefer gh if installed + authed (higher rate limit, nicer errors).
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
        pulls_json=$(gh api "repos/$owner/$repo/commits/$head_sha/pulls" 2>/dev/null) || return 0
    else
        pulls_json=$(curl -fsSL \
            -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/$owner/$repo/commits/$head_sha/pulls" 2>/dev/null) || return 0
    fi
    # Pick the first OPEN PR (most likely the relevant one).
    pr_num=$(echo "$pulls_json" | jq -r '[.[] | select(.state=="open")][0].number // empty')
    echo "$pr_num"
}

if [ -z "$PR_NUMBER" ] && [ ! -f "$OVERLAY_FILE_TARGET" ]; then
    PR_NUMBER=$(auto_detect_pr)
    [ -n "$PR_NUMBER" ] && echo "fetch-binaries: detected PR #$PR_NUMBER"
fi
```

(Define `OVERLAY_FILE_TARGET="$REPO_ROOT/binaries.lock.pr"` near the top of the script alongside the existing path constants.)

### Step 4: Implement overlay download from staging release

After auto-detect, before the existing overlay-file-on-disk read:

```bash
if [ -n "$PR_NUMBER" ] && [ ! -f "$OVERLAY_FILE_TARGET" ]; then
    STAGING_TAG_GUESS="pr-${PR_NUMBER}-staging"
    STAGING_BASE="https://github.com/$owner_repo/releases/download/$STAGING_TAG_GUESS"
    echo "fetch-binaries: downloading overlay from $STAGING_TAG_GUESS..."
    if curl -fsSL --retry 2 -o "$OVERLAY_FILE_TARGET.partial" "$STAGING_BASE/binaries.lock.pr"; then
        mv "$OVERLAY_FILE_TARGET.partial" "$OVERLAY_FILE_TARGET"
    else
        rm -f "$OVERLAY_FILE_TARGET.partial"
        echo "fetch-binaries: no overlay at $STAGING_TAG_GUESS (PR may not have a staging release yet); falling back to durable release"
    fi
fi
```

(Stash `owner_repo` as a script-level variable in the auto-detect function so it's available here.)

The existing overlay-file read (Task 1) then proceeds normally.

### Step 5: Run both fixture tests; verify they pass

```
bash scripts/test-fetch-binaries-overlay.sh
```

Expect: both scenarios PASS.

### Step 6: Update the script's `-h` / docstring

Add `--pr <N>` to the flags section at the top of `scripts/fetch-binaries.sh` and document auto-detect behaviour in 1-2 lines.

### Step 7: Commit

```
git add scripts/fetch-binaries.sh scripts/test-fetch-binaries-overlay.sh
git commit -m "feat(fetch-binaries): auto-detect PR and download overlay

When run on a checked-out PR branch with no local binaries.lock.pr,
fetch-binaries.sh queries the public api.github.com endpoint
/repos/{owner}/{repo}/commits/{sha}/pulls (no auth required for public
repos; uses gh CLI when available for higher rate limits) to find the
PR number, then downloads binaries.lock.pr from pr-<NNN>-staging.

Adds --pr <N> as an explicit override.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `xtask stage-pr-overlay` subcommand

**Goal:** A new xtask subcommand that, given the durable manifest and a target arch, produces a staging directory containing only archives whose `cache_key_sha` differs from the durable, plus a `binaries.lock.pr` overlay file ready to upload.

**Files:**
- Create: `xtask/src/stage_pr_overlay.rs`
- Modify: `xtask/src/main.rs` — register the subcommand
- Modify: `xtask/src/build_deps.rs` — expose any helper internals (only if needed)

### Step 1: Read existing `stage_release.rs` to understand the structure

Read `xtask/src/stage_release.rs` end-to-end. Note:
- How it walks `examples/libs/<name>/deps.toml` via `Registry::walk_all`.
- How it produces archives via `archive_stage`.
- How it generates `manifest.json`.

`stage_pr_overlay` will reuse most of this logic but filtered to changed packages.

### Step 2: Design the command's interface (no implementation yet)

Document the planned interface as a doc comment at the top of `xtask/src/stage_pr_overlay.rs`:

```rust
//! `stage-pr-overlay` — produce a partial staging directory containing
//! only the archives whose cache_key_sha differs from a baseline durable
//! manifest, plus a `binaries.lock.pr` overlay file.
//!
//! Usage:
//!   cargo xtask stage-pr-overlay \
//!       --baseline-manifest <path/to/durable/manifest.json> \
//!       --staging-tag pr-<NNN>-staging \
//!       --out <staging-dir> \
//!       [--arch wasm32]...
//!
//! Output: $STAGING/{libs,programs}/<archive>.tar.zst (only changed) +
//!         $STAGING/manifest.json (entries for changed archives only) +
//!         $STAGING/binaries.lock.pr (overlay).
//!
//! No archives produced means no changes — exits 0 with empty staging.
//! Caller (CI workflow) detects empty staging and skips upload.
```

### Step 3: Write the unit test (failing)

In `xtask/src/stage_pr_overlay.rs`, add a `#[cfg(test)] mod tests` with:

1. A test that constructs a baseline manifest with two entries (zlib, dinit), runs the command logic against a fixture registry where dinit's deps.toml has been bumped, and asserts only dinit appears in the staging output + the overlay's `overrides` list contains exactly `["dinit"]`.
2. A test that asserts an unchanged registry produces empty staging and an overlay with empty `overrides`.

Use the same fixture-registry pattern as in `build_deps.rs` test mod (~line 2527 onwards has examples).

Run: `cargo test -p xtask --target aarch64-apple-darwin stage_pr_overlay --quiet`
Expect: FAIL — module not registered or function not implemented.

### Step 4: Wire the subcommand into main.rs

In `xtask/src/main.rs`, add module declaration and dispatch:

```rust
mod stage_pr_overlay;
```

In the dispatch match (~line 49):

```rust
        "stage-pr-overlay" => stage_pr_overlay::run(rest),
```

Update the help string in main.rs's docstring + the unrecognized-subcommand error message to include `stage-pr-overlay`.

### Step 5: Implement the command

Skeleton:

```rust
pub fn run(args: Vec<String>) -> Result<(), String> {
    // 1. Parse args: --baseline-manifest, --staging-tag, --out, --arch (repeatable).
    // 2. Read baseline manifest, build name→cache_key_sha map.
    // 3. Walk Registry::from_env, for each deps.toml:
    //    a. compute cache_key_sha for this arch via build_deps::compute_sha.
    //    b. compare against baseline map.
    //    c. if differs (or absent in baseline): mark as override.
    // 4. For each override package: ensure_built (build if not cached), archive_stage
    //    into $out/{libs,programs}/.
    // 5. Compose new manifest.json containing only override entries.
    // 6. Compose binaries.lock.pr:
    //    {
    //      "staging_tag": <provided>,
    //      "staging_manifest_sha256": <sha of just-written manifest.json>,
    //      "overrides": [<package names>]
    //    }
    //    Write to $out/binaries.lock.pr.
    // 7. Print a one-line summary: "stage-pr-overlay: N overrides (...)"
}
```

Reuse `build_deps::compute_sha` and `archive_stage` from existing modules. If `compute_sha` requires private internals, expose them (or add a thin pub helper).

### Step 6: Run the unit tests; verify they pass

```
cargo test -p xtask --target aarch64-apple-darwin stage_pr_overlay --quiet
```

Expect: PASS.

### Step 7: Smoke test against the real registry

Without bumping any package, run:

```
mkdir -p /tmp/test-pr-overlay
cargo run -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') -- stage-pr-overlay \
    --baseline-manifest /tmp/baseline-manifest.json \
    --staging-tag pr-test-staging \
    --out /tmp/test-pr-overlay \
    --arch wasm32
```

(Generate a fixture baseline manifest by running existing `cargo xtask stage-release` once into a sibling dir and copying the `manifest.json` out.)

Expect: empty staging, overlay with empty `overrides`. Validates the no-op path works.

### Step 8: Commit

```
git add xtask/src/stage_pr_overlay.rs xtask/src/main.rs
git commit -m "feat(xtask): stage-pr-overlay command for per-PR staging dirs

Walks the registry, compares each package's cache_key_sha against a
provided baseline manifest, and stages only changed archives. Outputs
manifest.json + binaries.lock.pr ready for upload to a pr-<NNN>-staging
GitHub release.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `stage-pr-staging.sh` + `publish-pr-staging.sh` wrapper scripts

**Goal:** Two thin wrapper scripts mirroring the existing `stage-release.sh` / `publish-release.sh` pair, but targeting per-PR pre-releases.

**Files:**
- Create: `scripts/stage-pr-staging.sh` — wraps `xtask stage-pr-overlay`, downloads baseline manifest from durable release.
- Create: `scripts/publish-pr-staging.sh` — wraps `gh release create` / `gh release upload` for the pre-release tag.

### Step 1: Stub out `stage-pr-staging.sh`

Pattern after `scripts/stage-release.sh`. Contract:

```
Usage:
  scripts/stage-pr-staging.sh --pr <N> --out <staging-dir> [--arch wasm32]...

Reads binaries.lock to find the durable release tag, downloads its
manifest.json, then invokes xtask stage-pr-overlay against it.
```

Implementation steps:
1. Parse flags.
2. Read `binaries.lock` → durable release tag.
3. `curl -fsSL` the durable manifest.json into a temp file.
4. Invoke `cargo run -p xtask -- stage-pr-overlay --baseline-manifest <tmp> --staging-tag pr-<N>-staging --out <out>`.
5. Echo a one-line "ready to publish" message.

### Step 2: Stub out `publish-pr-staging.sh`

Pattern after `scripts/publish-release.sh`. Contract:

```
Usage:
  scripts/publish-pr-staging.sh --pr <N> --staging <dir>

Creates (or updates) the pr-<N>-staging pre-release and uploads all
.tar.zst archives + manifest.json + binaries.lock.pr from <dir>.
```

Implementation steps:
1. Parse flags.
2. Check if `pr-<N>-staging` already exists (`gh release view`).
3. If yes: `gh release upload --clobber` to replace assets.
4. If no: `gh release create --prerelease --target $(git rev-parse HEAD)` then upload.
5. Title: `PR #N staging build`. Body: brief description + `cache_key_sha` for each archive.

Both scripts should be idempotent — re-running doesn't break.

### Step 3: Smoke test (manual; no automation gate yet)

Run end-to-end against your own throwaway test PR (open one against a sandbox repo if you don't want to litter the main repo's release page):

```
scripts/stage-pr-staging.sh --pr 999 --out /tmp/pr-999 --arch wasm32
ls /tmp/pr-999/                           # expect: libs/, programs/, manifest.json, binaries.lock.pr
scripts/publish-pr-staging.sh --pr 999 --staging /tmp/pr-999
gh release view pr-999-staging            # expect: pre-release with assets
gh release delete pr-999-staging --yes --cleanup-tag    # cleanup
```

### Step 4: Commit

```
git add scripts/stage-pr-staging.sh scripts/publish-pr-staging.sh
chmod +x scripts/stage-pr-staging.sh scripts/publish-pr-staging.sh
git commit -m "feat(scripts): stage/publish wrappers for pr-<N>-staging pre-releases

Mirror scripts/stage-release.sh + scripts/publish-release.sh but target
per-PR pre-release tags. Wrap xtask stage-pr-overlay + gh release.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `staging-build.yml` workflow

**Goal:** A GitHub Actions workflow that runs on each push to a same-repo PR, builds changed packages, publishes to `pr-<NNN>-staging`, posts a sticky comment, and sets a status check.

**Files:**
- Create: `.github/workflows/staging-build.yml`

### Step 1: Skeleton workflow

```yaml
name: Staging build

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  build:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # for sticky comment
      statuses: write        # for status check
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install host tools
        run: |
          sudo apt-get update
          sudo apt-get install -y zstd jq cmake ninja-build
          # LLVM toolchain installation matches existing CI setup;
          # if the repo doesn't have prior CI, add it here.

      - uses: dtolnay/rust-toolchain@nightly
        with:
          components: rust-src

      - name: Set up SDK
        run: source sdk/activate.sh && env >> $GITHUB_ENV

      - name: Cache xtask resolver dirs
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/wasm-posix-kernel
            target
          key: pr-staging-${{ hashFiles('Cargo.lock', 'examples/libs/**/deps.toml') }}

      - name: Stage PR overlay
        id: stage
        run: |
          mkdir -p /tmp/pr-staging
          scripts/stage-pr-staging.sh \
            --pr ${{ github.event.pull_request.number }} \
            --out /tmp/pr-staging \
            --arch wasm32
          # Detect empty staging (no overrides) and short-circuit.
          override_count=$(jq '.overrides | length' /tmp/pr-staging/binaries.lock.pr)
          echo "override_count=$override_count" >> $GITHUB_OUTPUT

      - name: Publish to pr-<N>-staging
        if: steps.stage.outputs.override_count != '0'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          scripts/publish-pr-staging.sh \
            --pr ${{ github.event.pull_request.number }} \
            --staging /tmp/pr-staging

      - name: Post sticky comment
        if: steps.stage.outputs.override_count != '0'
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: pr-staging-build
          message: |
            **Staging build for this PR**

            Built ${{ steps.stage.outputs.override_count }} package archive(s) and uploaded to [`pr-${{ github.event.pull_request.number }}-staging`](https://github.com/${{ github.repository }}/releases/tag/pr-${{ github.event.pull_request.number }}-staging).

            Reviewers can fetch them locally with:
            ```
            gh pr checkout ${{ github.event.pull_request.number }}
            scripts/fetch-binaries.sh
            ```

      - name: Post no-op sticky comment
        if: steps.stage.outputs.override_count == '0'
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: pr-staging-build
          message: |
            **Staging build for this PR**

            No package contents changed in this push (cache_key_sha unchanged for all packages). Existing staging release (if any) remains valid.
```

### Step 2: Verify workflow syntax

```
# Use act if installed, or push to a throwaway branch and check the Actions tab.
gh workflow view staging-build.yml --ref package-management-for-pr-workflows
```

### Step 3: End-to-end test on a real PR

Open a small throwaway PR that touches `examples/libs/<name>/deps.toml`. Confirm:
- Workflow runs.
- Staging release `pr-<NNN>-staging` is created.
- Sticky comment appears.
- `pr-<NNN>-staging` contains the changed archive(s) and `binaries.lock.pr`.

Delete the throwaway PR + staging release after testing.

### Step 4: Commit

```
git add .github/workflows/staging-build.yml
git commit -m "ci(staging-build): per-PR staging release for changed packages

Builds packages whose cache_key_sha changed, uploads to pr-<N>-staging
pre-release, posts a sticky PR comment with reviewer instructions.
Skips fork PRs (handled in §9.1 follow-up).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `prepare-merge.yml` workflow

**Goal:** Triggered by the `ready-to-ship` label, builds against tip-of-main, publishes the durable release, pushes the lockfile bump to the PR branch, and enables squash auto-merge. Closes the (b) gap window from the design doc.

**Files:**
- Create: `.github/workflows/prepare-merge.yml`
- Create: `.github/labels.yml` (or extend an existing label-config) — define the `ready-to-ship` label

### Step 1: Define the `ready-to-ship` label

Add (or create) `.github/labels.yml`:

```yaml
- name: ready-to-ship
  color: 0E8A16
  description: "Trigger prepare-merge.yml: build, publish durable release, amend PR with lockfile bump, auto-merge."
- name: binaries-bot
  color: BFDADC
  description: "PR or commit produced by the binaries automation."
```

If the repo doesn't already use a labeler workflow, manually create the label via `gh label create ready-to-ship --color 0E8A16 --description "..."` after the workflow lands.

### Step 2: Skeleton workflow

```yaml
name: Prepare merge

on:
  pull_request:
    types: [labeled]

concurrency:
  group: prepare-merge-singleton
  cancel-in-progress: false

jobs:
  publish:
    if: github.event.label.name == 'ready-to-ship' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: write          # push lockfile commit to PR branch
      pull-requests: write     # enable auto-merge, comment
      statuses: write
    steps:
      - name: Verify PR is approved + checks green
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          PR=${{ github.event.pull_request.number }}
          REVIEW=$(gh pr view "$PR" --json reviewDecision -q .reviewDecision)
          if [ "$REVIEW" != "APPROVED" ]; then
            gh pr edit "$PR" --remove-label ready-to-ship
            gh pr comment "$PR" --body "Cannot prepare merge: PR is not in APPROVED state (got: $REVIEW)."
            exit 1
          fi
          # Check all required checks (excluding this workflow's own job).
          CHECKS=$(gh pr checks "$PR" --json bucket -q '[.[] | select(.bucket != "skipping" and .bucket != "pending")]')
          FAILING=$(echo "$CHECKS" | jq '[.[] | select(.bucket == "fail")] | length')
          if [ "$FAILING" -gt 0 ]; then
            gh pr edit "$PR" --remove-label ready-to-ship
            gh pr comment "$PR" --body "Cannot prepare merge: $FAILING required checks failing."
            exit 1
          fi

      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Merge tip-of-main into PR HEAD (in-memory)
        run: |
          git config user.name "wasm-posix-binaries-bot"
          git config user.email "noreply@anthropic.com"
          git fetch origin main
          git merge --no-edit origin/main || {
            echo "merge conflict — drop label and abort"
            gh pr edit ${{ github.event.pull_request.number }} --remove-label ready-to-ship
            gh pr comment ${{ github.event.pull_request.number }} --body "Cannot prepare merge: PR has merge conflicts with main. Please rebase."
            exit 1
          }
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Install host tools + Rust nightly
        # (same as staging-build.yml — extract to a composite action if duplication grows)
        run: |
          sudo apt-get update
          sudo apt-get install -y zstd jq cmake ninja-build

      - uses: dtolnay/rust-toolchain@nightly
        with:
          components: rust-src

      - name: Set up SDK
        run: source sdk/activate.sh && env >> $GITHUB_ENV

      - name: Compute durable tag
        id: tag
        run: |
          ABI=$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')
          DATE=$(date -u +%Y-%m-%d)
          BASE="binaries-abi-v${ABI}-${DATE}"
          TAG="$BASE"
          SEQ=2
          while gh release view "$TAG" >/dev/null 2>&1; do
            TAG="${BASE}-${SEQ}"
            SEQ=$((SEQ + 1))
          done
          echo "tag=$TAG" >> $GITHUB_OUTPUT
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Stage durable release
        run: |
          mkdir -p /tmp/durable
          scripts/stage-release.sh --out /tmp/durable --arch wasm32

      - name: Publish durable release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          scripts/publish-release.sh --tag ${{ steps.tag.outputs.tag }} --staging /tmp/durable

      - name: Compute new manifest sha + rewrite binaries.lock
        run: |
          SHA=$(shasum -a 256 /tmp/durable/manifest.json | awk '{print $1}')
          ABI=$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')
          jq -n \
            --arg abi "$ABI" \
            --arg tag "${{ steps.tag.outputs.tag }}" \
            --arg sha "$SHA" \
            '{abi_version: ($abi | tonumber), release_tag: $tag, manifest_sha256: $sha}' \
            > binaries.lock

      - name: Push lockfile bump to PR branch
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          # Reset the in-memory merge of main (we don't want to push that);
          # apply only the binaries.lock change on top of PR HEAD.
          git checkout ${{ github.event.pull_request.head.sha }}
          git checkout HEAD -- .
          # Re-write binaries.lock at this commit.
          # (Re-run the jq from previous step against /tmp/durable/manifest.json.)
          # ... [identical jq invocation]
          git add binaries.lock
          git commit -m "chore(binaries): bump lockfile to ${{ steps.tag.outputs.tag }}"
          git push origin HEAD:${{ github.event.pull_request.head.ref }}

      - name: Enable squash auto-merge
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh pr merge ${{ github.event.pull_request.number }} --auto --squash

      - name: On failure — drop label + comment
        if: failure()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh pr edit ${{ github.event.pull_request.number }} --remove-label ready-to-ship || true
          gh pr comment ${{ github.event.pull_request.number }} \
            --body "prepare-merge failed at step \"${{ steps.last-step.outcome }}\". Check the workflow run log: ${{ github.event.repository.html_url }}/actions/runs/${{ github.run_id }}"
```

(The above sketch will need refinement — particularly around the "push lockfile bump" step's commit-tree management. Implementer should test interactively.)

### Step 3: Branch protection setup

In the repo settings (manual, not automated by this PR):
- Add `auto-merge eligible` as a required status check on `main`.
- Allow `wasm-posix-binaries-bot` (or `github-actions[bot]`) to push to PR branches via repository permissions.
- The lockfile bump commit should be allowed even if branch protection is on, because the workflow pushes to PR branches, not main.

Document this setup in the PR description so the maintainer knows to apply it before turning the workflow on.

### Step 4: End-to-end test

Open a throwaway PR, merge tip-of-main into it manually if needed, get it approved by a sock-puppet account or co-conspirator, apply the `ready-to-ship` label. Confirm:

- Durable release is created with today's date.
- Lockfile bump commit lands on the PR branch.
- Auto-merge fires; PR is squash-merged to main with both the user changes and the lockfile bump in one commit.

Roll back the durable release after testing (`gh release delete` + revert main commit).

### Step 5: Commit

```
git add .github/workflows/prepare-merge.yml .github/labels.yml
git commit -m "ci(prepare-merge): publish durable release + amend PR on ready-to-ship

Triggered by the ready-to-ship label. Builds packages against tip-of-main
merged with PR HEAD, publishes binaries-abi-v<N>-YYYY-MM-DD, pushes a
lockfile bump commit to the PR branch, and enables squash auto-merge.
The squash merge collapses code + deps.toml + lockfile bump into a single
main commit — no gap window.

Concurrency-locked to prepare-merge-singleton so only one PR publishes
the durable release at a time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `staging-cleanup.yml` workflow

**Goal:** Delete `pr-<NNN>-staging` pre-releases when PRs close, with a daily sweep for orphans.

**Files:**
- Create: `.github/workflows/staging-cleanup.yml`

### Step 1: Skeleton workflow

```yaml
name: Staging cleanup

on:
  pull_request:
    types: [closed]
  schedule:
    - cron: '0 8 * * *'   # daily at 08:00 UTC
  workflow_dispatch:        # allow manual sweep

jobs:
  cleanup-on-close:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Delete pr-<N>-staging
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          TAG="pr-${{ github.event.pull_request.number }}-staging"
          if gh release view "$TAG" >/dev/null 2>&1; then
            gh release delete "$TAG" --yes --cleanup-tag
            echo "Deleted $TAG"
          else
            echo "$TAG does not exist; nothing to clean up"
          fi

  sweep:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: read
    steps:
      - name: Sweep orphan staging tags
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release list --limit 200 \
            --json tagName,isPrerelease \
            -q '.[] | select(.isPrerelease and (.tagName | startswith("pr-")) and (.tagName | endswith("-staging"))) | .tagName' \
          | while read -r TAG; do
              # Extract PR number: pr-<N>-staging.
              PR=${TAG#pr-}
              PR=${PR%-staging}
              if [ -z "$PR" ]; then
                echo "WARN: cannot parse PR from $TAG, skipping"
                continue
              fi
              STATE=$(gh pr view "$PR" --json state -q .state 2>/dev/null || echo "MISSING")
              if [ "$STATE" != "OPEN" ]; then
                echo "Deleting orphan $TAG (PR state: $STATE)"
                gh release delete "$TAG" --yes --cleanup-tag
              fi
            done
```

### Step 2: Test the sweep manually

After the workflow lands, run:

```
gh workflow run staging-cleanup.yml
gh run list --workflow=staging-cleanup.yml --limit 1
```

Confirm it runs successfully against the current set of staging tags (if any).

### Step 3: Commit

```
git add .github/workflows/staging-cleanup.yml
git commit -m "ci(staging-cleanup): delete pr-<N>-staging on PR close + daily sweep

On pull_request closed: delete the corresponding pr-<N>-staging tag.
Daily cron + workflow_dispatch sweeps for orphans (catches webhook misses).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Documentation updates

**Goal:** Update user-facing docs to describe the new flow.

**Files:**
- Modify: `docs/binary-releases.md` — describe the three workflows + the overlay file's lifecycle
- Modify: `docs/package-management.md` — cross-link to PR-builds doc
- Modify: `docs/package-management-future-work.md` — strike "CI-driven dep builds" as partially complete; note remaining (fork-PR support) as still open

### Step 1: Update `docs/binary-releases.md`

Add a new top-level section "PR package builds" after the existing release-creation flow. Cover:
- Purpose (one paragraph).
- Workflow triggers + responsibilities (table or bullet list).
- Author / reviewer / maintainer flow (the §5 content from the design doc, condensed).
- The overlay file's role; why it's gitignored.

Keep it ≤ 80 lines.

### Step 2: Cross-link from `docs/package-management.md`

Find any existing "Releases" or "Distribution" section. Add a one-line pointer to `docs/binary-releases.md#pr-package-builds`.

### Step 3: Update `docs/package-management-future-work.md`

In the "CI-driven dep builds" section, prepend:

```
**Status (2026-04-29):** Partial — the per-PR staging release flow + on-merge durable publish ship in PR <N>. Fork-PR support (§9.1 of the PR-builds design doc) is the remaining open piece.
```

(Replace `<N>` with the actual PR number after opening it.)

### Step 4: Commit

```
git add docs/
git commit -m "docs: describe PR package builds flow

- docs/binary-releases.md: new section covering staging-build,
  prepare-merge, and staging-cleanup workflows + the overlay file.
- docs/package-management.md: cross-link.
- docs/package-management-future-work.md: mark CI-driven dep builds as
  partially complete; fork-PR support remains open.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: End-to-end verification

**Goal:** Open a PR that exercises the full flow end-to-end. Required before merging this initiative.

### Step 1: Push the branch + open the PR

```
git push origin package-management-for-pr-workflows
gh pr create --title "feat: PR package builds — single-PR flow with on-merge publish" \
  --body "$(cat <<'EOF'
Implements docs/plans/2026-04-29-pr-package-builds-design.md.

## Test plan
- [ ] staging-build.yml runs on push, creates pr-<N>-staging release
- [ ] Sticky comment appears with package list
- [ ] `gh pr checkout <N> && scripts/fetch-binaries.sh` auto-detects PR, downloads overlay, fetches archives
- [ ] Override archives come from staging URL; rest from durable URL
- [ ] Apply ready-to-ship → prepare-merge.yml runs → durable release published → lockfile commit on PR → auto-merge fires → main has single squash commit with all changes
- [ ] PR close (or merge) deletes pr-<N>-staging
- [ ] Daily sweep runs without errors

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Step 2: Verify staging-build runs cleanly

In the PR's Actions tab, watch `staging-build.yml`. Expect green; sticky comment appears.

### Step 3: Verify reviewer flow

```
# Fresh clone in a temp dir to simulate a reviewer with no local state.
mkdir -p /tmp/pr-review-test && cd /tmp/pr-review-test
git clone https://github.com/brandonpayton/wasm-posix-kernel.git
cd wasm-posix-kernel
gh pr checkout <PR-N>
scripts/fetch-binaries.sh
ls binaries/                   # expect: kernel.wasm, programs/, libs/
```

Confirm overlay was used (look for "fetch-binaries: downloading overlay from pr-N-staging" in stdout).

### Step 4: Verify prepare-merge

After the PR is approved (sock-puppet approval is acceptable for this dogfood test if you can't get a real reviewer), apply `ready-to-ship`. Watch `prepare-merge.yml`.

Confirm:
- New `binaries-abi-v<N>-YYYY-MM-DD` durable release on the releases page.
- Bot commit `chore(binaries): bump lockfile to ...` appears on the PR branch.
- PR auto-merges to main as a single squash commit including the lockfile bump.
- `pr-<PR-N>-staging` is deleted.

### Step 5: Document any gaps found in the design doc

If implementation surfaces issues (e.g., concurrency lock too restrictive, branch protection bypass needed in unanticipated places), update §7 of the design doc with the findings.

### Step 6: Final commit (if needed)

If any tweaks were made during E2E, commit them with a clear message. Otherwise, no final commit needed — the PR is ready for human review at this point.

---

## Open issues / things to flag during review

These are intentional limitations or unresolved questions that the reviewer should be aware of:

1. **Fork PRs are not supported.** Documented in design doc §9.1; resolver source-build fallback handles them functionally.
2. **`auto-merge eligible` status check** must be configured as a required check in branch protection — manual setup, not automated by this PR.
3. **Concurrency lock** serialises all `prepare-merge.yml` runs. If the project ever has high merge throughput, this becomes a bottleneck — measure before optimising.
4. **`kernel.wasm` / `userspace.wasm`** are still not in releases (per `docs/package-management-future-work.md`). This design doesn't change that.
5. **Throwaway test pollution.** End-to-end testing creates real GitHub releases. Either use a sandbox repo for the dogfood test, or make sure to clean up (`gh release delete --cleanup-tag`) afterwards.

## References

- Design doc: `docs/plans/2026-04-29-pr-package-builds-design.md`
- Existing scripts: `scripts/{stage,publish,fetch}-binaries.sh`, `scripts/{stage,publish}-release.sh`
- Existing xtask commands: `cargo xtask {build-deps,stage-release,install-release}`
- Existing release artifact layout: `binaries-abi-v6-2026-04-29` on the releases page
- ABI policy: `docs/abi-versioning.md`
