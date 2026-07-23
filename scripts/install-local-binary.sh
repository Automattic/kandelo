#!/usr/bin/env bash
#
# install-local-binary.sh — install freshly-built package artifacts into
# local-binaries/ so the resolver picks them up as an override over anything
# `scripts/fetch-binaries.sh` downloaded.
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
# resolver layer (a one-member package is flat `<output.name>.<ext>`;
# every output/runtime member nests under `<program.name>/` when the package
# has more than one total member). Without this lookup, a
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

# All artifacts installed by one sourced build helper share a session. For a
# package closure, xtask collects that session below a hidden immutable
# generation and publishes the live package directory only after every declared
# output and runtime file is present. Callers coordinating separate shell
# processes may provide their own portable session token.
if [ -z "${WASM_POSIX_LOCAL_INSTALL_SESSION:-}" ]; then
    WASM_POSIX_LOCAL_INSTALL_SESSION="shell-${BASHPID:-$$}-${RANDOM:-0}-${RANDOM:-0}"
fi

# Copy through a private sibling and publish with a hard link. `cp "$src"
# "$dest"` would follow an existing destination symlink and overwrite the
# fetched canonical cache bytes it points at. This helper moves that entry
# aside without dereferencing it, then creates the new pathname only if it is
# still absent. It is used for legacy aliases and caller-owned scratch too.
_wasm_posix_copy_file_no_follow() {
    local src="$1"
    local dest="$2"
    local parent
    parent="$(dirname "$dest")"
    mkdir -p "$parent"

    local name
    name="$(basename "$dest")"
    local stage
    stage="$(mktemp "$parent/.${name}.local-stage.XXXXXX")" || return 1
    local backup
    backup="$(mktemp "$parent/.${name}.local-backup.XXXXXX")" || {
        rm -f "$stage"
        return 1
    }
    rm -f "$backup"

    if ! cp -p "$src" "$stage"; then
        rm -f "$stage"
        return 1
    fi

    local old_moved=0
    if [ -e "$dest" ] || [ -L "$dest" ]; then
        if [ -d "$dest" ] && [ ! -L "$dest" ]; then
            echo "install-local-binary: refusing to replace directory: $dest" >&2
            rm -f "$stage"
            return 1
        fi
        if ! mv "$dest" "$backup"; then
            rm -f "$stage"
            return 1
        fi
        old_moved=1
    fi

    if ! ln "$stage" "$dest"; then
        if [ "$old_moved" = "1" ] && [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
            mv "$backup" "$dest" || true
        fi
        rm -f "$stage"
        if [ "$old_moved" = "1" ] && { [ -e "$dest" ] || [ -L "$dest" ]; }; then
            rm -f "$backup"
        fi
        return 1
    fi

    rm -f "$stage"
    if [ "$old_moved" = "1" ]; then
        rm -f "$backup"
    fi
}

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
        local registered_package_dir="$repo_root/packages/registry/$program"
        if [ -e "$registered_package_dir" ] || [ -L "$registered_package_dir" ]; then
            if [ -z "$host_target" ]; then
                echo "install_local_binary: rustc did not report a host target for registered package '$program'" >&2
                return 1
            fi
            if ! rel="$(cd "$repo_root" && \
                env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
                cargo run -p xtask --target "$host_target" --quiet -- \
                    build-deps output-path "$program" "$src_basename")"; then
                echo "install_local_binary: registered package '$program' does not declare output '$src_basename'" >&2
                return 1
            fi
            if [ -z "$rel" ]; then
                echo "install_local_binary: registered package '$program' returned an empty output path" >&2
                return 1
            fi
        elif [ -n "$host_target" ]; then
            # Genuinely unregistered names are compatibility aliases (for
            # example dash -> sh). Let an external registry opt into the
            # manifest path when it resolves successfully, but preserve the
            # legacy fallback when no manifest exists.
            rel="$(cd "$repo_root" && \
                env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
                cargo run -p xtask --target "$host_target" --quiet -- \
                    build-deps output-path "$program" "$src_basename" 2>/dev/null || true)"
        fi

        local dest
        if [ -n "$rel" ]; then
            dest="$repo_root/local-binaries/programs/$arch/$rel"
            local source_parent
            source_parent="$(cd "$(dirname "$src")" && pwd -P)" || return 1
            local source_abs="$source_parent/$src_basename"
            if ! (cd "$repo_root" && \
                env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
                    WASM_POSIX_LOCAL_INSTALL_SOURCE="$source_abs" \
                    WASM_POSIX_LOCAL_INSTALL_SESSION="$WASM_POSIX_LOCAL_INSTALL_SESSION" \
                    cargo run -p xtask --target "$host_target" --quiet -- \
                        build-deps --arch "$arch" \
                        --binaries-dir "$repo_root/local-binaries" \
                        install-local-artifact "$program" "$src_basename"); then
                return 1
            fi
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

        if [ -z "$rel" ]; then
            if ! _wasm_posix_copy_file_no_follow "$src" "$dest"; then
                echo "install_local_binary: failed to replace legacy local mirror without following it: $dest" >&2
                return 1
            fi
            echo "  installed $dest"
        fi
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
        if ! _wasm_posix_copy_file_no_follow "$src" "$resolver_dest"; then
            echo "install_local_binary: failed to replace resolver scratch artifact without following it: $resolver_dest" >&2
            return 1
        fi
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
            if ! _wasm_posix_copy_file_no_follow "$src" "$resolver_dest"; then
                echo "install_local_runtime_file: failed to replace resolver scratch artifact without following it: $resolver_dest" >&2
                return 1
            fi
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
    local source_parent
    source_parent="$(cd "$(dirname "$src")" && pwd -P)" || return 1
    local source_abs="$source_parent/$src_basename"
    if ! (cd "$repo_root" && \
        env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
            WASM_POSIX_LOCAL_INSTALL_SOURCE="$source_abs" \
            WASM_POSIX_LOCAL_INSTALL_SESSION="$WASM_POSIX_LOCAL_INSTALL_SESSION" \
            cargo run -p xtask --target "$host_target" --quiet -- \
                build-deps --arch "$arch" \
                --binaries-dir "$repo_root/local-binaries" \
                install-local-artifact "$program" "$artifact"); then
        return 1
    fi
}
