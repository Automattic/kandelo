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
# Usage (each argument is one install target):
#     source scripts/install-local-binary.sh   # adds install_local_binary()
#
#     install_local_binary <program> <src> [<dest-filename>]
#
# Where:
#   <program>          logical program name matching manifest entries
#                      (e.g., "dash", "git", "php").
#   <src>              path to the freshly-built .wasm (or .zip).
#   <dest-filename>    optional: filename under
#                      local-binaries/programs/<arch>/<program>/ for
#                      multi-binary programs. When omitted, the file
#                      lands at local-binaries/programs/<arch>/<program>.<ext>
#                      (single-binary convention).
#
# Arch is taken from $WASM_POSIX_DEP_TARGET_ARCH (set by the resolver
# while running build scripts) and falls back to "wasm32" for direct
# build-script invocations like `bash examples/libs/dash/build-dash.sh`.
#
# Multi-binary examples:
#   install_local_binary git examples/libs/git/bin/git.wasm git.wasm
#   install_local_binary git examples/libs/git/bin/git-remote-http.wasm \
#       git-remote-http.wasm
#
# Single-binary examples:
#   install_local_binary dash examples/libs/dash/bin/dash.wasm
#   install_local_binary nginx examples/nginx/nginx.wasm

install_local_binary() {
    local program="$1"
    local src="$2"
    local dest_name="${3:-}"

    if [ -z "$program" ] || [ -z "$src" ]; then
        echo "install_local_binary: usage: install_local_binary <program> <src> [<dest-filename>]" >&2
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
    local dest
    if [ -n "$dest_name" ]; then
        # Multi-binary program — dest goes under programs/<arch>/<program>/
        dest="$repo_root/local-binaries/programs/$arch/$program/$dest_name"
    else
        # Single-binary — programs/<arch>/<program>.<ext>
        local ext="${src##*.}"
        dest="$repo_root/local-binaries/programs/$arch/$program.$ext"
    fi

    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "  installed $dest"

    # When invoked under the package-system resolver (`xtask build-deps resolve`,
    # `xtask stage-release`), WASM_POSIX_DEP_OUT_DIR points at the
    # resolver's scratch dir. The build script must install its
    # declared `[[outputs]].wasm` files there so `validate_outputs`
    # finds them and `archive_stage` packs them into the release
    # archive.
    #
    # Mapping (matches the build_deps program-output validator):
    #   single-binary (no dest_name) →
    #     $WASM_POSIX_DEP_OUT_DIR/<program>.<ext>
    #   multi-binary (dest_name given) →
    #     $WASM_POSIX_DEP_OUT_DIR/<dest_name>
    #
    # Outside the resolver, WASM_POSIX_DEP_OUT_DIR is unset and this
    # path is a no-op.
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        local resolver_dest
        if [ -n "$dest_name" ]; then
            resolver_dest="$WASM_POSIX_DEP_OUT_DIR/$dest_name"
        else
            local ext_resolver="${src##*.}"
            resolver_dest="$WASM_POSIX_DEP_OUT_DIR/$program.$ext_resolver"
        fi
        mkdir -p "$(dirname "$resolver_dest")"
        cp "$src" "$resolver_dest"
        echo "  installed $resolver_dest (resolver scratch)"
    fi
}
