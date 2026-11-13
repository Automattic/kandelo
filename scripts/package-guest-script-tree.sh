#!/usr/bin/env bash
# Build a script-based GNU package (autoconf, automake, libtool, help2man,
# ...) for Kandelo as one ZIP rooted at /usr.
#
# The package is configured with --prefix=/usr and installed into a staging
# tree on the build machine, using the dev shell's perl, m4 and shell. Its
# scripts record those tools' build-machine paths, which
# scripts/rewrite-guest-tool-paths.py rewrites to the guest's (/usr/bin/perl,
# /usr/bin/m4, /bin/sh, ...); a path it cannot map fails the build. Manual
# pages and info manuals are left out of the ZIP: the shell indexes manual
# pages from separate docs packages, and every GNU package installs its own
# copy of the shared info `dir` file.
#
# Usage, from a recipe that has sourced scripts/package-build-roots.sh and
# called kandelo_package_load_source_metadata:
#
#   source "$REPO_ROOT/scripts/package-guest-script-tree.sh"
#   kandelo_package_guest_script_tree <pkg> <zip-name> [configure-arg...]
#
# Patches in the recipe's patches/ directory are applied with -p1 in name
# order. KANDELO_GUEST_SCRIPT_CONFIGURE names the configure command, default
# ./configure. A package whose installed scripts encode the target toolchain
# (libtool) sets it to wasm32posix-configure, so they describe the guest,
# not the build machine; that recipe also needs the SDK toolchain.

kandelo_package_guest_script_tree() {
    local pkg="$1" zip_name="$2"
    shift 2
    local here repo_root work src stage archive
    here="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

    kandelo_package_prepare_build_roots "$here" wasm32
    work="$KANDELO_PACKAGE_WORK_DIR"
    src="$work/$pkg-src"
    stage="$work/$pkg-stage"
    archive="$work/$zip_name"

    rm -rf "$src" "$stage" "$archive"
    kandelo_package_stage_primary_source "$pkg" "$src" "$work"
    local patch
    for patch in "$here"/patches/*.patch; do
        [ -f "$patch" ] || continue
        echo "==> Applying $(basename "$patch")"
        patch -p1 -d "$src" < "$patch"
    done

    local configure="${KANDELO_GUEST_SCRIPT_CONFIGURE:-./configure}"
    echo "==> Configuring $pkg for /usr ($configure)..."
    (cd "$src" && $configure --prefix=/usr "$@") | tail -20
    echo "==> Building $pkg..."
    make -C "$src" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" | tail -20
    make -C "$src" install DESTDIR="$stage" | tail -5

    [ -d "$stage/usr" ] || { echo "ERROR: $pkg installed nothing under /usr" >&2; return 1; }
    rm -rf "$stage/usr/share/man" "$stage/usr/share/info" "$stage/usr/share/emacs"
    # The SDK sysroot a cross-configured package was built against is the
    # guest SDK's sysroot inside Kandelo.
    local -a maps=()
    if [ -n "${WASM_POSIX_SYSROOT:-}" ]; then
        maps+=(--map "$WASM_POSIX_SYSROOT=/usr/lib/kandelo/wasm32posix/sysroot")
    fi
    python3 "$repo_root/scripts/rewrite-guest-tool-paths.py" \
        "$stage/usr" ${maps[@]+"${maps[@]}"} "$work" "$repo_root" "$src"

    bash "$repo_root/images/vfs/scripts/create-deterministic-zip.sh" "$stage/usr" "$archive"
    ls -lh "$archive"

    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
        export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
    fi
    # shellcheck source=/dev/null
    source "$repo_root/scripts/install-local-binary.sh"
    install_local_binary "$pkg" "$archive" "$zip_name"
}
