#!/usr/bin/env bash
#
# Fixture-driven test for scripts/fetch-binaries.sh overlay support.
#
# Strategy: build a self-contained temp REPO_ROOT containing a copy of
# fetch-binaries.sh, stub binaries.lock + binaries.lock.pr, pre-cache
# fixture manifests under binaries/objects/<sha>.json, and stub `cargo`
# on PATH so the script's `cargo run -p xtask -- install-release` calls
# are captured for assertion.
#
# Scenarios:
#   1. Overlay file on disk: assert split into durable + overlay passes.
#   2. (TODO Task 2) Auto-detect via curl shim, no overlay file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_FETCH="$SCRIPT_DIR/fetch-binaries.sh"
[ -f "$SOURCE_FETCH" ] || { echo "ERROR: $SOURCE_FETCH not found" >&2; exit 2; }

PASS=0
FAIL=0

assert_eq() {
    local name="$1" expected="$2" got="$3"
    if [ "$expected" = "$got" ]; then
        echo "  PASS: $name"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $name"
        echo "    expected: $expected"
        echo "    got:      $got"
        FAIL=$((FAIL + 1))
    fi
}

assert_contains() {
    local name="$1" haystack="$2" needle="$3"
    case "$haystack" in
        *"$needle"*)
            echo "  PASS: $name"
            PASS=$((PASS + 1))
            ;;
        *)
            echo "  FAIL: $name"
            echo "    expected to contain: $needle"
            echo "    haystack: $haystack"
            FAIL=$((FAIL + 1))
            ;;
    esac
}

setup_test_repo() {
    local TEST_ROOT="$1"
    mkdir -p "$TEST_ROOT/scripts"
    cp "$SOURCE_FETCH" "$TEST_ROOT/scripts/fetch-binaries.sh"
    chmod +x "$TEST_ROOT/scripts/fetch-binaries.sh"
    mkdir -p "$TEST_ROOT/binaries/objects"
}

# write_manifest_at <objects_dir> <sha_var_name>
# Writes a fixture manifest with two archive entries (libzlib + libdinit)
# to the given dir. Returns the sha256 in the named variable.
write_manifest_at() {
    local objects_dir="$1" sha_var="$2" tag="$3" entries="$4"
    local manifest="$objects_dir/manifest-tmp.json"
    cat > "$manifest" <<EOF
{
  "abi_version": 6,
  "release_tag": "$tag",
  "entries": $entries
}
EOF
    local sha
    sha=$(shasum -a 256 "$manifest" | awk '{print $1}')
    mv "$manifest" "$objects_dir/$sha.json"
    eval "$sha_var=$sha"
}

run_scenario_1() {
    echo "=== Scenario 1: overlay file on disk → split install ==="
    local TEST_ROOT
    TEST_ROOT=$(mktemp -d -t fetch-overlay-test.XXXXXX)
    trap 'rm -rf "$TEST_ROOT" "$STUB_BIN"' RETURN

    setup_test_repo "$TEST_ROOT"

    # Durable manifest: realistic shape (`name` is full archive
    # filename, `program` is package name). libdinit ships both
    # arches; libzlib ships wasm32 only.
    local DURABLE_SHA
    write_manifest_at "$TEST_ROOT/binaries/objects" DURABLE_SHA \
        "binaries-abi-v6-2026-04-01" \
        '[
          {"name": "libzlib-1.0-rev1-wasm32-aaaaaaaa.tar.zst",  "program": "libzlib",  "arch": "wasm32", "archive_name": "libzlib-1.0-rev1-wasm32-aaaaaaaa.tar.zst",  "kind": "library"},
          {"name": "libdinit-1.0-rev1-wasm32-bbbbbbbb.tar.zst", "program": "libdinit", "arch": "wasm32", "archive_name": "libdinit-1.0-rev1-wasm32-bbbbbbbb.tar.zst", "kind": "library"},
          {"name": "libdinit-1.0-rev1-wasm64-dddddddd.tar.zst", "program": "libdinit", "arch": "wasm64", "archive_name": "libdinit-1.0-rev1-wasm64-dddddddd.tar.zst", "kind": "library"}
        ]'

    # Overlay manifest: PR rebuilt only the wasm32 libdinit (new
    # cache_key_sha → different archive_name). The wasm64 libdinit
    # entry stays in durable's domain — the filter must match on
    # (program, arch) so wasm64 doesn't accidentally get filtered out.
    local OVERLAY_SHA
    write_manifest_at "$TEST_ROOT/binaries/objects" OVERLAY_SHA \
        "pr-999-staging" \
        '[
          {"name": "libdinit-1.0-rev1-wasm32-cccccccc.tar.zst", "program": "libdinit", "arch": "wasm32", "archive_name": "libdinit-1.0-rev1-wasm32-cccccccc.tar.zst", "kind": "library"}
        ]'

    # binaries.lock pins durable.
    cat > "$TEST_ROOT/binaries.lock" <<EOF
{
  "abi_version": 6,
  "release_tag": "binaries-abi-v6-2026-04-01",
  "manifest_sha256": "$DURABLE_SHA"
}
EOF

    # binaries.lock.pr declares libdinit as override.
    cat > "$TEST_ROOT/binaries.lock.pr" <<EOF
{
  "staging_tag": "pr-999-staging",
  "staging_manifest_sha256": "$OVERLAY_SHA",
  "overrides": ["libdinit"]
}
EOF

    # Stub cargo: log invocation args + snapshot the --manifest file's
    # contents so the test can assert on the filter result.
    STUB_BIN=$(mktemp -d -t fetch-overlay-stub.XXXXXX)
    cat > "$STUB_BIN/cargo" <<'STUB'
#!/usr/bin/env bash
echo "cargo $*" >> "$CARGO_LOG"
# Find --manifest <path> and snapshot it. Each call writes to a
# distinct snapshot.<N>.json so the test can inspect both.
MAN=""
PREV=""
for a in "$@"; do
    if [ "$PREV" = "--manifest" ]; then MAN="$a"; break; fi
    PREV="$a"
done
if [ -n "$MAN" ] && [ -f "$MAN" ]; then
    n=$(ls "$(dirname "$CARGO_LOG")"/manifest-snapshot.*.json 2>/dev/null | wc -l | tr -d ' ')
    cp "$MAN" "$(dirname "$CARGO_LOG")/manifest-snapshot.$n.json"
fi
exit 0
STUB
    chmod +x "$STUB_BIN/cargo"
    export CARGO_LOG="$TEST_ROOT/cargo.log"
    : > "$CARGO_LOG"

    # Run with the stub on PATH.
    local out
    if ! out=$(PATH="$STUB_BIN:$PATH" bash "$TEST_ROOT/scripts/fetch-binaries.sh" 2>&1); then
        # The script may exit non-zero due to xtask install path being
        # only partially invoked; we still want to inspect cargo.log.
        :
    fi

    # Read the captured cargo invocations.
    local log
    log=$(cat "$CARGO_LOG" 2>/dev/null || echo "")
    local nlines
    nlines=$(echo "$log" | grep -c "install-release" || true)
    assert_eq "two install-release invocations" "2" "$nlines"

    # Each invocation should have its own --archive-base.
    local durable_url="https://github.com/brandonpayton/wasm-posix-kernel/releases/download/binaries-abi-v6-2026-04-01"
    local overlay_url="https://github.com/brandonpayton/wasm-posix-kernel/releases/download/pr-999-staging"
    assert_contains "durable archive-base used" "$log" "$durable_url"
    assert_contains "overlay archive-base used" "$log" "$overlay_url"

    # Stdout should mention overlay setup.
    assert_contains "overlay tag log line" "$out" "overlay tag=pr-999-staging"

    # Filter contents:
    # - The original bug (PR #378) was filtering on `.name` instead
    #   of `.program`, so overrides never matched.
    # - The follow-up was filtering by program-name only — for a
    #   program with both wasm32 + wasm64 archives where staging
    #   only has wasm32, the wasm64 entry would get dropped from
    #   durable AND not be in overlay. Now filter by (program, arch).
    local durable_filt="$TEST_ROOT/manifest-snapshot.0.json"
    local overlay_filt="$TEST_ROOT/manifest-snapshot.1.json"
    if [ -f "$durable_filt" ]; then
        local durable_keys
        durable_keys=$(jq -r '[.entries[] | "\(.program)/\(.arch)"] | sort | join(",")' "$durable_filt")
        # libzlib/wasm32 stays. libdinit/wasm32 is overridden by
        # overlay → out. libdinit/wasm64 has no overlay → stays.
        assert_eq "durable_filtered keeps wasm64 of partially-overridden program" \
            "libdinit/wasm64,libzlib/wasm32" "$durable_keys"
    else
        echo "  FAIL: missing durable_filtered snapshot"; FAIL=$((FAIL + 1))
    fi
    if [ -f "$overlay_filt" ]; then
        local overlay_keys
        overlay_keys=$(jq -r '[.entries[] | "\(.program)/\(.arch)"] | sort | join(",")' "$overlay_filt")
        assert_eq "overlay manifest contents installed verbatim" \
            "libdinit/wasm32" "$overlay_keys"
    else
        echo "  FAIL: missing overlay snapshot"; FAIL=$((FAIL + 1))
    fi
}

run_scenario_no_overlay() {
    echo "=== Scenario 0: no overlay → single install pass (back-compat) ==="
    local TEST_ROOT
    TEST_ROOT=$(mktemp -d -t fetch-no-overlay-test.XXXXXX)
    trap 'rm -rf "$TEST_ROOT" "$STUB_BIN"' RETURN

    setup_test_repo "$TEST_ROOT"

    local DURABLE_SHA
    write_manifest_at "$TEST_ROOT/binaries/objects" DURABLE_SHA \
        "binaries-abi-v6-2026-04-01" \
        '[
          {"name": "libzlib", "archive_name": "libzlib.tar.zst", "kind": "lib"}
        ]'

    cat > "$TEST_ROOT/binaries.lock" <<EOF
{
  "abi_version": 6,
  "release_tag": "binaries-abi-v6-2026-04-01",
  "manifest_sha256": "$DURABLE_SHA"
}
EOF

    # No binaries.lock.pr — back-compat path.

    STUB_BIN=$(mktemp -d -t fetch-no-overlay-stub.XXXXXX)
    cat > "$STUB_BIN/cargo" <<'STUB'
#!/usr/bin/env bash
echo "cargo $*" >> "$CARGO_LOG"
exit 0
STUB
    chmod +x "$STUB_BIN/cargo"
    export CARGO_LOG="$TEST_ROOT/cargo.log"
    : > "$CARGO_LOG"

    local out
    if ! out=$(PATH="$STUB_BIN:$PATH" bash "$TEST_ROOT/scripts/fetch-binaries.sh" 2>&1); then
        :
    fi

    local nlines
    nlines=$(grep -c "install-release" "$CARGO_LOG" || true)
    assert_eq "single install-release invocation (no overlay)" "1" "$nlines"

    # No "overlay tag" log line should appear.
    case "$out" in
        *"overlay tag="*)
            echo "  FAIL: unexpected overlay log line in no-overlay scenario"
            FAIL=$((FAIL + 1))
            ;;
        *)
            echo "  PASS: no overlay log line"
            PASS=$((PASS + 1))
            ;;
    esac

    # The single call should pass MANIFEST_OBJ directly (not a temp file).
    local manifest_arg
    manifest_arg=$(grep -oE -- "--manifest [^ ]+" "$CARGO_LOG" | head -1 | awk '{print $2}')
    case "$manifest_arg" in
        */binaries/objects/*.json)
            echo "  PASS: durable manifest passed unchanged (no temp filter)"
            PASS=$((PASS + 1))
            ;;
        *)
            echo "  FAIL: expected MANIFEST_OBJ path, got $manifest_arg"
            FAIL=$((FAIL + 1))
            ;;
    esac
}

run_scenario_2_autodetect() {
    echo "=== Scenario 2: auto-detect PR + download overlay ==="
    local TEST_ROOT
    TEST_ROOT=$(mktemp -d -t fetch-autodetect-test.XXXXXX)
    trap 'rm -rf "$TEST_ROOT" "$STUB_BIN" "$FIXTURE_DIR"' RETURN

    setup_test_repo "$TEST_ROOT"

    # Make TEST_ROOT a git repo with a fake origin.
    (
        cd "$TEST_ROOT"
        git init -q
        git config user.email "test@example.com"
        git config user.name "Test"
        git remote add origin https://github.com/fakeowner/fakerepo.git
        # Need at least one commit for HEAD to resolve.
        echo "test" > README.txt
        git add README.txt
        git commit -q -m "initial"
    )

    # Durable manifest.
    local DURABLE_SHA
    write_manifest_at "$TEST_ROOT/binaries/objects" DURABLE_SHA \
        "binaries-abi-v6-2026-04-01" \
        '[
          {"name": "libzlib", "archive_name": "libzlib.tar.zst", "kind": "lib"},
          {"name": "libdinit", "archive_name": "libdinit.tar.zst", "kind": "lib"}
        ]'

    # Overlay manifest (will be served by curl shim).
    FIXTURE_DIR=$(mktemp -d -t fetch-autodetect-fixtures.XXXXXX)
    local OVERLAY_TMP="$FIXTURE_DIR/overlay-manifest.json"
    cat > "$OVERLAY_TMP" <<EOF
{
  "abi_version": 6,
  "release_tag": "pr-42-staging",
  "entries": [
    {"name": "libdinit", "archive_name": "libdinit.tar.zst", "kind": "lib"}
  ]
}
EOF
    local OVERLAY_SHA
    OVERLAY_SHA=$(shasum -a 256 "$OVERLAY_TMP" | awk '{print $1}')
    # Pre-cache it locally so ensure_object hits the cache for the
    # overlay manifest (we only need to test the download of
    # binaries.lock.pr itself, not the manifest).
    cp "$OVERLAY_TMP" "$TEST_ROOT/binaries/objects/$OVERLAY_SHA.json"

    # binaries.lock pins durable.
    cat > "$TEST_ROOT/binaries.lock" <<EOF
{
  "abi_version": 6,
  "release_tag": "binaries-abi-v6-2026-04-01",
  "manifest_sha256": "$DURABLE_SHA"
}
EOF

    # Fixture overlay file the curl shim will return.
    cat > "$FIXTURE_DIR/binaries.lock.pr" <<EOF
{
  "staging_tag": "pr-42-staging",
  "staging_manifest_sha256": "$OVERLAY_SHA",
  "overrides": ["libdinit"]
}
EOF

    # Fixture pulls.json for /repos/fakeowner/fakerepo/commits/<sha>/pulls.
    cat > "$FIXTURE_DIR/pulls.json" <<EOF
[{"number": 42, "state": "open"}]
EOF

    STUB_BIN=$(mktemp -d -t fetch-autodetect-stub.XXXXXX)

    # curl stub: serve fixtures based on URL pattern. Fall through to
    # real curl for any URL we don't recognize (so the prereq check
    # finds curl works). We pass FIXTURE_DIR via env.
    cat > "$STUB_BIN/curl" <<STUB
#!/usr/bin/env bash
# Capture URL (last arg).
url=""
for arg in "\$@"; do url="\$arg"; done
case "\$url" in
    *api.github.com/repos/fakeowner/fakerepo/commits/*/pulls*)
        # Find the -o flag if present.
        out=""
        prev=""
        for a in "\$@"; do
            if [ "\$prev" = "-o" ]; then out="\$a"; fi
            prev="\$a"
        done
        if [ -n "\$out" ]; then
            cp "$FIXTURE_DIR/pulls.json" "\$out"
        else
            cat "$FIXTURE_DIR/pulls.json"
        fi
        exit 0
        ;;
    *github.com/fakeowner/fakerepo/releases/download/pr-42-staging/binaries.lock.pr*)
        out=""
        prev=""
        for a in "\$@"; do
            if [ "\$prev" = "-o" ]; then out="\$a"; fi
            prev="\$a"
        done
        if [ -n "\$out" ]; then
            cp "$FIXTURE_DIR/binaries.lock.pr" "\$out"
        else
            cat "$FIXTURE_DIR/binaries.lock.pr"
        fi
        exit 0
        ;;
    *)
        echo "curl stub: unhandled URL: \$url" >&2
        exit 22
        ;;
esac
STUB
    chmod +x "$STUB_BIN/curl"

    cat > "$STUB_BIN/cargo" <<'STUB'
#!/usr/bin/env bash
echo "cargo $*" >> "$CARGO_LOG"
exit 0
STUB
    chmod +x "$STUB_BIN/cargo"

    # Stub gh: force the curl-fallback path. Without this, the script
    # would prefer real `gh api` and hit the real GitHub API for the
    # fake owner/repo, which 404s.
    cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
# Make `gh auth status` fail so the script falls back to curl.
exit 1
STUB
    chmod +x "$STUB_BIN/gh"

    export CARGO_LOG="$TEST_ROOT/cargo.log"
    : > "$CARGO_LOG"

    local out
    if ! out=$(PATH="$STUB_BIN:$PATH" bash "$TEST_ROOT/scripts/fetch-binaries.sh" 2>&1); then
        :
    fi

    assert_contains "PR detected log line" "$out" "detected PR #42"
    assert_contains "downloaded overlay log line" "$out" "downloading overlay from pr-42-staging"
    assert_contains "overlay tag log line" "$out" "overlay tag=pr-42-staging"

    # Two install-release calls (durable + overlay).
    local nlines
    nlines=$(grep -c "install-release" "$CARGO_LOG" || true)
    assert_eq "two install-release invocations after auto-detect" "2" "$nlines"
}

run_scenario_abi_bump_in_flight() {
    echo "=== Scenario 3: consumer ABI ahead of lock ABI → skip archive install ==="
    local TEST_ROOT
    TEST_ROOT=$(mktemp -d -t fetch-abi-bump-test.XXXXXX)
    trap 'rm -rf "$TEST_ROOT" "$STUB_BIN"' RETURN

    setup_test_repo "$TEST_ROOT"

    # Durable manifest at ABI 6 (the lockfile's pinned generation).
    local DURABLE_SHA
    write_manifest_at "$TEST_ROOT/binaries/objects" DURABLE_SHA \
        "binaries-abi-v6-2026-04-01" \
        '[
          {"name": "libzlib", "archive_name": "libzlib.tar.zst", "kind": "lib"}
        ]'

    cat > "$TEST_ROOT/binaries.lock" <<EOF
{
  "abi_version": 6,
  "release_tag": "binaries-abi-v6-2026-04-01",
  "manifest_sha256": "$DURABLE_SHA"
}
EOF

    # Consumer's source-of-truth ABI: bumped to 7 (ABI bump in flight).
    mkdir -p "$TEST_ROOT/glue"
    cat > "$TEST_ROOT/glue/abi_constants.h" <<'EOF'
#define WASM_POSIX_ABI_VERSION 7u
EOF

    STUB_BIN=$(mktemp -d -t fetch-abi-bump-stub.XXXXXX)
    cat > "$STUB_BIN/cargo" <<'STUB'
#!/usr/bin/env bash
echo "cargo $*" >> "$CARGO_LOG"
exit 0
STUB
    chmod +x "$STUB_BIN/cargo"
    export CARGO_LOG="$TEST_ROOT/cargo.log"
    : > "$CARGO_LOG"

    local out rc
    set +e
    out=$(PATH="$STUB_BIN:$PATH" bash "$TEST_ROOT/scripts/fetch-binaries.sh" 2>&1)
    rc=$?
    set -e

    # Skip is informational, not fatal — fetch-binaries must still exit 0
    # so the staging-build workflow proceeds to source-build.
    assert_eq "fetch-binaries exits 0 during ABI bump" "0" "$rc"

    # The skip log line names both ABIs so the operator sees the mismatch.
    assert_contains "log mentions consumer abi=7 != lock abi=6" \
        "$out" "consumer abi=7 != lock abi=6"
    assert_contains "log explains durable skip + source-build follow-up" \
        "$out" "skipping durable archive install"

    # install-release MUST NOT be invoked for the durable manifest: the
    # strict check inside it would correctly fail every per-entry
    # compatibility check (manifest cache_key_sha computed against ABI 6,
    # consumer at ABI 7). With no overlay in this scenario, install-release
    # isn't called at all.
    local nlines
    nlines=$(grep -c "install-release" "$CARGO_LOG" || true)
    assert_eq "no install-release invocation under ABI mismatch (no overlay)" "0" "$nlines"
}

run_scenario_abi_bump_with_overlay() {
    echo "=== Scenario 4: consumer ABI ahead, overlay at consumer ABI → overlay still installs ==="
    # Models the prepare-merge workflow on an ABI-bump PR: the staging
    # build successfully published a pr-<N>-staging release with archives
    # at the new ABI, but the durable lockfile still pins the old
    # generation. The durable install must skip; the overlay install
    # must proceed (its archives are at the consumer's ABI and pass
    # install-release's strict per-entry checks).
    local TEST_ROOT
    TEST_ROOT=$(mktemp -d -t fetch-abi-bump-overlay-test.XXXXXX)
    trap 'rm -rf "$TEST_ROOT" "$STUB_BIN"' RETURN

    setup_test_repo "$TEST_ROOT"

    # Durable manifest at ABI 6 (lockfile's pinned generation).
    local DURABLE_SHA
    write_manifest_at "$TEST_ROOT/binaries/objects" DURABLE_SHA \
        "binaries-abi-v6-2026-04-01" \
        '[
          {"name": "libzlib", "archive_name": "libzlib.tar.zst", "kind": "lib"}
        ]'

    # Overlay manifest at ABI 7 (the consumer's ABI; built by staging).
    # `write_manifest_at` hardcodes abi_version: 6, so write the v7
    # overlay manifest by hand to override.
    local OVERLAY_TMP="$TEST_ROOT/binaries/objects/overlay-tmp.json"
    cat > "$OVERLAY_TMP" <<'EOF'
{
  "abi_version": 7,
  "release_tag": "pr-999-staging",
  "entries": [
    {"name": "libdinit-1.0-rev1-wasm32-cccccccc.tar.zst", "program": "libdinit", "arch": "wasm32", "archive_name": "libdinit-1.0-rev1-wasm32-cccccccc.tar.zst", "kind": "library"}
  ]
}
EOF
    local OVERLAY_SHA
    OVERLAY_SHA=$(shasum -a 256 "$OVERLAY_TMP" | awk '{print $1}')
    mv "$OVERLAY_TMP" "$TEST_ROOT/binaries/objects/$OVERLAY_SHA.json"

    cat > "$TEST_ROOT/binaries.lock" <<EOF
{
  "abi_version": 6,
  "release_tag": "binaries-abi-v6-2026-04-01",
  "manifest_sha256": "$DURABLE_SHA"
}
EOF
    cat > "$TEST_ROOT/binaries.lock.pr" <<EOF
{
  "staging_tag": "pr-999-staging",
  "staging_manifest_sha256": "$OVERLAY_SHA",
  "overrides": ["libdinit"]
}
EOF
    mkdir -p "$TEST_ROOT/glue"
    cat > "$TEST_ROOT/glue/abi_constants.h" <<'EOF'
#define WASM_POSIX_ABI_VERSION 7u
EOF

    STUB_BIN=$(mktemp -d -t fetch-abi-bump-overlay-stub.XXXXXX)
    cat > "$STUB_BIN/cargo" <<'STUB'
#!/usr/bin/env bash
echo "cargo $*" >> "$CARGO_LOG"
exit 0
STUB
    chmod +x "$STUB_BIN/cargo"
    export CARGO_LOG="$TEST_ROOT/cargo.log"
    : > "$CARGO_LOG"

    local out rc
    set +e
    out=$(PATH="$STUB_BIN:$PATH" bash "$TEST_ROOT/scripts/fetch-binaries.sh" 2>&1)
    rc=$?
    set -e

    assert_eq "fetch-binaries exits 0 with v7 overlay on v6 lockfile" "0" "$rc"

    # The early sanity check now compares overlay against CONSUMER, not
    # LOCK. v7 overlay against v7 consumer must pass.
    case "$out" in
        *"overlay manifest abi="*"!= "*)
            echo "  FAIL: spurious overlay-vs-lock ABI mismatch error"
            echo "    log: $out"
            FAIL=$((FAIL + 1))
            ;;
        *)
            echo "  PASS: overlay sanity check accepts v7 overlay vs v7 consumer"
            PASS=$((PASS + 1))
            ;;
    esac

    # Durable install skipped (consumer != lock).
    assert_contains "durable install skip is logged" \
        "$out" "skipping durable archive install"

    # Overlay install runs — exactly one install-release invocation.
    local nlines overlay_call
    nlines=$(grep -c "install-release" "$CARGO_LOG" || true)
    assert_eq "exactly one install-release (overlay only)" "1" "$nlines"
    overlay_call=$(grep "install-release" "$CARGO_LOG" | head -1)
    case "$overlay_call" in
        *"$OVERLAY_SHA"*)
            echo "  PASS: overlay manifest installed (matched by sha)"
            PASS=$((PASS + 1))
            ;;
        *)
            echo "  FAIL: install-release invoked with wrong manifest"
            echo "    expected sha: $OVERLAY_SHA"
            echo "    cargo call:   $overlay_call"
            FAIL=$((FAIL + 1))
            ;;
    esac
}

run_scenario_no_overlay
run_scenario_1
run_scenario_2_autodetect
run_scenario_abi_bump_in_flight
run_scenario_abi_bump_with_overlay
echo
echo "=== summary: $PASS pass, $FAIL fail ==="
[ "$FAIL" = "0" ]
