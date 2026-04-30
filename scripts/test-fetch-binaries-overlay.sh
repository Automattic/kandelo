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

    # Durable manifest: 2 entries (libzlib, libdinit).
    local DURABLE_SHA
    write_manifest_at "$TEST_ROOT/binaries/objects" DURABLE_SHA \
        "binaries-abi-v6-2026-04-01" \
        '[
          {"name": "libzlib", "archive_name": "libzlib.tar.zst", "kind": "lib"},
          {"name": "libdinit", "archive_name": "libdinit.tar.zst", "kind": "lib"}
        ]'

    # Overlay manifest: only dinit (changed in PR).
    local OVERLAY_SHA
    write_manifest_at "$TEST_ROOT/binaries/objects" OVERLAY_SHA \
        "pr-999-staging" \
        '[
          {"name": "libdinit", "archive_name": "libdinit.tar.zst", "kind": "lib"}
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

    # Stub cargo: log invocation args, do nothing.
    STUB_BIN=$(mktemp -d -t fetch-overlay-stub.XXXXXX)
    cat > "$STUB_BIN/cargo" <<'STUB'
#!/usr/bin/env bash
echo "cargo $*" >> "$CARGO_LOG"
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

run_scenario_no_overlay
run_scenario_1
echo
echo "=== summary: $PASS pass, $FAIL fail ==="
[ "$FAIL" = "0" ]
