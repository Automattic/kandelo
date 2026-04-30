#!/usr/bin/env bash
#
# install-local-binary.sh — copy a freshly-built wasm into
# local-binaries/ so the resolver picks it up as an override over
# anything `scripts/fetch-binaries.sh` downloaded.
#
# Sourced or called from each ported program's build script after
# producing its output binary. The resolver (host/src/binary-resolver.ts
# + scripts/resolve-binary.sh) prefers local-binaries/ over binaries/,
# so running any program's local build automatically shadows the
# released version.
#
# Path discovery: the destination relative path under
# `local-binaries/programs/<arch>/` is read from the package's
# `package.toml` via `xtask build-deps output-path <program> <basename>`.
# This is the SAME path xtask install-release writes to from a
# published archive — keeping local builds and releases interchangeable
# at the resolver layer (single-output is flat `<output.name>.<ext>`,
# multi-output nests under `<program.name>/`). Without this lookup, a
# package whose `program.name != output.name` (e.g. texlive/pdftex) had
# divergent local-vs-release paths and the demo could never see a
# fresh local build.
#
# Usage (each call is one install target):
#     source scripts/install-local-binary.sh   # adds install_local_binary()
#
#     install_local_binary <program> <src>
#
# Where:
#   <program>   logical program name matching a package.toml `name` field
#               in the registry (e.g. "dash", "git", "texlive").
#   <src>       path to the freshly-built file. Its basename must
#               match one of the `[[outputs]].wasm` filenames declared
#               in the package's package.toml.
#
# Legacy 3-arg form `install_local_binary <program> <src> <dest-name>`
# is silently accepted: the third arg is ignored when the package.toml
# lookup succeeds (the lookup is the source of truth) and falls
# through to the legacy multi-binary subdir layout otherwise. Treat
# the 2-arg form as canonical for new build scripts.
#
# Arch is taken from $WASM_POSIX_DEP_TARGET_ARCH (set by the resolver
# while running build scripts) and falls back to "wasm32" for direct
# build-script invocations like `bash examples/libs/dash/build-dash.sh`.

install_local_binary() {
    local program="$1"
    local src="$2"
    local legacy_dest_name="${3:-}"

    if [ -z "$program" ] || [ -z "$src" ]; then
        echo "install_local_binary: usage: install_local_binary <program> <src>" >&2
        return 2
    fi
    if [ ! -f "$src" ]; then
        echo "install_local_binary: source file not found: $src" >&2
        return 1
    fi

    # Repo root from wherever the caller is.
    local repo_root
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -z "$repo_root" ]; then
        repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    fi

    local arch="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
    local src_basename
    src_basename="$(basename "$src")"

    # Take everything from the FIRST dot in the source basename onward
    # so compound extensions like `.vfs.zst` round-trip intact (matches
    # xtask/src/install_release.rs's behaviour).
    local src_ext=""
    case "$src_basename" in
        *.*) src_ext=".${src_basename#*.}" ;;
    esac

    # Ask xtask for the package.toml-driven destination relative path.
    # On hit, that's the canonical location matching install-release.
    # On miss (package not in the registry, e.g. the dash→sh alias
    # call site, or no [[outputs]] entry for this basename) fall back
    # to the legacy heuristic so existing build scripts keep working.
    local rel=""
    local host_target
    host_target="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')"
    if [ -n "$host_target" ]; then
        rel="$(cd "$repo_root" && \
            cargo run -p xtask --target "$host_target" --quiet -- \
                build-deps output-path "$program" "$src_basename" 2>/dev/null || true)"
    fi

    local dest
    if [ -n "$rel" ]; then
        dest="$repo_root/local-binaries/programs/$arch/$rel"
    elif [ -n "$legacy_dest_name" ]; then
        # Legacy multi-binary subdir layout. Used to be the only way to
        # express "this program produces multiple wasms"; package.toml's
        # [[outputs]] now does that explicitly. Reachable today only
        # for callers whose program name isn't in the registry.
        dest="$repo_root/local-binaries/programs/$arch/$program/$legacy_dest_name"
    else
        # Legacy single-binary fallback. Used by aliasing call sites
        # like `install_local_binary sh "$BIN_DIR/dash.wasm"` where
        # the "program" is a name registered nowhere. Uses the full
        # compound extension so `.vfs.zst` round-trips intact.
        dest="$repo_root/local-binaries/programs/$arch/$program$src_ext"
    fi

    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "  installed $dest"

    # When invoked under the package-system resolver (`xtask build-deps
    # resolve`, `xtask stage-release`), WASM_POSIX_DEP_OUT_DIR points at
    # the resolver's scratch dir. The build script must install its
    # declared `[[outputs]].wasm` files there so `validate_outputs`
    # finds them and `archive_stage` packs them into the release
    # archive — and `validate_outputs` looks them up by EXACT
    # `[[outputs]].wasm` filename (xtask/src/build_deps.rs:1136).
    #
    # The src filename (build script's own output) is what the build
    # script declared via `[[outputs]].wasm`, so basename(src) is
    # always the right key. No translation needed.
    #
    # Outside the resolver, WASM_POSIX_DEP_OUT_DIR is unset and this
    # path is a no-op.
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        local resolver_dest="$WASM_POSIX_DEP_OUT_DIR/$src_basename"
        mkdir -p "$(dirname "$resolver_dest")"
        cp "$src" "$resolver_dest"
        echo "  installed $resolver_dest (resolver scratch)"
    fi
}
