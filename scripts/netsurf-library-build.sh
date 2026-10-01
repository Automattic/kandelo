#!/usr/bin/env bash
# Shared build driver for the NetSurf project's C libraries (libwapcaplet,
# libparserutils, libhubbub, libcss, libdom). Source this file; do not execute
# it directly.
#
# WHY a shared driver: the five libraries are separate upstream releases, so
# each is its own package, but they share one build system — a set of GNU make
# fragments NetSurf publishes as "buildsystem" (the netsurf-buildsystem-source
# package). Driving that build system keeps upstream's source lists, generated
# files, installed headers and pkg-config metadata authoritative, where a
# hand-copied translation-unit list would drift at the next version bump.
#
# WHY this is safe to cross-compile: the build system has no configure step
# and runs no feature probes. It only needs to be told the toolchain, so there
# is nothing for a host-side probe to get wrong about the Wasm sysroot.
#
# Honors the dep-resolver build-script contract (docs/package-management.md).

# netsurf_library_setup <script-dir> <name> <default-version> <default-sha256>
#
# Prepares build roots, the worktree-local SDK, and the variables the other
# functions use. <name> is the upstream component name with its "lib" prefix
# (e.g. libwapcaplet).
netsurf_library_setup() {
    local script_dir="$1"
    NETSURF_LIB_NAME="$2"
    local default_version="$3"
    local default_sha256="$4"

    NETSURF_REPO_ROOT="$(cd "$script_dir/../../.." && pwd)"
    # shellcheck source=/dev/null
    source "$NETSURF_REPO_ROOT/scripts/package-build-roots.sh"
    kandelo_package_prepare_build_roots "$script_dir" wasm32 || return

    NETSURF_WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
    NETSURF_SRC_DIR="$NETSURF_WORK_DIR/$NETSURF_LIB_NAME-src"
    NETSURF_STAGE_DIR="$NETSURF_WORK_DIR/$NETSURF_LIB_NAME-stage"
    NETSURF_LIB_VERSION="${WASM_POSIX_DEP_VERSION:-$default_version}"
    NETSURF_INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$script_dir/$NETSURF_LIB_NAME-install}"
    NETSURF_SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.netsurf-browser.org/libs/releases/$NETSURF_LIB_NAME-$NETSURF_LIB_VERSION-src.tar.gz}"
    NETSURF_SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-$default_sha256}"
    NETSURF_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:-}"

    # Worktree-local SDK on PATH (no global npm link required).
    # shellcheck source=/dev/null
    source "$NETSURF_REPO_ROOT/sdk/activate.sh"
    export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$NETSURF_REPO_ROOT/sysroot}"

    local tool
    for tool in wasm32posix-cc wasm32posix-ar wasm32posix-pkg-config make perl cc; do
        if ! command -v "$tool" &>/dev/null; then
            echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
            return 1
        fi
    done

    # The build system itself is a source-kind dependency: makefile fragments
    # that are read at build time and contribute nothing to the output.
    if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = "source-only-v1" ]; then
        NETSURF_BUILDSYSTEM_DIR="$(
            kandelo_package_source_dependency_dir netsurf-buildsystem-source
        )" || return
    else
        NETSURF_BUILDSYSTEM_DIR="${WASM_POSIX_DEP_NETSURF_BUILDSYSTEM_SOURCE_SRC_DIR:-}"
    fi
    if [ ! -f "$NETSURF_BUILDSYSTEM_DIR/makefiles/Makefile.tools" ]; then
        echo "ERROR: $NETSURF_LIB_NAME needs the netsurf-buildsystem-source tree;" >&2
        echo "       build through 'cargo xtask build-deps resolve $NETSURF_LIB_NAME'" >&2
        echo "       or set WASM_POSIX_DEP_NETSURF_BUILDSYSTEM_SOURCE_SRC_DIR." >&2
        return 1
    fi
}

# netsurf_library_require_dep <package> <witness-path>
#
# Adds a direct library dependency's pkg-config directory to the search path
# and fails loudly when the resolver did not provide it.
netsurf_library_require_dep() {
    local package="$1"
    local witness="$2"
    local key variable prefix
    key="$(printf '%s' "${package//-/_}" | tr '[:lower:]' '[:upper:]')"
    variable="WASM_POSIX_DEP_${key}_DIR"
    prefix="$(printenv "$variable" 2>/dev/null || true)"
    if [ -z "$prefix" ] || [ ! -f "$prefix/$witness" ]; then
        echo "ERROR: $NETSURF_LIB_NAME needs $package ($variable/$witness);" >&2
        echo "       build through 'cargo xtask build-deps resolve $NETSURF_LIB_NAME'." >&2
        return 1
    fi
    NETSURF_PKG_CONFIG_PATH="$prefix/lib/pkgconfig${NETSURF_PKG_CONFIG_PATH:+:$NETSURF_PKG_CONFIG_PATH}"
}

# netsurf_library_stage_source
#
# Copies the verified release tree below the work root. A tree staged for a
# different version, URL or hash is discarded, so a version bump can never
# build the previous release.
netsurf_library_stage_source() {
    local marker="$NETSURF_WORK_DIR/.kandelo-$NETSURF_LIB_NAME-source"
    local expected
    expected="$(printf '%s\n%s\n%s' \
        "$NETSURF_LIB_VERSION" "$NETSURF_SOURCE_URL" "$NETSURF_SOURCE_SHA256")"
    if [ -d "$NETSURF_SRC_DIR" ] && \
       [ "$(cat "$marker" 2>/dev/null || true)" != "$expected" ]; then
        rm -rf "$NETSURF_SRC_DIR"
    fi
    if [ ! -d "$NETSURF_SRC_DIR" ]; then
        echo "==> Staging verified $NETSURF_LIB_NAME $NETSURF_LIB_VERSION source..."
        kandelo_package_stage_verified_source "$NETSURF_LIB_NAME" "$NETSURF_SRC_DIR" \
            "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$NETSURF_SOURCE_URL" \
            "$NETSURF_SOURCE_SHA256" "$NETSURF_WORK_DIR" || return
        printf '%s\n' "$expected" >"$marker"
    fi

    # The component Makefile owns the version that ends up in the pkg-config
    # file, so it must agree with the version the recipe declares.
    local makefile_version
    makefile_version="$(sed -n 's/^COMPONENT_VERSION := \(.*\)$/\1/p' \
        "$NETSURF_SRC_DIR/Makefile")"
    if [ "$makefile_version" != "$NETSURF_LIB_VERSION" ]; then
        echo "ERROR: $NETSURF_LIB_NAME source is version '$makefile_version'," \
            "recipe expects $NETSURF_LIB_VERSION" >&2
        return 1
    fi
}

# netsurf_library_make_install [make-variable=value ...]
#
# Runs upstream's `make install` into a private staging root.
netsurf_library_make_install() {
    local host build
    host="$(wasm32posix-cc -dumpmachine)" || return
    build="$(cc -dumpmachine)" || return

    rm -rf "$NETSURF_STAGE_DIR"
    mkdir -p "$NETSURF_STAGE_DIR"
    # A stale build directory would let objects from an earlier configuration
    # satisfy make's timestamps.
    find "$NETSURF_SRC_DIR" -maxdepth 1 -type d -name 'build-*' -exec rm -rf {} +

    echo "==> Building $NETSURF_LIB_NAME $NETSURF_LIB_VERSION for $host..."
    # WHY each setting:
    #   HOST/BUILD      differ, which selects the build system's cross path.
    #   CC/AR           the SDK wrappers; BUILD_CC compiles host-side
    #                   generators (libcss's property-parser generator).
    #   PKGCONFIG       the SDK wrapper, which refuses host .pc files.
    #   PREFIX/DESTDIR  install below the work root; the prefix recorded in
    #                   the .pc file is rewritten to a relocatable one below.
    #   CFLAGS          upstream's warning list ends in -Werror, tuned to
    #                   the compilers NetSurf tests. Each Makefile appends the
    #                   environment's CFLAGS after that list, so -Wno-error
    #                   here keeps every warning visible while a newer clang
    #                   adding one diagnostic cannot fail a correct build.
    #   PERL_HASH_SEED  libhubbub's entity-table generator walks a Perl hash
    #                   in iteration order, which Perl randomizes per run.
    #                   Fixing the seed makes the generated table, and so the
    #                   archive, reproducible.
    PKG_CONFIG_PATH="$NETSURF_PKG_CONFIG_PATH" \
    PERL_HASH_SEED=0 PERL_PERTURB_KEYS=0 \
    CFLAGS="-Wno-error" \
    make -C "$NETSURF_SRC_DIR" \
        HOST="$host" BUILD="$build" \
        CC=wasm32posix-cc AR=wasm32posix-ar BUILD_CC=cc \
        PKGCONFIG=wasm32posix-pkg-config \
        NSSHARED="$NETSURF_BUILDSYSTEM_DIR" \
        PREFIX=/usr DESTDIR="$NETSURF_STAGE_DIR" \
        COMPONENT_TYPE=lib-static VARIANT=release \
        "$@" install
}

# netsurf_library_install
#
# Publishes the staged tree into the caller-owned output prefix and makes the
# pkg-config file relocatable.
netsurf_library_install() {
    local pc="$NETSURF_STAGE_DIR/usr/lib/pkgconfig/$NETSURF_LIB_NAME.pc"
    local archive="$NETSURF_STAGE_DIR/usr/lib/$NETSURF_LIB_NAME.a"
    local expected
    for expected in "$pc" "$archive"; do
        if [ ! -f "$expected" ]; then
            echo "ERROR: $NETSURF_LIB_NAME build did not install $expected" >&2
            return 1
        fi
    done

    # The build system writes the absolute install prefix into the .pc file.
    # Package archives are unpacked at cache paths chosen later, so derive the
    # prefix from the .pc file's own location instead.
    sed -i.orig 's#^prefix=/usr$#prefix=${pcfiledir}/../..#' "$pc"
    rm -f "$pc.orig"
    if ! grep -qx 'prefix=${pcfiledir}/../..' "$pc"; then
        echo "ERROR: could not make $NETSURF_LIB_NAME.pc relocatable" >&2
        return 1
    fi

    # Empty the output prefix rather than replacing it: the resolver records
    # the directory's inode identity.
    mkdir -p "$NETSURF_INSTALL_DIR"
    find "$NETSURF_INSTALL_DIR" -mindepth 1 -delete
    cp -R "$NETSURF_STAGE_DIR/usr/." "$NETSURF_INSTALL_DIR/"

    echo "==> $NETSURF_LIB_NAME $NETSURF_LIB_VERSION installed at $NETSURF_INSTALL_DIR"
    ls -lh "$NETSURF_INSTALL_DIR/lib/$NETSURF_LIB_NAME.a"
}
