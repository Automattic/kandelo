# Decoupled Package Builds — Phase B-2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Two focused additions to the matrix CI infrastructure: (a) F2 sticky PR-comment bot summarizing per-package build status from the matrix flow, and (b) tightening the `kernel_abi` field from optional to required (the matrix gating in Phase B-1 already relies on it being populated; the parser should enforce that for source manifests).

**Architecture:** Both tasks are additive. The F2 bot runs as a new GHA job after `generate-index` (Phase B-1's last existing job), aggregates `publish-status.json` from matrix outcomes + the target release's existing assets, then renders a sticky PR comment via `actions/github-script@v7`. The `kernel_abi` tightening is parser-side: source `package.toml` files must declare `kernel_abi`; archived `manifest.toml` files (legacy bytes from before A-bis) keep accepting absence for back-compat.

**Tech Stack:** Bash + jq (status JSON aggregation in workflow), `actions/github-script@v7` (sticky comment), Rust (xtask parser), TOML (package.toml).

**Reference:** `docs/plans/2026-05-05-decoupled-package-builds-design.md` §6.3 (F2 surface) and §3.1 (`kernel_abi` field).

**Scope decision: force-rebuild restructure deferred.** Per discussion 2026-05-06, the force-rebuild matrix-restructure ships in Phase C alongside the resolver cutover. It's tightly coupled to retiring `manifest.json` / `binaries.lock`; doing it in B-2 would require adding new manifest.json generation to the matrix flow only to throw it away in C.

---

## Pre-flight

### Pre-task: branch setup + baseline

**Files:** None — verification only.

**Step 1: Confirm origin/main has Phase B-1 merged.**

```bash
git fetch origin main
git log --oneline origin/main -3
```

Expected: PR #428 in the recent log (the squash-merge of Phase B-1).

**Step 2: Create the worktree.**

```bash
cd /Users/brandon/ai-src/wasm-posix-kernel
git worktree add /Users/brandon/.superset/worktrees/wasm-posix-kernel/phase-b-2-f2-and-abi -b phase-b-2-f2-and-abi origin/main
```

**Work from `/Users/brandon/.superset/worktrees/wasm-posix-kernel/phase-b-2-f2-and-abi` for all subsequent tasks.**

**Step 3: Confirm xtask builds clean + tests pass.**

```bash
bash scripts/dev-shell.sh cargo build --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') 2>&1 | tail -3
bash scripts/dev-shell.sh cargo test --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') 2>&1 | tail -5
```

Expected: clean build; xtask test count is the post-Phase-B-1 baseline (211 passed).

**Step 4: Confirm `.github/workflows/staging-build.yml` has the Phase B-1 jobs.**

```bash
grep -E '^[a-z][a-z_-]+:$' .github/workflows/staging-build.yml | head
```

Expected: `build` (legacy), `preflight`, `toolchain-cache`, `matrix-build`, `test-gate`, `publish`, `generate-index`. Phase B-2 adds one more (`f2-status`).

---

## Task 1: F2 publish-status.json + sticky PR comment

**Files:**
- Modify: `.github/workflows/staging-build.yml`

**Goal:** After `generate-index` succeeds, a new `f2-status` job aggregates per-package build outcomes, emits `publish-status.json` (uploaded as a workflow artifact for inspection), and posts/edits a sticky PR comment rendering the status as a markdown table.

**Step 1: Read the design's F2 format.**

The expected `publish-status.json` shape (per design §6.3):

```json
{
  "abi_version": 7,
  "release_tag": "pr-428-staging",
  "packages": [
    { "name": "bash",    "arch": "wasm32", "status": "built",       "sha": "abc..." },
    { "name": "mariadb", "arch": "wasm32", "status": "failed",      "previous_sha": "old...", "error_log_url": "..." },
    { "name": "vim",     "arch": "wasm32", "status": "cached-skip", "sha": "..." }
  ]
}
```

Three statuses:
- `built` — matrix built this entry this run; new archive uploaded to release.
- `failed` — matrix-build for this entry failed; consumers fall back to `previous_sha` (last-green from prior run on this same release tag).
- `cached-skip` — preflight's content-hash gate found the archive already published; matrix didn't re-run.

For B-2, the `error_log_url` field is best-effort (`null` if not easily derivable). Don't block on perfect URL stitching.

**Step 2: Add the `f2-status` job.**

Insert after `generate-index`. Aggregates info from preflight + matrix-build outcomes + the release's current asset list. Inline shell + jq is sufficient — no new xtask code needed.

```yaml
f2-status:
  needs: [preflight, matrix-build, publish, generate-index]
  if: always() && needs.preflight.outputs.matrix != '[]'
  runs-on: ubuntu-latest
  permissions:
    pull-requests: write   # post/edit PR comment
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  steps:
    - uses: actions/checkout@v4
      with:
        ref: ${{ github.event.pull_request.head.sha }}
    - name: Compute publish-status.json
      id: status
      run: |
        TAG="${{ needs.preflight.outputs.target_tag }}"
        ABI="${{ needs.preflight.outputs.abi }}"
        MATRIX='${{ needs.preflight.outputs.matrix }}'

        # Currently published assets in the release (post-publish).
        existing=$(gh release view "$TAG" --repo "${{ github.repository }}" \
          --json assets --jq '[.assets[].name]' 2>/dev/null || echo '[]')

        # For each matrix entry, decide status:
        #   - sha's archive exists AND was uploaded by THIS workflow run → built
        #   - sha's archive doesn't exist (matrix-build failed) → failed
        #     (look up previous archive for this <pkg>-<arch> in the release for previous_sha)
        # Plus all (package, arch) pairs NOT in the matrix but in preflight's full survey
        # are cached-skip — but preflight only emits the narrowed matrix today, so we'd need
        # to expand preflight to emit the full list. For B-2, START SIMPLE: only report on
        # entries that were in the narrowed matrix. cached-skip rows can be added in a
        # follow-up if reviewers want them.
        #
        # The matrix-build job's outcome per entry can be derived from whether its
        # uploaded artifact exists; alternatively, query the GHA jobs API. For B-2, use
        # the artifact-presence check (artifact name is "<pkg>-<arch>" per Task 4 of B-1).

        packages_json='[]'
        echo "$MATRIX" | jq -c '.[]' | while read -r entry; do
          pkg=$(echo "$entry" | jq -r .package)
          arch=$(echo "$entry" | jq -r .arch)
          sha=$(echo "$entry" | jq -r .sha)
          short8="${sha:0:8}"

          # Match the canonical filename pattern.
          if echo "$existing" | jq -e --arg pre "${pkg}-" --arg suf "-abi${ABI}-${arch}-${short8}.tar.zst" \
              'any(.[]; startswith($pre) and endswith($suf))' >/dev/null; then
            status_entry=$(jq -nc --arg n "$pkg" --arg a "$arch" --arg s "$sha" \
              '{name:$n, arch:$a, status:"built", sha:$s}')
          else
            # Look for a previous archive for the same (pkg, arch) but a different sha.
            prev_sha=$(echo "$existing" | jq -r --arg pre "${pkg}-" --arg arch_suf "-${arch}-" \
              '[.[] | select(startswith($pre) and contains($arch_suf))] | .[0] // ""' \
              | sed 's/.*-\([a-f0-9]\{8\}\)\.tar\.zst$/\1/' || echo "")
            status_entry=$(jq -nc --arg n "$pkg" --arg a "$arch" --arg p "$prev_sha" \
              '{name:$n, arch:$a, status:"failed"} + (if $p == "" then {} else {previous_sha:$p} end)')
          fi
          packages_json=$(echo "$packages_json" | jq -c --argjson e "$status_entry" '. + [$e]')
        done

        jq -nc --argjson abi "$ABI" --arg tag "$TAG" --argjson pkgs "$packages_json" \
          '{abi_version:$abi, release_tag:$tag, packages:$pkgs}' \
          > publish-status.json
        echo "--- publish-status.json ---"
        cat publish-status.json | jq .
        echo "json=$(cat publish-status.json | jq -c .)" >> "$GITHUB_OUTPUT"
    - name: Upload publish-status.json
      uses: actions/upload-artifact@v4
      with:
        name: publish-status
        path: publish-status.json
        retention-days: 30
    - name: Post or edit sticky PR comment
      if: github.event_name == 'pull_request'
      uses: actions/github-script@v7
      with:
        script: |
          const status = JSON.parse(process.env.STATUS_JSON);
          const marker = '<!-- phase-b-status -->';
          const total = status.packages.length;
          const built = status.packages.filter(p => p.status === 'built').length;
          const failed = status.packages.filter(p => p.status === 'failed').length;

          const rows = status.packages.map(p => {
            const sha = p.sha ? p.sha.slice(0, 8) : (p.previous_sha ? `(prev ${p.previous_sha.slice(0, 8)})` : '—');
            return `| ${p.name} | ${p.arch} | ${p.status} | \`${sha}\` |`;
          }).join('\n');

          const body = [
            marker,
            `## Phase B-1 matrix build status — \`${status.release_tag}\``,
            '',
            `ABI v${status.abi_version}. **${built} built**, **${failed} failed**, ${total} total.`,
            '',
            '| Package | Arch | Status | Sha |',
            '| --- | --- | --- | --- |',
            rows,
            '',
            '<sub>This comment is auto-generated and replaced on each push. See `publish-status.json` artifact for the raw data.</sub>',
          ].join('\n');

          const issue_number = context.issue.number;
          const { owner, repo } = context.repo;

          const { data: comments } = await github.rest.issues.listComments({ owner, repo, issue_number });
          const existing = comments.find(c => c.body && c.body.startsWith(marker));

          if (existing) {
            await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
            console.log(`Updated sticky comment ${existing.id}`);
          } else {
            await github.rest.issues.createComment({ owner, repo, issue_number, body });
            console.log('Created new sticky comment');
          }
      env:
        STATUS_JSON: ${{ steps.status.outputs.json }}
```

**Step 3: YAML lint.**

```bash
python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/staging-build.yml"))' && echo ok
```

**Step 4: Commit.**

```bash
git add .github/workflows/staging-build.yml
git commit -m "feat(ci): F2 sticky PR comment with per-package build status (Phase B-2 Task 1)

Adds an f2-status job that runs after generate-index, aggregates
matrix outcomes + the release's current asset list into
publish-status.json (uploaded as a workflow artifact, retention 30
days), and posts/edits a sticky PR comment via actions/github-script
rendering a per-package status table.

Three statuses per the design §6.3:
- built — matrix built this entry; new archive in the release.
- failed — matrix-build failed; previous_sha (last-green) reported.
- cached-skip — covered by preflight's gate but not surfaced in
  this initial implementation (only matrix entries are reported).
  Follow-up if reviewers want full coverage.

Sticky comment uses a <!-- phase-b-status --> marker so re-runs
edit the existing comment rather than spamming new ones.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

## Important notes for Task 1

- **`if: always()`** ensures the f2-status job runs even when matrix-build had failures. The whole point of the bot is to surface partial-failure clearly.
- **Permissions: `pull-requests: write`** is needed for posting comments. Don't add `contents: write` here; the f2-status job doesn't push code.
- **Sticky comment marker** must be the FIRST line of the comment body — that's what `comments.find` matches on.
- **The `cached-skip` rows are explicitly out of scope for B-2.** Adding them requires preflight to emit the FULL set of (pkg, arch) pairs (not just the narrowed matrix). Trivial workflow change but increases the surface to test. Defer.

---

## Task 2: `kernel_abi` backfill survey + populate

**Files:** Up to 55 `examples/libs/*/package.toml` files.

**Goal:** Ensure every first-party `package.toml` with a `[build]` block declares `kernel_abi = N` matching the current `ABI_VERSION` (per `crates/shared/src/lib.rs`). Phase A-bis added the field as optional; Phase B-2 Task 3 will tighten the parser to require it for source manifests, so all source files must have it set first.

**Step 1: Determine current ABI version.**

```bash
grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}'
```

Expected: `7` (per `binaries-abi-v7` releases).

Capture the value as `$ABI` for the rest of this task.

**Step 2: Survey which packages already have `kernel_abi`.**

```bash
for f in examples/libs/*/package.toml; do
  pkg=$(basename "$(dirname "$f")")
  has_build=$(grep -q '^\[build\]' "$f" && echo y || echo n)
  has_kernel_abi=$(grep -q '^kernel_abi' "$f" && echo y || echo n)
  printf "%-30s  build=%s  kernel_abi=%s\n" "$pkg" "$has_build" "$has_kernel_abi"
done | tee /tmp/kernel-abi-survey.log
echo "---"
grep -c 'kernel_abi=n' /tmp/kernel-abi-survey.log    # how many missing
grep 'build=y' /tmp/kernel-abi-survey.log | grep -c 'kernel_abi=n'  # missing AND first-party-built
```

The `build=y kernel_abi=n` count is the backfill target. The `build=n` packages (kernel, userspace, examples, node, sqlite-cli, pcre2-source) are NOT going to be tightened (they don't have `[build]`, so the parser-required check on Task 3 only targets `[build]`-having packages).

**Step 3: Backfill missing entries.**

`kernel_abi` is a top-level field. Insert it after `revision` (the conventional location, before `depends_on` if present):

```bash
ABI=7   # confirm matches Step 1
for f in examples/libs/*/package.toml; do
  if grep -q '^\[build\]' "$f" && ! grep -q '^kernel_abi' "$f"; then
    pkg=$(basename "$(dirname "$f")")
    # Insert "kernel_abi = $ABI" after the line beginning with "revision"
    # (every first-party package.toml has revision; verify by spot-check).
    python3 - "$f" "$ABI" <<'PY'
import sys, re
path, abi = sys.argv[1], sys.argv[2]
text = open(path).read()
# Match a "revision = N" line and insert kernel_abi after it.
new_text, count = re.subn(
    r'^(revision\s*=\s*\d+\n)',
    rf'\1kernel_abi = {abi}\n',
    text,
    count=1,
    flags=re.MULTILINE,
)
if count == 0:
    print(f"WARN: {path} has no 'revision' line; skipping", file=sys.stderr)
    sys.exit(1)
open(path, 'w').write(new_text)
PY
    echo "backfilled: $pkg"
  fi
done
```

If any package lacks a `revision` line (the python script will warn), inspect manually and decide where to put `kernel_abi` — top of the file after `name`/`version` is fine.

**Step 4: Verify all `[build]`-having packages now declare `kernel_abi`.**

```bash
for f in examples/libs/*/package.toml; do
  if grep -q '^\[build\]' "$f"; then
    if ! grep -q '^kernel_abi *=' "$f"; then
      echo "MISSING: $f"
    fi
  fi
done
```

Expected: empty output. Any `MISSING:` lines must be backfilled manually.

**Step 5: Verify all parse cleanly.**

```bash
fail=0
for f in examples/libs/*/package.toml; do
  if ! bash scripts/dev-shell.sh cargo run --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') --quiet -- build-deps parse "$f" >/dev/null 2>&1; then
    echo "PARSE FAIL: $f"
    fail=$((fail+1))
  fi
done
echo "fail count: $fail"
```

Expected: 0 failures.

**Step 6: Commit.**

```bash
git add examples/libs/
git commit -m "refactor(packages): backfill [build]-having package.toml with kernel_abi = $ABI

Phase A-bis added [build].kernel_abi as optional. Phase B-2 Task 3
will tighten the parser to require it on source manifests, so backfill
all <N> packages that have a [build] block but lack a kernel_abi
declaration.

The 6 packages without [build] (kernel, userspace, examples, node,
sqlite-cli, pcre2-source) are untouched — the Task 3 tightening only
applies to manifests with kind in (library | program) AND a [build]
block.

Field placed right after 'revision' for visual consistency with the
existing structure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Parser tightens `kernel_abi` from optional to required

**Files:**
- Modify: `xtask/src/pkg_manifest.rs`

**Goal:** Source-manifest parsing rejects `package.toml` files that lack `kernel_abi` (with a clear error pointing at the design doc). Archived `manifest.toml` files (legacy bytes published before A-bis) keep accepting absence — they're immutable historical artifacts and the parser must tolerate them just like it does the deprecated `[build].script` field.

**Step 1: Read the current state.**

```bash
grep -nB 2 -A 6 'kernel_abi\|fn validate_source\|fn validate_archived' xtask/src/pkg_manifest.rs | head -40
```

Phase A-bis defined:
- `Raw.kernel_abi: Option<u32>` (with `#[serde(default)]`).
- `DepsManifest.kernel_abi: Option<u32>`.
- Validators (`validate_source`, `validate_archived`) didn't enforce its presence.

**Step 2: Write the failing test.**

In `xtask/src/pkg_manifest.rs`'s test module, add:

```rust
#[test]
fn source_parse_rejects_missing_kernel_abi_when_build_block_present() {
    let toml = r#"
kind = "program"
name = "test"
version = "1.0.0"
revision = 1

[source]
url = "https://example.com/test-1.0.0.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "TestLicense"

[build]
script_path = "examples/libs/test/build-test.sh"
repo_url = "https://example.com/repo.git"

[binary.wasm32]
archive_url = "https://example.com/test.tar.zst"
archive_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
"#;
    let dir = std::path::PathBuf::from("/tmp/test");
    let result = DepsManifest::parse(toml, dir);
    assert!(result.is_err(), "expected error for missing kernel_abi");
    let msg = format!("{}", result.unwrap_err());
    assert!(msg.contains("kernel_abi"), "error message must mention kernel_abi: {msg}");
    assert!(msg.contains("required"), "error message must say required: {msg}");
}

#[test]
fn archived_parse_accepts_missing_kernel_abi() {
    // Legacy archives published before A-bis don't have kernel_abi
    // in their manifest.toml. validate_archived must tolerate this.
    let toml = r#"
kind = "program"
name = "test"
version = "1.0.0"
revision = 1

[source]
url = "https://example.com/test-1.0.0.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "TestLicense"

[binary.wasm32]
archive_url = "https://example.com/test.tar.zst"
archive_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[compatibility]
abi_versions = [7]
target_arches = ["wasm32"]
build_timestamp = "2026-01-01T00:00:00Z"
build_host = "test"
cache_key_sha = "0000000000000000000000000000000000000000000000000000000000000000"
"#;
    let dir = std::path::PathBuf::from("/tmp/test");
    DepsManifest::parse_archived(toml, dir).expect("archive must parse without kernel_abi");
}

#[test]
fn source_parse_accepts_kernel_abi_when_no_build_block() {
    // Source-only packages (pcre2-source) and metadata-only packages
    // (kernel, userspace) don't have [build] and aren't subject to
    // the kernel_abi requirement.
    let toml = r#"
kind = "source"
name = "test-source"
version = "1.0.0"
revision = 1

[source]
url = "https://example.com/test-1.0.0.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "TestLicense"
"#;
    let dir = std::path::PathBuf::from("/tmp/test");
    DepsManifest::parse(toml, dir).expect("source-kind without [build] must parse without kernel_abi");
}
```

The third test guards against over-tightening. Source-kind packages don't have `[build]` and shouldn't be required to declare `kernel_abi`.

**Step 3: Run the tests; confirm they fail.**

```bash
bash scripts/dev-shell.sh cargo test --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') pkg_manifest 2>&1 | tail -10
```

Expected: the new tests fail (parse currently doesn't enforce `kernel_abi` for any kind).

**Step 4: Tighten the parser.**

In `validate_source` (around line 628 of `xtask/src/pkg_manifest.rs`), add the check after the existing source-only validations:

```rust
fn validate_source(raw: Raw, dir: PathBuf) -> Result<Self, String> {
    if raw.compatibility.is_some() { /* existing check */ }
    if raw.build.as_ref().and_then(|b| b.script.as_ref()).is_some() { /* existing check */ }

    // NEW: source manifests with a [build] block must declare kernel_abi.
    // The [build] block is the marker for "this package gets matrix-built";
    // the matrix's ABI-floor check (design §6.2) requires kernel_abi to be
    // present. Source-only packages (kind = "source") and metadata-only
    // packages (no [build]) are exempt.
    if raw.build.is_some() && raw.kernel_abi.is_none() {
        return Err(format!(
            "source package.toml has [build] but no top-level kernel_abi — \
             declare kernel_abi = N (matching ABI_VERSION in \
             crates/shared/src/lib.rs) at the top of the file. \
             See docs/plans/2026-05-05-decoupled-package-builds-design.md §3.1."
        ));
    }

    /* rest of validate_source */
}
```

`validate_archived` is NOT modified — archived manifests retain the lenient parsing.

**Step 5: Run the tests; confirm they pass.**

```bash
bash scripts/dev-shell.sh cargo test --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') pkg_manifest 2>&1 | tail -5
```

**Step 6: Run the full xtask test suite.**

```bash
bash scripts/dev-shell.sh cargo test --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') 2>&1 | tail -5
```

Expected: post-Phase-B-1 baseline (211 tests) + 3 new = 214 passed, 0 failed.

**Step 7: Verify all 61 real `package.toml` files parse cleanly under the new validation.**

```bash
fail=0
for f in examples/libs/*/package.toml; do
  if ! bash scripts/dev-shell.sh cargo run --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') --quiet -- build-deps parse "$f" >/dev/null 2>&1; then
    echo "PARSE FAIL: $f"
    fail=$((fail+1))
  fi
done
echo "fail count: $fail"
```

Expected: 0 failures. If any package fails, Task 2's backfill missed it.

**Step 8: Commit.**

```bash
git add xtask/src/pkg_manifest.rs
git commit -m "feat(xtask): parser requires kernel_abi on source [build] manifests

Phase A-bis added [build] schema fields including kernel_abi as
optional. Phase B-1's CI matrix preflight uses kernel_abi for the
ABI-floor check (design §6.2: hard-fail if no archive has ever been
published for the current kernel ABI). Tighten the source parser to
reject [build]-having package.toml files that don't declare
kernel_abi.

validate_source now errors with a clear migration message pointing
at the design doc. validate_archived is unchanged — legacy
manifest.toml files published before A-bis don't have kernel_abi
and the parser must keep accepting them as it does the deprecated
[build].script field.

Three new tests cover the source-rejection path, the archive-tolerance
path, and the source-kind-no-build-block exemption.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Verify + push + PR

**Files:** None modified — verification only.

Same approach as previous phases (cheap local subset; CI dogfoods the matrix flow).

**Step 1: cargo unit tests.**

```bash
bash scripts/dev-shell.sh cargo test -p wasm-posix-kernel --target $(rustc -vV | awk '/^host/ {print $2}') --lib 2>&1 | tail -5
```

Expected: 773+ pass.

**Step 2: xtask tests.**

```bash
bash scripts/dev-shell.sh cargo test -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') 2>&1 | tail -5
```

Expected: 214 pass (was 211 + 3 new).

**Step 3: vitest.**

```bash
cd host && npx vitest run; cd ..
```

Expected: pass; PHP/MariaDB skip if binaries not built.

**Step 4: ABI snapshot check.**

```bash
bash scripts/dev-shell.sh bash scripts/check-abi-version.sh 2>&1 | tail -5
```

Expected: exit 0 (no ABI change).

**Step 5: If green, push and open PR.**

```bash
git push -u origin phase-b-2-f2-and-abi
gh pr create --base main \
  --title "feat: Phase B-2 — F2 sticky PR comment + kernel_abi required" \
  --body "$(cat <<'EOF'
## Summary

Phase B-2 of the decoupled-package-builds initiative. Two focused additions:

- **F2 sticky PR-comment bot (Task 1):** new \`f2-status\` job runs after \`generate-index\`, emits \`publish-status.json\` (uploaded as workflow artifact, 30-day retention), posts/edits a sticky PR comment with the per-package built/failed table. Uses \`actions/github-script@v7\` (no new external dependencies). Marker pattern keeps re-runs from spamming new comments.

- **\`kernel_abi\` required on source [build] manifests (Tasks 2-3):** backfill the field on N packages that had a \`[build]\` block but lacked \`kernel_abi\`, then tighten the parser to reject source manifests that don't declare it. Archived \`manifest.toml\` files (legacy bytes from before Phase A-bis) keep accepting absence for back-compat.

Reference: \`docs/plans/2026-05-05-decoupled-package-builds-design.md\` §3.1, §6.3.

**Force-rebuild restructure deferred to Phase C** per discussion 2026-05-06 — coupled to retiring \`manifest.json\` / \`binaries.lock\`.

## Test plan

Local (host-side fast subset):
- [x] \`cargo test -p wasm-posix-kernel --lib\` — 773+ pass
- [x] \`cargo test -p xtask\` — 214 pass (+3 new)
- [x] \`cd host && npx vitest run\` — pass
- [x] \`scripts/check-abi-version.sh\` — exit 0

CI's matrix flow on this PR is the dogfood test for the F2 status comment.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Fill in the test plan checkboxes per actual outcomes.

---

## Risks & open questions

- **`cached-skip` rows missing from F2.** B-2 only reports on entries that were in the narrowed matrix. Adding cached-skip coverage requires preflight to emit the FULL set of (pkg, arch) pairs (currently only emits the narrowed ones). Cheap workflow change but increases the surface to test. Folded into the implementation only if reviewers ask.
- **`f2-status` runs `if: always()`.** When matrix-build fails, the job still runs and posts a comment surfacing the failure. The publish + generate-index jobs may be skipped (their `if:` gates on success), so the release tag won't have new artifacts — `publish-status.json` will correctly report all matrix entries as `failed` with their `previous_sha`.
- **`previous_sha` heuristic.** The status step's "look for a previous archive for the same (pkg, arch) but a different sha" uses a simple regex. If multiple previous shas exist for the same (pkg, arch), the script picks the first one alphabetically — fine for the comment; not authoritative for resolver fallback. (The resolver in Phase C will use the actual `package.toml` value, which is the source of truth.)
- **`kernel_abi` tightening exempts no-`[build]` packages.** Six packages (kernel, userspace, examples, node, sqlite-cli, pcre2-source) don't have `[build]` and won't be required to declare `kernel_abi`. That's intentional — those packages either don't ship binaries (kernel, userspace, examples, node, sqlite-cli — tracked in `docs/package-management-future-work.md`) or are source-kind (pcre2-source). A future change that adds `[build]` to those would also need to add `kernel_abi`.
- **Archive back-compat assumption.** `validate_archived` retains lenient parsing of `kernel_abi` for the same reason it retains the deprecated `[build].script` field: archived `manifest.toml` files inside `.tar.zst` archives are immutable historical bytes. A future schema bump that needs to enforce `kernel_abi` on archived manifests would gate on ABI version (e.g., "archives at ABI ≥ 8 must declare kernel_abi"). Out of scope today.

## Notes for the executor

- **The `f2-status` shell script in Task 1 is non-trivial.** Spot-test it locally if possible by hand-constructing a fake `MATRIX` and `existing` JSON before pushing — or accept that the first CI run is the dogfood test.
- **`actions/github-script@v7`** is GHA-native, no new dependencies. The script body is plain JavaScript using the GitHub REST API client.
- **Sticky comment marker** convention: `<!-- phase-b-status -->`. Keep it stable across releases — changing the marker would orphan existing comments.
- **The 6 no-`[build]` packages** must NOT have `kernel_abi` added by Task 2's backfill. Verify the survey command excludes them.
