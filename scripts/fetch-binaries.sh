#!/usr/bin/env bash
#
# Fetch published Wasm binaries by walking every package under
# `packages/registry/<name>/` that has both package.toml and build.toml.
#
# The resolver consumes the central binary index configured by
# `WASM_POSIX_BINARY_INDEX_URL`. For each package that has a
# publishable build source (`build.toml`) we run
#
#     cargo run -p xtask -- build-deps resolve <name> \
#         --arch <arch> --binaries-dir <repo>/binaries
#
# which (a) fetches+verifies the archive into the resolver's
# content-addressed cache (~/.cache/kandelo/...), and (b)
# places `binaries/programs/<arch>/<output>.wasm` symlinks pointing
# into the cache. Browser demos hardcode these paths.
#
# Packages without `build.toml` (kind=source, manifest-only entries,
# libraries that ship only as link-time inputs) are skipped here.
# Kernel and userspace now have build.toml entries, so published
# release indexes can populate `binaries/kernel.wasm` and
# `binaries/userspace.wasm` for fresh checkouts and npm package
# preparation.
#
# Per-arch handling: read the optional `arches = ["wasm32", ...]`
# field from each package.toml. Default is `["wasm32"]`. For each
# declared arch we invoke `resolve --arch <arch>` once.
#
# Resolver fallback semantics: if an archive is unreachable, hash-
# mismatched, or has a stale `cache_key_sha`, `resolve` logs a
# warning and falls through to a source build. A source build that
# also fails surfaces as a non-zero exit; we collect the failures
# and report them at the end so one stuck package doesn't block the
# others.
#
# Flags:
#   --package <name>
#                  Materialize only this package root. Repeat the flag to
#                  select more than one root. The resolver still materializes
#                  each selected root's declared dependency closure. Repeated
#                  names are de-duplicated in first-requested order. With no
#                  --package flags, the existing full-registry walk is used.
#   --offline      Set `WASM_POSIX_OFFLINE=1` so the resolver refuses
#                  to hit the network. (No-op if every archive is
#                  already in the cache.)
#   --pr <N>       Force PR overlay handling. With Phase C the overlay
#                  lives at `packages/registry/<name>/package.pr.toml`,
#                  one file per package. The fetcher does NOT install
#                  overlays itself — that's Task 4's CI job. This
#                  flag is reserved for future use; today it warns
#                  and is otherwise a no-op.
#   --allow-stale  Accept partial fetch. The resolver already falls
#                  through to a source build on any verification
#                  failure (so individual archive-fetch failures are
#                  invisible), but a follow-up source build can also
#                  fail (e.g., a meta-package whose script reads a
#                  sibling source tree that hasn't been populated this
#                  run). Without --allow-stale, any per-package
#                  resolve failure exits 1 and aborts CI. With it,
#                  failures degrade to warnings and the script exits 0
#                  if any packages succeeded — matching the legacy
#                  behavior where a stale-but-present cache was usable
#                  even when the release was incomplete. CI callers
#                  rely on this: the matrix target's build runs in a
#                  later step and fails loudly if its actual deps are
#                  missing.
#   --fetch-only   Refuse resolver source-build fallback. CI
#                  materialization uses this after staging has had a
#                  chance to publish drifted package archives; stale or
#                  missing archives fail fast instead of compiling in
#                  the test gate.
#   -h / --help    Print this header.
#
# Env:
#   WASM_POSIX_BINARY_INDEX_URL
#                  Overrides every package's build.toml `[binary].index_url`.
#                  For PR staging, prefer invoking through
#                  `./run.sh --pr-staging fetch` so run.sh can discover
#                  and verify the current PR's staging index first.
#   WASM_POSIX_FETCH_SKIP_PKGS
#                  Space-separated package names to skip entirely.
#                  CI uses this for packages temporarily disabled from
#                  staging/prepare matrices so test-gate does not
#                  source-build them while materializing binaries.
#
# Exit codes:
#   0  every package resolved successfully (archive fetched OR
#      source-built fallback succeeded).
#   1  one or more packages failed to resolve; failure list is
#      printed to stderr.
#   2  bad arguments / missing prerequisite tool.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OFFLINE=0
PR_NUMBER=""
ALLOW_STALE=0
FETCH_ONLY=0
SKIP_PKGS=" ${WASM_POSIX_FETCH_SKIP_PKGS:-} "
SELECTED_PKGS=()

add_selected_package() {
    local pkg="$1"
    if [[ ! "$pkg" =~ ^[a-z0-9][a-z0-9._+-]*$ ]]; then
        echo "fetch-binaries: --package requires a safe non-empty package name, got '$pkg'" >&2
        exit 2
    fi
    local selected
    for selected in "${SELECTED_PKGS[@]}"; do
        [ "$selected" = "$pkg" ] && return 0
    done
    SELECTED_PKGS+=("$pkg")
}

while [ $# -gt 0 ]; do
    case "$1" in
        --package)
            [ $# -ge 2 ] || {
                echo "fetch-binaries: --package requires a package name" >&2
                exit 2
            }
            add_selected_package "$2"
            shift 2
            ;;
        --package=*)
            add_selected_package "${1#--package=}"
            shift
            ;;
        --offline)     OFFLINE=1; shift ;;
        --pr)          PR_NUMBER="$2"; shift 2 ;;
        --allow-stale) ALLOW_STALE=1; shift ;;
        --fetch-only)  FETCH_ONLY=1; shift ;;
        # Phase C deprecates --force / --prune: the resolver cache
        # is content-addressed (a different archive_url ⇒ a different
        # canonical path) so neither flag has a meaningful action.
        # Accept-and-ignore for transition; warn so callers update.
        --force)       echo "fetch-binaries: --force is now a no-op (cache is content-addressed); ignoring" >&2; shift ;;
        --prune)       echo "fetch-binaries: --prune is now a no-op (cache GC is the resolver's job); ignoring" >&2; shift ;;
        -h|--help)
            sed -n '3,90p' "$0"
            exit 0
            ;;
        *) echo "fetch-binaries: unknown arg $1" >&2; exit 2 ;;
    esac
done

# --- Prerequisites --------------------------------------------------------
for tool in cargo rustc; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "fetch-binaries: $tool not found on PATH" >&2
        exit 2
    }
done

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
[ -n "$HOST_TARGET" ] || { echo "fetch-binaries: rustc -vV did not report host triple" >&2; exit 2; }

# The resolver source-builds on any release-cache miss / cache_key drift, and
# a source build needs the SDK cross-toolchain (wasm32posix-cc). Outside
# scripts/dev-shell.sh that toolchain is absent, so a miss fails with opaque
# compiler/linker errors that look nothing like a cache miss. Warn up front so
# a MISSING TOOL is not mistaken for a release-cache problem. Non-fatal:
# published archives can still be fetched when every package is a cache hit.
if ! command -v wasm32posix-cc >/dev/null 2>&1; then
    echo "fetch-binaries: WARN wasm32posix-cc (SDK cross-toolchain) is not on PATH." >&2
    echo "fetch-binaries: WARN published archives can still be fetched, but any release-cache" >&2
    echo "fetch-binaries: WARN miss/drift falls back to a SOURCE BUILD that will fail without it." >&2
    echo "fetch-binaries: WARN for source builds, run inside the dev shell:" >&2
    echo "fetch-binaries: WARN   bash scripts/dev-shell.sh bash scripts/fetch-binaries.sh" >&2
fi

if [ "$ALLOW_STALE" = "1" ]; then
    # The resolver source-builds automatically on archive verification
    # failure (tools/xtask/src/build_deps.rs cmd_resolve fallback: any
    # remote_fetch error logs a warning and falls through to
    # build_into_cache). --allow-stale also degrades any per-package
    # resolve FAILURE to a warning so a meta-package whose source
    # build is broken on this runner doesn't abort CI when the matrix
    # target itself builds fine. See the header for full semantics.
    echo "fetch-binaries: --allow-stale accepted (per-package failures degrade to warnings)"
fi
if [ "$FETCH_ONLY" = "1" ]; then
    echo "fetch-binaries: --fetch-only enabled (stale/missing archives will not source-build)"
fi

if [ -n "$PR_NUMBER" ]; then
    # Phase C overlays are per-package `package.pr.toml` files, written
    # by the staging-build CI workflow into the PR's working tree (not
    # downloaded post-hoc by this script). Surface a clear note rather
    # than silently lying about applying the overlay.
    echo "fetch-binaries: --pr $PR_NUMBER ignored — Phase C overlays are per-package package.pr.toml files installed by CI" >&2
fi

# Propagate --offline into the resolver via env (xtask reads
# WASM_POSIX_OFFLINE; absent ⇒ default to online).
if [ "$OFFLINE" = "1" ]; then
    export WASM_POSIX_OFFLINE=1
fi

# --- Walk packages and resolve each --------------------------------------
LIBS_DIR="$REPO_ROOT/packages/registry"
[ -d "$LIBS_DIR" ] || { echo "fetch-binaries: $LIBS_DIR not found" >&2; exit 2; }

PACKAGE_DIRS=()
if [ ${#SELECTED_PKGS[@]} -gt 0 ]; then
    for pkg in "${SELECTED_PKGS[@]}"; do
        pkg_dir="$LIBS_DIR/$pkg"
        if [ ! -f "$pkg_dir/package.toml" ]; then
            echo "fetch-binaries: selected package '$pkg' does not exist" >&2
            exit 2
        fi
        if [ ! -f "$pkg_dir/build.toml" ]; then
            echo "fetch-binaries: selected package '$pkg' has no publishable build.toml" >&2
            exit 2
        fi
        if [[ "$SKIP_PKGS" == *" $pkg "* ]]; then
            echo "fetch-binaries: selected package '$pkg' is also listed in WASM_POSIX_FETCH_SKIP_PKGS" >&2
            exit 2
        fi
        PACKAGE_DIRS+=("$pkg_dir/")
    done
    echo "fetch-binaries: selected package roots: ${SELECTED_PKGS[*]}"
else
    PACKAGE_DIRS=("$LIBS_DIR"/*/)
fi

# Collect failures and report them after the loop. A single archive
# that's been pulled from the release (or whose source build fails on
# this runner) shouldn't stop fetch-binaries from populating the rest
# of binaries/.
FAILED=()
TOTAL=0
RESOLVED=0
SKIPPED=0

# Read the `arches` list out of a package.toml. AWK keeps the
# dependency footprint tight (no jq/tomlq needed for what is
# essentially line-grepping). Output:
#   ARCHES=<space-separated list>
#
# Post binary-resolution-via-index-ledger: presence of a binary
# source is encoded in `build.toml` (a sibling file), not the
# `[binary]` block in package.toml — see the main loop below for
# that detection.
read_package_toml() {
    local toml="$1"
    awk '
        BEGIN { in_arches = 0; arches = "" }
        /^\[/ {
            # New TOML section header: leave any in-progress
            # multi-line "arches = [" capture.
            in_arches = 0
        }
        /^arches[[:space:]]*=[[:space:]]*\[/ {
            line = $0
            sub(/^arches[[:space:]]*=[[:space:]]*\[/, "", line)
            if (line ~ /\]/) {
                # Single-line form.
                sub(/\].*$/, "", line)
                gsub(/[" ,]+/, " ", line)
                sub(/^[[:space:]]+/, "", line)
                sub(/[[:space:]]+$/, "", line)
                arches = line
            } else {
                # Multi-line form: keep capturing until we see "]".
                in_arches = 1
                gsub(/[" ,]+/, " ", line)
                arches = arches " " line
            }
            next
        }
        in_arches == 1 {
            line = $0
            if (line ~ /\]/) { in_arches = 0 }
            sub(/\].*$/, "", line)
            gsub(/[" ,]+/, " ", line)
            arches = arches " " line
        }
        END {
            sub(/^[[:space:]]+/, "", arches)
            sub(/[[:space:]]+$/, "", arches)
            # Collapse internal whitespace runs to single spaces.
            gsub(/[[:space:]]+/, " ", arches)
            # Quote ARCHES so `eval` in bash sees it as a single
            # value when multiple arches are present (e.g.
            # `wasm32 wasm64`). Without quoting, bash parses the
            # second arch as a command name.
            print "ARCHES=\"" arches "\""
        }
    ' "$toml"
}

# Walk every immediate child directory by default, or the exact selected roots
# in first-requested order. `xtask build-deps resolve` owns dependency closure
# traversal; this wrapper must not duplicate or second-guess that graph.
for pkg_dir in "${PACKAGE_DIRS[@]}"; do
    [ -d "$pkg_dir" ] || continue
    pkg=$(basename "$pkg_dir")
    toml="$pkg_dir/package.toml"
    if [ ! -f "$toml" ]; then
        # Stray dir, ignore.
        continue
    fi

    eval "$(read_package_toml "$toml")"

    if [[ "$SKIP_PKGS" == *" $pkg "* ]]; then
        echo "fetch-binaries: skip $pkg (WASM_POSIX_FETCH_SKIP_PKGS)"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Post binary-resolution-via-index-ledger: a package has a
    # publishable binary IFF a sibling build.toml exists.
    # kernel / userspace / examples / source / link-time-only
    # libraries don't have one and skip.
    if [ ! -f "$pkg_dir/build.toml" ]; then
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Default arches = ["wasm32"]. Mirror the resolver's parser
    # (tools/xtask/src/pkg_manifest.rs default for absent `arches`).
    arches="${ARCHES:-}"
    [ -z "$arches" ] && arches="wasm32"

    for arch in $arches; do
        TOTAL=$((TOTAL + 1))
        echo "fetch-binaries: resolve $pkg ($arch)"
        resolve_args=(build-deps --arch "$arch" --binaries-dir "$REPO_ROOT/binaries")
        if [ "$FETCH_ONLY" = "1" ]; then
            resolve_args+=(--fetch-only)
        fi
        resolve_args+=(resolve "$pkg")
        if cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
                "${resolve_args[@]}" >/dev/null; then
            RESOLVED=$((RESOLVED + 1))
        else
            FAILED+=("$pkg ($arch)")
            echo "fetch-binaries: WARN $pkg ($arch) failed to resolve" >&2
        fi
    done
done

echo
echo "fetch-binaries: resolved=$RESOLVED total=$TOTAL skipped=$SKIPPED"
if [ ${#FAILED[@]} -gt 0 ]; then
    echo "fetch-binaries: ${#FAILED[@]} package(s) failed:" >&2
    for f in "${FAILED[@]}"; do
        echo "  - $f" >&2
    done
    if [ "$ALLOW_STALE" = "0" ]; then
        exit 1
    fi
    # Under --allow-stale (the CI default), per-package failures are
    # warnings: the matrix target's own build runs in a later step and
    # fails loudly if its actual transitive deps are missing. A green
    # exit here lets the producer step proceed to that real check.
    echo "fetch-binaries: --allow-stale set, treating ${#FAILED[@]} failure(s) as warnings (resolved=$RESOLVED)" >&2
fi
echo "fetch-binaries: done. Symlinks at $REPO_ROOT/binaries/"
