#!/usr/bin/env bash
#
# test-allow-stale.sh — end-to-end smoke test for the --allow-stale
# manifest source-build flow.
#
# What it covers
# --------------
# Mutates a small package's deps.toml so the locally-computed
# cache_key_sha no longer matches the pinned release manifest, then
# exercises the three entry points that were wired up in tasks 1-4:
#
#   1. strict default       — `./run.sh fetch` (no flag) MUST fail loudly
#                             with the existing cache_key_sha error.
#   2. --allow-stale flag   — `./run.sh fetch --allow-stale` MUST succeed
#                             and source-build the package into
#                             local-binaries/programs/wasm32/.
#   3. env-var path         — `WASM_POSIX_ALLOW_STALE=1 ./run.sh fetch`
#                             MUST succeed equivalently.
#
# Fixture choice
# --------------
# bzip2: smallest no-deps program in examples/libs/. ~750KB tarball,
# plain Makefile, no transitive build chain. The mutation is
# `revision = 1` → `revision = 99` (TOML integer → integer; matches the
# field's existing schema in xtask/src/deps_manifest.rs).
#
# Cleanup
# -------
# A trap restores the original deps.toml on exit (success, failure, or
# Ctrl-C). The script is idempotent — running it twice in a row should
# behave identically.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PKG=bzip2
DEPS_TOML="examples/libs/$PKG/deps.toml"
BACKUP="$DEPS_TOML.bak.allowstale-test"
EXPECTED="local-binaries/programs/wasm32/$PKG.wasm"

if [ ! -f "$DEPS_TOML" ]; then
    echo "FAIL: fixture $DEPS_TOML missing" >&2
    exit 1
fi

cleanup() {
    if [ -f "$BACKUP" ]; then
        mv "$BACKUP" "$DEPS_TOML"
        echo "smoke: restored $DEPS_TOML"
    fi
}
trap cleanup EXIT

# --- Mutate deps.toml --------------------------------------------------------
cp "$DEPS_TOML" "$BACKUP"

# Replace the integer `revision = 1` with `revision = 99`. Anchored to
# start-of-line so it never matches a `revision` mention inside a
# string or comment further down the file.
sed -i.tmp 's/^revision = .*/revision = 99/' "$DEPS_TOML"
rm -f "$DEPS_TOML.tmp"

if ! grep -q '^revision = 99$' "$DEPS_TOML"; then
    echo "FAIL: deps.toml mutation did not stick" >&2
    cat "$DEPS_TOML" >&2
    exit 1
fi
echo "smoke: forced stale manifest for $PKG (revision -> 99)"

# Wipe artifacts from any prior run. Both `local-binaries/` and the
# resolver's per-package cache directory must be cleared, otherwise the
# resolver short-circuits on a cache hit and skips the build script
# entirely — leaving `local-binaries/` stale and the assertion below
# checks a stale-but-present file. We re-wipe between modes 2 and 3 for
# the same reason. Defined as a function for reuse.
CACHE_DIR="${WASM_POSIX_CACHE_DIR:-$HOME/.cache/wasm-posix-kernel}/programs"
wipe_built_artifacts() {
    rm -f "$EXPECTED"
    if [ -d "$CACHE_DIR" ]; then
        # Match the smoke-mutation cache dir for bzip2-wasm32. The
        # rev1/wasm64 entries (untouched by this test) stay put.
        find "$CACHE_DIR" -maxdepth 1 -type d -name "${PKG}-*-wasm32-*" \
            ! -name "${PKG}-*-rev1-wasm32-*" \
            -exec rm -rf {} +
    fi
}
wipe_built_artifacts

# --- Mode 1: strict-default regression check ---------------------------------
#
# Without the flag, fetch must refuse to install bzip2 and exit
# non-zero. We only assert non-zero exit + an error message that
# mentions either "stale" or "cache_key_sha" — the exact wording lives
# in xtask/src/install_release.rs.
echo
echo "smoke: [mode 1/3] strict default — expect failure"
strict_log="$(mktemp -t allow-stale-strict.XXXXXX.log)"
set +e
./run.sh fetch >"$strict_log" 2>&1
strict_rc=$?
set -e
if [ "$strict_rc" -eq 0 ]; then
    echo "FAIL: strict ./run.sh fetch unexpectedly succeeded with stale manifest" >&2
    cat "$strict_log" >&2
    rm -f "$strict_log"
    exit 1
fi
if ! grep -E -q 'cache_key_sha|stale' "$strict_log"; then
    echo "FAIL: strict ./run.sh fetch failed but error message did not mention cache_key_sha/stale" >&2
    echo "----- log -----" >&2
    cat "$strict_log" >&2
    echo "---------------" >&2
    rm -f "$strict_log"
    exit 1
fi
echo "smoke: [mode 1/3] PASS — exit=$strict_rc, error mentions cache_key_sha/stale"
rm -f "$strict_log"

# --- Mode 2: --allow-stale flag ----------------------------------------------
echo
echo "smoke: [mode 2/3] --allow-stale flag — expect source-build"
./run.sh fetch --allow-stale
if [ ! -f "$EXPECTED" ]; then
    echo "FAIL: --allow-stale flag did not produce $EXPECTED" >&2
    exit 1
fi
echo "smoke: [mode 2/3] PASS — produced $EXPECTED"

# Wipe again so mode 3 re-runs the build script from scratch.
wipe_built_artifacts

# --- Mode 3: WASM_POSIX_ALLOW_STALE=1 env var --------------------------------
echo
echo "smoke: [mode 3/3] WASM_POSIX_ALLOW_STALE=1 — expect source-build"
WASM_POSIX_ALLOW_STALE=1 ./run.sh fetch
if [ ! -f "$EXPECTED" ]; then
    echo "FAIL: env-var path did not produce $EXPECTED" >&2
    exit 1
fi
echo "smoke: [mode 3/3] PASS — produced $EXPECTED"

echo
echo "smoke: PASS — all three modes behave correctly"
