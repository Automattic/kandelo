#!/usr/bin/env bash
#
# prepare-vitest-fixtures.sh — deterministic bootstrap for the host
# vitest full gate (`cd host && npx vitest run`).
#
# WHY THIS EXISTS
# ---------------
# The host vitest gate needs two build artifacts that its own
# `globalSetup` does NOT produce:
#
#   * host/wasm/rootfs.vfs                    (getpwent + node-host-mounts tests)
#   * local-binaries/programs/wasm64/hello64.wasm  (wasm64 tests)
#
# Producing them requires the SDK cross-toolchain plus the wasm32/wasm64
# sysroots and the kernel. In a fresh Homebrew package worktree two things
# used to go wrong, both reported ambiguously:
#
#   1. Running the bootstrap OUTSIDE `scripts/dev-shell.sh` fails because
#      the SDK cross-compiler (wasm32posix-cc) and even the host Rust
#      linker toolchain are not on PATH. The user saw a wall of Rust
#      "tool 'clang' not found" linker errors instead of "run me in the
#      dev shell".
#   2. Running it inside the dev shell hit release-cache mismatches
#      (a published archive whose cache_key_sha drifted from the current
#      recipe). The resolver silently fell through to a source build with
#      only an easy-to-miss stderr `warning:` line, so a cache miss looked
#      the same as a real failure.
#
# WHAT THIS SCRIPT GUARANTEES
# ---------------------------
#   * A single documented dev-shell command sequence (see docs below).
#   * Tool preflight that names the MISSING TOOL and how to fix it, kept
#     distinct from release-cache misses.
#   * An explicit per-package classification of each rootfs input as a
#     release-cache HIT (fetched published archive) vs MISS (will source
#     build), so "forced source builds" are named and expected, never
#     ambiguous.
#   * Durable passed/failed/skipped outcome-list artifacts for every
#     bootstrap step.
#
# USAGE
#   bash scripts/dev-shell.sh bash scripts/prepare-vitest-fixtures.sh
#   bash scripts/dev-shell.sh bash scripts/prepare-vitest-fixtures.sh --classify-only
#   bash scripts/dev-shell.sh bash scripts/prepare-vitest-fixtures.sh --result-dir test-runs/my-run
#
# FLAGS
#   --classify-only   Run tool preflight + release-cache classification and
#                     emit outcome lists, but do NOT build sysroots/kernel/
#                     rootfs/programs. A fast "is my environment ready and
#                     what will source-build?" pre-check.
#   --result-dir DIR  Where to write outcome-list artifacts.
#                     Default: test-runs/vitest-fixtures
#   -h | --help       Print this header.
#
# EXIT CODES
#   0  fixtures ready (or --classify-only completed with no missing tools)
#   2  bad arguments
#   3  a required tool is missing (distinct from any cache miss)
#   1  a build/resolve step failed (see the failed outcome list)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RESULT_DIR="test-runs/vitest-fixtures"
CLASSIFY_ONLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --classify-only) CLASSIFY_ONLY=1; shift ;;
        --result-dir)    RESULT_DIR="${2:?--result-dir needs a path}"; shift 2 ;;
        -h|--help)       sed -n '2,64p' "$0"; exit 0 ;;
        *) echo "prepare-vitest-fixtures: unknown arg $1" >&2; exit 2 ;;
    esac
done

# Absolute-ize the result dir before any `cd`.
mkdir -p "$RESULT_DIR/outcome-lists"
RESULT_DIR="$(cd "$RESULT_DIR" && pwd)"
OUTCOME_DIR="$RESULT_DIR/outcome-lists"
PASSED_TSV="$OUTCOME_DIR/passed-steps.tsv"
FAILED_TSV="$OUTCOME_DIR/failed-steps.tsv"
SKIPPED_TSV="$OUTCOME_DIR/skipped-steps.tsv"
SUMMARY_MD="$RESULT_DIR/fixture-bootstrap-summary.md"

printf 'step\tdetail\n' >"$PASSED_TSV"
printf 'step\tdetail\n' >"$FAILED_TSV"
printf 'step\treason\n' >"$SKIPPED_TSV"

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
info() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s○%s %s\n' "$YELLOW" "$RESET" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }

record_pass() { printf '%s\t%s\n' "$1" "$2" >>"$PASSED_TSV"; ok "$1 — $2"; }
record_fail() { printf '%s\t%s\n' "$1" "$2" >>"$FAILED_TSV"; bad "$1 — $2"; }
record_skip() { printf '%s\t%s\n' "$1" "$2" >>"$SKIPPED_TSV"; warn "$1 — $2 (skipped)"; }

HOST_TARGET="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}' || true)"

# ── Fixture presence checks (mirror run.sh has_* semantics) ────────────────
have_sysroot()   { [ -f "$REPO_ROOT/sysroot/lib/libc.a" ]; }
have_sysroot64() { [ -f "$REPO_ROOT/sysroot64/lib/libc.a" ]; }
have_kernel()    { [ -f "$REPO_ROOT/local-binaries/kernel.wasm" ] || [ -f "$REPO_ROOT/host/wasm/kandelo-kernel.wasm" ]; }
have_rootfs()    { [ -f "$REPO_ROOT/host/wasm/rootfs.vfs" ]; }
have_hello64()   { [ -f "$REPO_ROOT/local-binaries/programs/wasm64/hello64.wasm" ]; }

# ── 1. Tool preflight (missing tool ≠ cache miss) ──────────────────────────
#
# Two tiers: host tools (cargo/rustc/node/npx) that also exist outside the
# dev shell, and SDK cross-toolchain tools (wasm32posix-cc/wasm-opt/wat2wasm)
# that only exist inside `scripts/dev-shell.sh`. A missing SDK tool is the
# signature of "not in the dev shell", so we say exactly that.
preflight_tools() {
    info "Tool preflight"
    local missing=0

    local host_tools=(cargo rustc node npx)
    for t in "${host_tools[@]}"; do
        if command -v "$t" >/dev/null 2>&1; then
            record_pass "tool:$t" "found at $(command -v "$t")"
        else
            record_fail "tool:$t" "missing host tool: install $t and re-run"
            missing=1
        fi
    done

    local sdk_tools=(wasm32posix-cc wasm-opt wat2wasm)
    for t in "${sdk_tools[@]}"; do
        if command -v "$t" >/dev/null 2>&1; then
            record_pass "tool:$t" "found at $(command -v "$t")"
        else
            record_fail "tool:$t" "missing SDK cross-toolchain tool — run inside scripts/dev-shell.sh"
            missing=1
        fi
    done

    if [ -z "$HOST_TARGET" ]; then
        record_fail "tool:rustc-host" "rustc -vV did not report a host triple"
        missing=1
    fi

    if [ "$missing" != "0" ]; then
        echo >&2
        bad "Required tools are missing. This is a MISSING-TOOL failure, not a release-cache miss."
        bad "Run the bootstrap inside the Kandelo dev shell:"
        bad "    bash scripts/dev-shell.sh bash scripts/prepare-vitest-fixtures.sh"
        write_summary "missing-tool"
        exit 3
    fi
}

# ── 2. musl submodule (build-musl.sh needs it) ─────────────────────────────
ensure_musl_submodule() {
    if [ -f "$REPO_ROOT/libc/musl/Makefile" ]; then
        record_skip "submodule:libc/musl" "already checked out"
        return
    fi
    info "Initializing libc/musl submodule"
    if git -C "$REPO_ROOT" submodule update --init libc/musl >/dev/null 2>&1; then
        record_pass "submodule:libc/musl" "initialized"
    else
        record_fail "submodule:libc/musl" "git submodule update --init libc/musl failed (network?)"
        write_summary "submodule-failed"
        exit 1
    fi
}

# ── 3. Release-cache classification (HIT vs MISS, never ambiguous) ──────────
#
# For each rootfs input package, probe the resolver in --fetch-only mode.
# --fetch-only refuses the source-build fallback, so a zero exit means the
# published archive fetched+validated (HIT) and a non-zero exit means a
# release-cache MISS or cache_key drift (a source build would be required).
# We report the classification explicitly so a "forced source build" is a
# named, expected outcome rather than a silent stderr warning.
ROOTFS_PACKAGES_TOML="images/rootfs/PACKAGES.toml"
CACHE_MISSES=()

rootfs_package_names() {
    awk '
        /^\[\[packages\]\]/ { in_pkg = 1; next }
        /^\[/ { in_pkg = 0; next }
        in_pkg && /^name[[:space:]]*=/ {
            line = $0
            sub(/^[^=]*=[[:space:]]*/, "", line)
            gsub(/["[:space:]]/, "", line)
            if (line != "" && !seen[line]++) print line
        }
    ' "$ROOTFS_PACKAGES_TOML"
}

classify_release_cache() {
    info "Release-cache classification (rootfs inputs, wasm32)"
    if [ ! -f "$ROOTFS_PACKAGES_TOML" ]; then
        record_fail "classify:rootfs-packages" "missing $ROOTFS_PACKAGES_TOML"
        return
    fi
    local pkg
    while IFS= read -r pkg; do
        [ -n "$pkg" ] || continue
        if cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
                build-deps --arch wasm32 --binaries-dir "$REPO_ROOT/binaries" \
                resolve "$pkg" --fetch-only >/dev/null 2>&1; then
            record_pass "classify:$pkg" "release-cache HIT (published wasm32 archive fetched)"
        else
            record_skip "classify:$pkg" "release-cache MISS/drift — a source build is required for wasm32"
            CACHE_MISSES+=("$pkg")
        fi
    done < <(rootfs_package_names)

    if [ "${#CACHE_MISSES[@]}" -gt 0 ]; then
        info "Release-cache misses (${#CACHE_MISSES[@]}): ${CACHE_MISSES[*]}"
        info "These will be source-built during the rootfs step (expected, not an error)."
    fi
}

# ── 4. Build steps (idempotent; each recorded) ─────────────────────────────
run_step() { # run_step <step-name> <human-desc> <cmd...>
    local step="$1"; local desc="$2"; shift 2
    info "$desc"
    local log="$OUTCOME_DIR/${step//[:\/]/_}.log"
    if "$@" >"$log" 2>&1; then
        record_pass "$step" "$desc (log: ${log#"$REPO_ROOT"/})"
    else
        record_fail "$step" "$desc FAILED (log: ${log#"$REPO_ROOT"/})"
        write_summary "step-failed:$step"
        exit 1
    fi
}

build_fixtures() {
    # wasm32 sysroot
    if have_sysroot; then record_skip "build:sysroot" "sysroot/lib/libc.a already present"
    else run_step "build:sysroot" "Building wasm32 sysroot (build-musl.sh)" \
            bash "$REPO_ROOT/scripts/build-musl.sh"; fi

    # wasm64 sysroot (needed for hello64)
    if have_sysroot64; then record_skip "build:sysroot64" "sysroot64/lib/libc.a already present"
    else run_step "build:sysroot64" "Building wasm64 sysroot (build-musl.sh --arch wasm64posix)" \
            bash "$REPO_ROOT/scripts/build-musl.sh" --arch wasm64posix; fi

    # kernel (host tests spawn it)
    if have_kernel; then record_skip "build:kernel" "local-binaries/kernel.wasm already present"
    else run_step "build:kernel" "Building kernel (build-kernel.sh)" \
            bash "$REPO_ROOT/packages/registry/kernel/build-kernel.sh"; fi

    # C test programs + wasm64 hello64 fixture
    if have_hello64; then record_skip "build:programs" "programs/wasm64/hello64.wasm already present"
    else run_step "build:programs" "Building programs incl. wasm64 hello64 (build-programs.sh)" \
            bash "$REPO_ROOT/scripts/build-programs.sh"; fi

    if have_hello64; then
        record_pass "fixture:hello64" "local-binaries/programs/wasm64/hello64.wasm"
    else
        record_fail "fixture:hello64" "programs/wasm64/hello64.wasm missing after build-programs.sh (sysroot64 built?)"
    fi

    # rootfs.vfs — build-rootfs.sh re-resolves the rootfs inputs. That pass
    # is fast and unambiguous here: the classification step above already
    # populated the resolver cache/binaries dir (every input was reported as
    # a HIT, or named as a MISS and source-built), so no silent release-cache
    # surprise remains for the builder to hit.
    if have_rootfs; then
        record_skip "build:rootfs" "host/wasm/rootfs.vfs already present"
    else
        run_step "build:rootfs" "Building host/wasm/rootfs.vfs (build-rootfs.sh)" \
            bash "$REPO_ROOT/scripts/build-rootfs.sh"
    fi

    if have_rootfs; then
        record_pass "fixture:rootfs.vfs" "host/wasm/rootfs.vfs"
    else
        record_fail "fixture:rootfs.vfs" "host/wasm/rootfs.vfs missing after build-rootfs.sh"
    fi
}

write_summary() {
    local status="$1"
    local n_pass n_fail n_skip
    n_pass=$(($(wc -l <"$PASSED_TSV") - 1))
    n_fail=$(($(wc -l <"$FAILED_TSV") - 1))
    n_skip=$(($(wc -l <"$SKIPPED_TSV") - 1))
    {
        echo "# Host vitest fixture bootstrap"
        echo
        echo "- generated by: scripts/prepare-vitest-fixtures.sh"
        echo "- final status: $status"
        echo "- passed: $n_pass, failed: $n_fail, skipped: $n_skip"
        echo
        echo "## Expected fixture paths"
        echo "- host/wasm/rootfs.vfs"
        echo "- local-binaries/programs/wasm64/hello64.wasm"
        echo
        echo "Outcome lists: outcome-lists/{passed,failed,skipped}-steps.tsv"
    } >"$SUMMARY_MD"
    info "Wrote $SUMMARY_MD (passed=$n_pass failed=$n_fail skipped=$n_skip)"
}

# ── Orchestration ──────────────────────────────────────────────────────────
preflight_tools
ensure_musl_submodule
classify_release_cache

if [ "$CLASSIFY_ONLY" = "1" ]; then
    write_summary "classify-only"
    info "Classification complete (--classify-only); skipped fixture builds."
    exit 0
fi

build_fixtures
write_summary "ready"
info "Host vitest fixtures ready. Run: bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest"
