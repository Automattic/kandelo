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
# This is the SAME path the resolver writes to from a published
# archive — keeping local builds and releases interchangeable at the
# resolver layer (single-output is flat `<output.name>.<ext>`,
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
# build-script invocations like `bash packages/registry/dash/build-dash.sh`.
# Sealed callers that only consume $WASM_POSIX_DEP_OUT_DIR can set
# WASM_POSIX_INSTALL_LOCAL_MIRROR=0 to retain all writes in caller-owned
# scratch space while preserving the normal artifact guards below.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wasm-artifact-guards.sh"

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
    local arch="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
    case "$arch" in
        wasm32|wasm64) ;;
        *)
            echo "install_local_binary: unsupported target arch '$arch' (expected wasm32 or wasm64)" >&2
            return 2
            ;;
    esac

    # Repo root must be derived from this helper, not from the caller's
    # current directory: package builds often `cd` into an upstream git
    # checkout before installing artifacts.
    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    local src_basename
    src_basename="$(basename "$src")"
    local install_local_mirror="${WASM_POSIX_INSTALL_LOCAL_MIRROR:-1}"
    case "$install_local_mirror" in
        0)
            if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
                echo "install_local_binary: WASM_POSIX_INSTALL_LOCAL_MIRROR=0 requires WASM_POSIX_DEP_OUT_DIR" >&2
                return 2
            fi
            ;;
        1) ;;
        *)
            echo "install_local_binary: unsupported WASM_POSIX_INSTALL_LOCAL_MIRROR='$install_local_mirror' (expected 0 or 1)" >&2
            return 2
            ;;
    esac

    if ! wasm_require_no_legacy_asyncify "$src"; then
        return 1
    fi
    local host_target=""
    if [ "$install_local_mirror" = "1" ]; then
        host_target="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')"
    fi
    local fork_instrumentation="${WASM_POSIX_INSTALL_FORK_INSTRUMENTATION:-}"
    if [ -z "$fork_instrumentation" ] && [ -n "$host_target" ]; then
        fork_instrumentation="$(cd "$repo_root" && \
            env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
            cargo run -p xtask --target "$host_target" --quiet -- \
                build-deps output-fork-instrumentation "$program" "$src_basename" 2>/dev/null || true)"
    fi
    fork_instrumentation="${fork_instrumentation:-auto}"
    case "$fork_instrumentation" in
        auto)
            if wasm_imports_kernel_fork "$src" && ! wasm_has_complete_fork_instrumentation "$src"; then
                if wasm_has_any_wpk_fork_export "$src"; then
                    wasm_require_fork_instrumentation_if_needed "$src"
                    return 1
                fi
                echo "  applying wasm-fork-instrument to $(basename "$src")"
                local instrumented
                instrumented="$(mktemp "${TMPDIR:-/tmp}/wpk-fork-instrument.XXXXXX.wasm")"
                if ! "$repo_root/scripts/run-wasm-fork-instrument.sh" "$src" -o "$instrumented"; then
                    rm -f "$instrumented"
                    return 1
                fi
                mv "$instrumented" "$src"
            fi
            if ! wasm_require_fork_instrumentation_if_needed "$src"; then
                return 1
            fi
            ;;
        disabled)
            if ! wasm_require_no_fork_instrumentation "$src"; then
                return 1
            fi
            ;;
        *)
            echo "install_local_binary: unsupported WASM_POSIX_INSTALL_FORK_INSTRUMENTATION='$fork_instrumentation' (expected auto or disabled)" >&2
            return 2
            ;;
    esac

    if [ "$install_local_mirror" = "1" ]; then
        # Take everything from the FIRST dot in the source basename onward
        # so compound extensions like `.vfs.zst` round-trip intact (matches
        # the resolver's `place_binaries_symlinks` extension handling).
        local src_ext=""
        case "$src_basename" in
            *.*) src_ext=".${src_basename#*.}" ;;
        esac

        # Ask xtask for the package.toml-driven destination relative path.
        # On hit, that's the canonical location matching the resolver's
        # symlink layout (tools/xtask/src/build_deps.rs `place_binaries_symlinks`).
        # On miss (package not in the registry, e.g. the dash→sh alias
        # call site, or no [[outputs]] entry for this basename) fall back
        # to the legacy heuristic so existing build scripts keep working.
        local rel=""
        if [ -n "$host_target" ]; then
            rel="$(cd "$repo_root" && \
                env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
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
    fi

    # When invoked under the package-system resolver (`xtask build-deps
    # resolve`, `xtask archive-stage`), WASM_POSIX_DEP_OUT_DIR points at
    # the resolver's scratch dir. The build script must install its
    # declared `[[outputs]].wasm` files there so `validate_outputs`
    # finds them and `archive_stage` packs them into the release
    # archive — and `validate_outputs` looks them up by EXACT
    # `[[outputs]].wasm` filename (tools/xtask/src/build_deps.rs:1136).
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

# Install a declared non-Wasm `[[runtime_files]]` artifact into the same local
# and caller-owned resolver destinations used by executable outputs. This is
# intentionally separate from install_local_binary: data files must not pass
# Wasm/fork guards or be described as executable outputs.
install_local_runtime_file() {
    local program="$1"
    local src="$2"
    local artifact="${3:-}"

    if [ -z "$program" ] || [ -z "$src" ]; then
        echo "install_local_runtime_file: usage: install_local_runtime_file <program> <src> [artifact]" >&2
        return 2
    fi
    if [ ! -f "$src" ] || [ -L "$src" ]; then
        echo "install_local_runtime_file: source must be a regular non-symlink file: $src" >&2
        return 1
    fi
    local arch="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
    case "$arch" in
        wasm32|wasm64) ;;
        *)
            echo "install_local_runtime_file: unsupported target arch '$arch' (expected wasm32 or wasm64)" >&2
            return 2
            ;;
    esac

    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    local src_basename
    src_basename="$(basename "$src")"
    artifact="${artifact:-$src_basename}"
    case "$artifact" in
        ""|/*|*\\*|.|..|./*|../*|*/.|*/..|*//*|*/./*|*/../*|*/)
            echo "install_local_runtime_file: artifact must be a portable relative path: $artifact" >&2
            return 2
            ;;
    esac

    local install_local_mirror="${WASM_POSIX_INSTALL_LOCAL_MIRROR:-1}"
    case "$install_local_mirror" in
        0)
            if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
                echo "install_local_runtime_file: WASM_POSIX_INSTALL_LOCAL_MIRROR=0 requires WASM_POSIX_DEP_OUT_DIR" >&2
                return 2
            fi
            local resolver_dest="$WASM_POSIX_DEP_OUT_DIR/$artifact"
            mkdir -p "$(dirname "$resolver_dest")"
            cp "$src" "$resolver_dest"
            echo "  installed $resolver_dest (resolver scratch)"
            return 0
            ;;
        1) ;;
        *)
            echo "install_local_runtime_file: unsupported WASM_POSIX_INSTALL_LOCAL_MIRROR='$install_local_mirror' (expected 0 or 1)" >&2
            return 2
            ;;
    esac

    local host_target
    host_target="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')"
    if [ -z "$host_target" ]; then
        echo "install_local_runtime_file: rustc did not report a host target" >&2
        return 1
    fi
    local rel
    rel="$(cd "$repo_root" && \
        env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
        cargo run -p xtask --target "$host_target" --quiet -- \
            build-deps runtime-file-path "$program" "$artifact")" || return 1
    if [ -z "$rel" ]; then
        echo "install_local_runtime_file: manifest lookup returned an empty path" >&2
        return 1
    fi

    local dest="$repo_root/local-binaries/programs/$arch/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "  installed $dest"
}
