#!/usr/bin/env bash
#
# Fetch published Wasm binaries by walking every per-package
# `examples/libs/<name>/package.toml`.
#
# The resolver consumes per-package `[binary]` / `[binary.<arch>]`
# URLs directly — no central pinfile or manifest. For each package
# that declares a `[binary]` block we run
#
#     cargo run -p xtask -- build-deps resolve <name> \
#         --arch <arch> --binaries-dir <repo>/binaries
#
# which (a) fetches+verifies the archive into the resolver's
# content-addressed cache (~/.cache/wasm-posix-kernel/...), and (b)
# places `binaries/programs/<arch>/<output>.wasm` symlinks pointing
# into the cache. Browser demos hardcode these paths.
#
# Packages without a `[binary]` block (kernel, userspace, examples,
# sqlite-cli, node, kind=source, libraries that ship only as
# link-time inputs) are skipped here. Local builds populate
# kernel/userspace/etc directly; libraries are consumed at link time
# via the cache and have no binaries/ symlink.
#
# Per-arch handling: read the optional `arches = ["wasm32", ...]`
# field from each package.toml. Default is `["wasm32"]`. For each
# declared arch we invoke `resolve --arch <arch>` once. Packages that
# declare only `[binary.wasm32]` (no per-arch table) work too — the
# resolver falls back to source-build for unsupported arches and the
# loop continues.
#
# Resolver fallback semantics: if an archive is unreachable, hash-
# mismatched, or has a stale `cache_key_sha`, `resolve` logs a
# warning and falls through to a source build. A source build that
# also fails surfaces as a non-zero exit; we collect the failures
# and report them at the end so one stuck package doesn't block the
# others.
#
# Flags:
#   --offline      Set `WASM_POSIX_OFFLINE=1` so the resolver refuses
#                  to hit the network. (No-op if every archive is
#                  already in the cache.)
#   --pr <N>       Force PR overlay handling. With Phase C the overlay
#                  lives at `examples/libs/<name>/package.pr.toml`,
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
#   -h / --help    Print this header.
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
while [ $# -gt 0 ]; do
    case "$1" in
        --offline)     OFFLINE=1; shift ;;
        --pr)          PR_NUMBER="$2"; shift 2 ;;
        --allow-stale) ALLOW_STALE=1; shift ;;
        # Phase C deprecates --force / --prune: the resolver cache
        # is content-addressed (a different archive_url ⇒ a different
        # canonical path) so neither flag has a meaningful action.
        # Accept-and-ignore for transition; warn so callers update.
        --force)       echo "fetch-binaries: --force is now a no-op (cache is content-addressed); ignoring" >&2; shift ;;
        --prune)       echo "fetch-binaries: --prune is now a no-op (cache GC is the resolver's job); ignoring" >&2; shift ;;
        -h|--help)
            sed -n '3,66p' "$0"
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

if [ "$ALLOW_STALE" = "1" ]; then
    # The resolver source-builds automatically on archive verification
    # failure (xtask/src/build_deps.rs cmd_resolve fallback: any
    # remote_fetch error logs a warning and falls through to
    # build_into_cache). --allow-stale also degrades any per-package
    # resolve FAILURE to a warning so a meta-package whose source
    # build is broken on this runner doesn't abort CI when the matrix
    # target itself builds fine. See the header for full semantics.
    echo "fetch-binaries: --allow-stale accepted (per-package failures degrade to warnings)"
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
LIBS_DIR="$REPO_ROOT/examples/libs"
[ -d "$LIBS_DIR" ] || { echo "fetch-binaries: $LIBS_DIR not found" >&2; exit 2; }

# Collect failures and report them after the loop. A single archive
# that's been pulled from the release (or whose source build fails on
# this runner) shouldn't stop fetch-binaries from populating the rest
# of binaries/.
FAILED=()
TOTAL=0
RESOLVED=0
SKIPPED=0

# Read the [binary] / [binary.<arch>] presence + arches list out of a
# package.toml. AWK keeps the dependency footprint tight (no jq/tomlq
# needed for what is essentially line-grepping). Output:
#   ARCHES=<space-separated list>
#   HAS_BINARY=<0|1>
read_package_toml() {
    local toml="$1"
    awk '
        BEGIN { in_arches = 0; arches = ""; has_binary = 0 }
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
        # Any [binary] or [binary.wasmXX] header counts.
        /^\[binary(\..+)?\][[:space:]]*$/ { has_binary = 1 }
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
            print "HAS_BINARY=" has_binary
        }
    ' "$toml"
}

# Walk every immediate child directory of examples/libs/.
for pkg_dir in "$LIBS_DIR"/*/; do
    [ -d "$pkg_dir" ] || continue
    pkg=$(basename "$pkg_dir")
    toml="$pkg_dir/package.toml"
    if [ ! -f "$toml" ]; then
        # Stray dir, ignore.
        continue
    fi

    eval "$(read_package_toml "$toml")"

    if [ "${HAS_BINARY:-0}" = "0" ]; then
        # No [binary] block: kernel / userspace / examples / source
        # packages / libraries that ship only at link time. Local
        # builds (or no published archive yet). Skip silently.
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Default arches = ["wasm32"]. Mirror the resolver's parser
    # (xtask/src/pkg_manifest.rs default for absent `arches`).
    arches="${ARCHES:-}"
    [ -z "$arches" ] && arches="wasm32"

    for arch in $arches; do
        TOTAL=$((TOTAL + 1))
        echo "fetch-binaries: resolve $pkg ($arch)"
        if cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
                build-deps --arch "$arch" --binaries-dir "$REPO_ROOT/binaries" \
                resolve "$pkg" >/dev/null; then
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
