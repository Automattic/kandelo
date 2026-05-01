#!/usr/bin/env bash
#
# Unified build, run, and test script for wasm-posix-kernel.
#
# Usage:
#   ./run.sh build [target...]    Build specific targets (or all)
#   ./run.sh rebuild [target...]  Force-rebuild (clean + build)
#   ./run.sh clean [target...]    Remove build artifacts
#   ./run.sh fetch                Fetch binaries pinned by binaries.lock
#   ./run.sh run <example> [args] Run a Node.js example
#   ./run.sh browser [args]       Start the Vite browser dev server
#   ./run.sh list                 Show available targets and examples
#   ./run.sh test [suite...]      Run test suites
#
# Top-level flags (recognized anywhere in the argument list):
#   --allow-stale                 Soften the install-release manifest gate
#                                  (forwarded to scripts/fetch-binaries.sh).
#                                  Equivalent to WASM_POSIX_ALLOW_STALE=1.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# Activate the worktree-local SDK toolchain (no global npm link required).
# Build scripts also source this directly; sourcing here makes the tools
# available to anything `run.sh` shells out to (e.g. `bash run.sh build_X`).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

# ─── Colors ───────────────────────────────────────────────────────────────────

if [ -t 1 ] && command -v tput &>/dev/null && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); CYAN=$(tput setaf 6)
    RED=$(tput setaf 1); BOLD=$(tput bold); RESET=$(tput sgr0)
else
    GREEN=""; YELLOW=""; CYAN=""; RED=""; BOLD=""; RESET=""
fi

info()  { echo "${GREEN}[OK]${RESET} $*"; }
warn()  { echo "${YELLOW}[>>]${RESET} $*"; }
err()   { echo "${RED}[!!]${RESET} $*" >&2; }
step()  { echo "${CYAN}${BOLD}=== $* ===${RESET}"; }

# ─── Top-level flag parsing ──────────────────────────────────────────────────
#
# Scrub --allow-stale from $@ and turn it into an env var so any
# downstream invocation of fetch-binaries.sh (called directly or
# nested via build_target) picks it up. Also honor the env var if
# the user prefers `WASM_POSIX_ALLOW_STALE=1 ./run.sh browser`.
ALLOW_STALE_ARGS=()
NEW_ARGS=()
for a in "$@"; do
    if [ "$a" = "--allow-stale" ]; then
        ALLOW_STALE_ARGS=(--allow-stale)
    else
        NEW_ARGS+=("$a")
    fi
done
set -- "${NEW_ARGS[@]+"${NEW_ARGS[@]}"}"
if [ "${WASM_POSIX_ALLOW_STALE:-0}" = "1" ]; then
    ALLOW_STALE_ARGS=(--allow-stale)
fi
export WASM_POSIX_ALLOW_STALE=$([ "${#ALLOW_STALE_ARGS[@]}" -gt 0 ] && echo 1 || echo 0)

# ─── Artifact checks ─────────────────────────────────────────────────────────

# `has_resolvable <rel>` is true when the binary resolves via
# `local-binaries/` or `binaries/`. Used to treat fetched binaries as
# "already built" so build_target skips.
has_resolvable() {
    "$REPO_ROOT/scripts/resolve-binary.sh" "$1" >/dev/null 2>&1
}

has_kernel()    { has_resolvable kernel.wasm || [ -f "$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm" ]; }
has_sysroot()   { [ -f "$REPO_ROOT/sysroot/lib/libc.a" ]; }
has_sysroot64() { [ -f "$REPO_ROOT/sysroot64/lib/libc.a" ]; }
has_sdk()       { command -v wasm32posix-cc &>/dev/null; }
has_host()      { [ -d "$REPO_ROOT/host/dist" ]; }
has_programs()    { has_resolvable programs/fork-exec.wasm || [ -f "$REPO_ROOT/host/wasm/fork-exec.wasm" ]; }
has_nginx()    { has_resolvable programs/nginx.wasm || [ -f "$REPO_ROOT/examples/nginx/nginx.wasm" ]; }
has_php()       { has_resolvable programs/php/php.wasm || [ -f "$REPO_ROOT/examples/libs/php/php-src/sapi/cli/php" ]; }
has_php_fpm()    { has_resolvable programs/php/php-fpm.wasm || [ -f "$REPO_ROOT/examples/nginx/php-fpm.wasm" ]; }
has_mariadb()    { has_resolvable programs/mariadb/mariadbd.wasm || [ -f "$REPO_ROOT/examples/libs/mariadb/mariadb-install/bin/mariadbd" ]; }
has_mariadb64() { has_resolvable programs/wasm64/mariadb/mariadbd.wasm || [ -f "$REPO_ROOT/examples/libs/mariadb/mariadb-install-64/bin/mariadbd" ]; }
has_mariadb_vfs() { has_resolvable programs/mariadb-vfs.vfs; }
has_mariadb64_vfs() { has_resolvable programs/wasm64/mariadb-vfs.vfs; }
has_wp_vfs()    { has_resolvable programs/wordpress.vfs; }
has_dash()    { has_resolvable programs/dash.wasm || [ -f "$REPO_ROOT/examples/libs/dash/bin/dash.wasm" ]; }
has_bash()    { has_resolvable programs/bash.wasm || [ -f "$REPO_ROOT/examples/libs/bash/bin/bash.wasm" ]; }
has_coreutils()    { has_resolvable programs/coreutils.wasm || [ -f "$REPO_ROOT/examples/libs/coreutils/bin/coreutils.wasm" ]; }
has_grep()    { has_resolvable programs/grep.wasm || [ -f "$REPO_ROOT/examples/libs/grep/bin/grep.wasm" ]; }
has_sed()    { has_resolvable programs/sed.wasm || [ -f "$REPO_ROOT/examples/libs/sed/bin/sed.wasm" ]; }
has_redis()    { has_resolvable programs/redis/redis-server.wasm || [ -f "$REPO_ROOT/examples/libs/redis/bin/redis-server.wasm" ]; }
has_dinit()    { has_resolvable programs/dinit/dinit.wasm || [ -f "$REPO_ROOT/examples/libs/dinit/bin/dinit.wasm" ]; }
has_cpython()    { has_resolvable programs/cpython.wasm || [ -f "$REPO_ROOT/examples/libs/cpython/bin/python.wasm" ]; }
has_python_vfs()    { has_resolvable programs/python-vfs.vfs || [ -f "$REPO_ROOT/examples/browser/public/python.vfs" ]; }
has_perl_vfs()    { has_resolvable programs/perl-vfs.vfs || [ -f "$REPO_ROOT/examples/browser/public/perl.vfs" ]; }
has_shell_vfs()    { has_resolvable programs/shell.vfs || [ -f "$REPO_ROOT/examples/browser/public/shell.vfs" ]; }
has_erlang()    { has_resolvable programs/erlang.wasm || [ -f "$REPO_ROOT/examples/libs/erlang/bin/beam.wasm" ]; }
has_erlang_vfs()    { has_resolvable programs/erlang-vfs.vfs || [ -f "$REPO_ROOT/examples/browser/public/erlang.vfs" ]; }
has_lamp_vfs()    { has_resolvable programs/lamp.vfs; }
has_nginx_vfs()  { has_resolvable programs/nginx-vfs.vfs; }
has_redis_vfs()  { has_resolvable programs/redis-vfs.vfs; }
has_nginx_php_vfs() { has_resolvable programs/nginx-php-vfs.vfs; }
has_bc()    { has_resolvable programs/bc.wasm || [ -f "$REPO_ROOT/examples/libs/bc/bin/bc.wasm" ]; }
has_file()    { has_resolvable programs/file.wasm || [ -f "$REPO_ROOT/examples/libs/file/bin/file.wasm" ]; }
has_less()    { has_resolvable programs/less.wasm || [ -f "$REPO_ROOT/examples/libs/less/bin/less.wasm" ]; }
has_m4()    { has_resolvable programs/m4.wasm || [ -f "$REPO_ROOT/examples/libs/m4/bin/m4.wasm" ]; }
has_make()    { has_resolvable programs/make.wasm || [ -f "$REPO_ROOT/examples/libs/make/bin/make.wasm" ]; }
has_tar()    { has_resolvable programs/tar.wasm || [ -f "$REPO_ROOT/examples/libs/tar/bin/tar.wasm" ]; }
has_curl()    { has_resolvable programs/curl.wasm || [ -f "$REPO_ROOT/examples/libs/curl/bin/curl.wasm" ]; }
has_wget()    { has_resolvable programs/wget.wasm || [ -f "$REPO_ROOT/examples/libs/wget/bin/wget.wasm" ]; }
has_gzip()    { has_resolvable programs/gzip.wasm || [ -f "$REPO_ROOT/examples/libs/gzip/bin/gzip.wasm" ]; }
has_bzip2()    { has_resolvable programs/bzip2.wasm || [ -f "$REPO_ROOT/examples/libs/bzip2/bin/bzip2.wasm" ]; }
has_xz()    { has_resolvable programs/xz.wasm || [ -f "$REPO_ROOT/examples/libs/xz/bin/xz.wasm" ]; }
has_zstd()    { has_resolvable programs/zstd.wasm || [ -f "$REPO_ROOT/examples/libs/zstd/bin/zstd.wasm" ]; }
has_zip()    { has_resolvable programs/zip.wasm || [ -f "$REPO_ROOT/examples/libs/zip/bin/zip.wasm" ]; }
has_unzip()    { has_resolvable programs/unzip.wasm || [ -f "$REPO_ROOT/examples/libs/unzip/bin/unzip.wasm" ]; }
has_nano()    { has_resolvable programs/nano.wasm || [ -f "$REPO_ROOT/examples/libs/nano/bin/nano.wasm" ]; }
has_nethack()    { has_resolvable programs/nethack.wasm || [ -f "$REPO_ROOT/examples/libs/nethack/bin/nethack.wasm" ]; }
has_fbdoom()    { has_resolvable programs/fbdoom/fbdoom.wasm || { [ -f "$REPO_ROOT/examples/libs/fbdoom/fbdoom.wasm" ] && [ -f "$REPO_ROOT/examples/libs/fbdoom/doom1.wad" ]; }; }
has_ncurses()   { [ -f "$REPO_ROOT/sysroot/lib/libncursesw.a" ]; }
has_zlib()      { [ -f "$REPO_ROOT/sysroot/lib/libz.a" ]; }
has_openssl()   { [ -f "$REPO_ROOT/sysroot/lib/libssl.a" ] && [ -f "$REPO_ROOT/sysroot/lib/libcrypto.a" ]; }
has_libcurl()   { [ -f "$REPO_ROOT/sysroot/lib/libcurl.a" ] && [ -f "$REPO_ROOT/sysroot/include/curl/curl.h" ]; }
has_vim()    { has_resolvable programs/vim.wasm || [ -f "$REPO_ROOT/examples/libs/vim/bin/vim.wasm" ]; }
has_vim_zip() { has_resolvable programs/vim.zip || [ -f "$REPO_ROOT/examples/browser/public/vim.zip" ]; }
has_git()    { has_resolvable programs/git/git.wasm || [ -f "$REPO_ROOT/examples/libs/git/bin/git.wasm" ]; }
has_perl()    { has_resolvable programs/perl.wasm || [ -f "$REPO_ROOT/examples/libs/perl/bin/perl.wasm" ]; }
has_ruby()    { has_resolvable programs/ruby.wasm || [ -f "$REPO_ROOT/examples/libs/ruby/bin/ruby.wasm" ]; }
has_dlopen()    { [ -f "$REPO_ROOT/examples/dlopen/hello-lib.so" ] && \
                  [ -f "$REPO_ROOT/examples/dlopen/main.wasm" ]; }
has_texlive()        { has_resolvable programs/pdftex.wasm || [ -f "$REPO_ROOT/examples/libs/texlive/bin/pdftex.wasm" ]; }
has_texlive_vfs() { [ -f "$REPO_ROOT/examples/browser/public/texlive-bundle.json" ]; }

# ─── Need functions (ensure dependency is built) ─────────────────────────────

need_kernel() {
    if ! has_kernel; then
        step "Building kernel"
        cd "$REPO_ROOT"
        cargo build --release -p wasm-posix-kernel \
            -Z build-std=core,alloc \
            -Z build-std-features=panic_immediate_abort
        # Mirror what build.sh does: copy to local-binaries/ (the
        # canonical override tree the binary-resolver checks). The
        # host/wasm/ copy is preserved as a legacy fallback for older
        # consumers that haven't migrated to local-binaries/.
        mkdir -p local-binaries host/wasm
        cp target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm \
            local-binaries/kernel.wasm
        cp target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm \
            host/wasm/wasm_posix_kernel.wasm
        if [ -f target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm ]; then
            cp target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm \
                local-binaries/userspace.wasm
        fi
        info "Kernel built"
    else
        info "Kernel"
    fi
}

need_sysroot() {
    if ! has_sysroot; then
        step "Building sysroot (musl)"
        bash "$REPO_ROOT/scripts/build-musl.sh"
        info "Sysroot built"
    else
        # Re-sync overlay headers into the existing sysroot. Cheap (just a
        # few cp) and ensures newly-added musl-overlay/include/ files reach
        # an existing sysroot without forcing a full musl rebuild.
        bash "$REPO_ROOT/scripts/install-overlay-headers.sh" "$REPO_ROOT/sysroot"
        info "Sysroot"
    fi
}

need_sysroot64() {
    if ! has_sysroot64; then
        step "Building sysroot64 (musl, wasm64)"
        bash "$REPO_ROOT/scripts/build-musl.sh" --arch wasm64posix
        info "Sysroot64 built"
    else
        bash "$REPO_ROOT/scripts/install-overlay-headers.sh" "$REPO_ROOT/sysroot64"
        info "Sysroot64"
    fi
}

need_sdk() {
    need_sysroot
    # The worktree-local SDK is on PATH via sdk/activate.sh (sourced at
    # the top of this script). If wasm32posix-cc still isn't found, the
    # wrappers under sdk/bin are missing or their dispatcher is broken —
    # not something `npm link` can fix.
    if ! has_sdk; then
        err "SDK tools not on PATH after sourcing sdk/activate.sh."
        err "Expected sdk/bin/wasm32posix-cc to be a working symlink."
        exit 1
    fi
    info "SDK"
}

need_host() {
    need_kernel
    if ! has_host; then
        step "Building TypeScript host"
        cd "$REPO_ROOT/host"
        npm install --prefer-offline
        npm run build
        cd "$REPO_ROOT"
        info "Host built"
    else
        info "Host"
    fi
}

need_node_modules() {
    if [ ! -d "$REPO_ROOT/node_modules" ]; then
        warn "Installing root npm dependencies"
        cd "$REPO_ROOT" && npm install --prefer-offline
    fi
}

# ─── Build targets ────────────────────────────────────────────────────────────

build_kernel() {
    need_kernel
}

build_sysroot() {
    need_sysroot
}

build_sysroot64() {
    need_sysroot64
}

build_sdk() {
    need_sdk
}

build_host() {
    need_host
}

build_programs() {
    if has_programs; then
        info "programs"
        return
    fi
    need_kernel
    need_sysroot
    if ! has_programs; then
        step "Building programs"
        bash "$REPO_ROOT/scripts/build-programs.sh"
        info "Programs built"
    else
        info "Programs"
    fi
}

build_nginx() {
    if has_nginx; then
        info "nginx"
        return
    fi
    need_kernel
    need_sdk
    if ! has_nginx; then
        step "Building nginx"
        bash "$REPO_ROOT/examples/nginx/build.sh"
        info "nginx built"
    else
        info "nginx"
    fi
}

build_php() {
    if has_php; then
        info "php"
        return
    fi
    need_kernel
    need_sdk
    if ! has_php; then
        step "Building PHP CLI"
        bash "$REPO_ROOT/examples/libs/php/build-php.sh"
        info "PHP CLI built"
    else
        info "PHP CLI"
    fi
}

build_php_fpm() {
    if has_php_fpm; then
        info "php-fpm"
        return
    fi
    need_kernel
    need_sdk
    if ! has_php_fpm; then
        step "Building PHP-FPM"
        bash "$REPO_ROOT/examples/libs/php/build-php.sh"
        info "PHP-FPM built"
    else
        info "PHP-FPM"
    fi
}

build_mariadb() {
    if has_mariadb; then
        info "mariadb"
        return
    fi
    need_kernel
    need_sdk
    if ! has_mariadb; then
        step "Building MariaDB (wasm32)"
        bash "$REPO_ROOT/examples/libs/mariadb/build-mariadb.sh"
        info "MariaDB (wasm32) built"
    else
        info "MariaDB (wasm32)"
    fi
}

build_mariadb64() {
    if has_mariadb64; then
        info "mariadb64"
        return
    fi
    need_kernel
    need_sdk
    need_sysroot64
    if ! has_mariadb64; then
        step "Building MariaDB (wasm64)"
        bash "$REPO_ROOT/examples/libs/mariadb/build-mariadb.sh" --wasm64
        info "MariaDB (wasm64) built"
    else
        info "MariaDB (wasm64)"
    fi
}

build_mariadb_vfs() {
    if has_mariadb_vfs; then
        info "MariaDB VFS image (wasm32)"
        return
    fi
    build_mariadb
    build_dash
    step "Building MariaDB VFS image (wasm32)"
    # Delegate to the package-system wrapper so install_local_binary
    # populates local-binaries/programs/wasm32/mariadb-vfs.vfs (the
    # path the @binaries/ Vite alias resolves against).
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        bash "$REPO_ROOT/examples/libs/mariadb-vfs/build-mariadb-vfs.sh"
    info "MariaDB VFS image (wasm32) built"
}

build_mariadb64_vfs() {
    if has_mariadb64_vfs; then
        info "MariaDB VFS image (wasm64)"
        return
    fi
    build_mariadb64
    build_dash
    step "Building MariaDB VFS image (wasm64)"
    WASM_POSIX_DEP_TARGET_ARCH=wasm64 \
        bash "$REPO_ROOT/examples/libs/mariadb-vfs/build-mariadb-vfs.sh"
    info "MariaDB VFS image (wasm64) built"
}

build_wordpress() {
    if ! has_wordpress; then
        step "Downloading WordPress"
        bash "$REPO_ROOT/examples/wordpress/setup.sh"
        info "WordPress downloaded"
    else
        info "WordPress"
    fi
}

build_wp_vfs() {
    if has_wp_vfs; then
        info "WP VFS image"
        return
    fi
    # Source needed only if we have to build the VFS from scratch.
    build_wordpress
    step "Building WordPress VFS image"
    # Delegate to the package-system wrapper so install_local_binary
    # populates local-binaries/programs/wasm32/wordpress.vfs (the path
    # the @binaries/ Vite alias resolves against).
    bash "$REPO_ROOT/examples/libs/wordpress/build-wordpress.sh"
    info "WP VFS image built"
}

build_dash() {
    if has_dash; then
        info "dash"
        return
    fi
    need_kernel
    need_sdk
    if ! has_dash; then
        step "Building dash shell"
        bash "$REPO_ROOT/examples/libs/dash/build-dash.sh"
        info "dash built"
    else
        info "dash"
    fi
    # host/wasm/sh.wasm is dash — needed by vitest and run-example.ts
    if [ -f "$REPO_ROOT/examples/libs/dash/bin/dash.wasm" ] && [ ! -f "$REPO_ROOT/host/wasm/sh.wasm" ]; then
        mkdir -p "$REPO_ROOT/host/wasm"
        cp "$REPO_ROOT/examples/libs/dash/bin/dash.wasm" "$REPO_ROOT/host/wasm/sh.wasm"
    fi
}

build_bash() {
    if has_bash; then
        info "bash"
        return
    fi
    # bash's build script resolves ncurses through the dep cache via
    # `cargo xtask build-deps resolve ncurses` — no sysroot install
    # needed here.
    need_kernel
    need_sdk
    step "Building bash shell"
    bash "$REPO_ROOT/examples/libs/bash/build-bash.sh"
    info "bash built"
}

build_coreutils() {
    if has_coreutils; then
        info "coreutils"
        return
    fi
    need_kernel
    need_sdk
    if ! has_coreutils; then
        step "Building GNU coreutils"
        bash "$REPO_ROOT/examples/libs/coreutils/build-coreutils.sh"
        info "coreutils built"
    else
        info "coreutils"
    fi
}

build_grep() {
    if has_grep; then
        info "grep"
        return
    fi
    need_kernel
    need_sdk
    if ! has_grep; then
        step "Building GNU grep"
        bash "$REPO_ROOT/examples/libs/grep/build-grep.sh"
        info "grep built"
    else
        info "grep"
    fi
}

build_sed() {
    if has_sed; then
        info "sed"
        return
    fi
    need_kernel
    need_sdk
    if ! has_sed; then
        step "Building GNU sed"
        bash "$REPO_ROOT/examples/libs/sed/build-sed.sh"
        info "sed built"
    else
        info "sed"
    fi
}

build_redis() {
    if has_redis; then
        info "redis"
        return
    fi
    need_kernel
    need_sdk
    if ! has_redis; then
        step "Building Redis"
        bash "$REPO_ROOT/examples/libs/redis/build-redis.sh"
        info "Redis built"
    else
        info "Redis"
    fi
}

build_dinit() {
    need_kernel
    need_sdk
    # dinit uses libc++ which the mariadb build script installs into
    # the sysroot. Force a mariadb build first if libc++ isn't there
    # — it's the cheapest path to get the headers + library set up.
    if [ ! -f "$REPO_ROOT/sysroot/lib/libc++.a" ]; then
        build_mariadb
    fi
    if ! has_dinit; then
        step "Building dinit"
        bash "$REPO_ROOT/examples/libs/dinit/build-dinit.sh"
        info "dinit built"
    else
        info "dinit"
    fi
}

build_cpython() {
    if has_cpython; then
        info "cpython"
        return
    fi
    need_kernel
    need_sdk
    if ! has_cpython; then
        step "Building CPython 3.13"
        bash "$REPO_ROOT/examples/libs/cpython/build-cpython.sh"
        info "CPython built"
    else
        info "CPython"
    fi
}

build_python_vfs() {
    if has_python_vfs; then
        info "Python VFS image"
        return
    fi
    build_cpython
    step "Building Python VFS image"
    bash "$REPO_ROOT/examples/browser/scripts/build-python-vfs-image.sh"
    info "Python VFS image built"
}

build_perl_vfs() {
    if ! has_perl_vfs; then
        if [ ! -f "$REPO_ROOT/examples/libs/perl/perl-src/lib/strict.pm" ]; then
            warn "Perl source not found, skipping perl VFS image"
            return
        fi
        step "Building Perl VFS image"
        bash "$REPO_ROOT/examples/browser/scripts/build-perl-vfs-image.sh"
        info "Perl VFS image built"
    else
        info "Perl VFS image"
    fi
}

build_vim_zip() {
    if has_vim_zip; then
        info "vim.zip"
        return
    fi

    # vim.zip = vim.wasm + minimal runtime tree, packaged for the
    # browser shell demo's lazy-archive fetch. Vim's release archive
    # ships both pieces (build-vim.sh stages runtime/ alongside
    # vim.wasm into the resolver scratch), so this builder just locates
    # the cache canonical dir and rezips. No upstream source download.
    local vim_dir
    vim_dir="$(cargo run -p xtask --target aarch64-apple-darwin --quiet -- \
        build-deps resolve vim --arch wasm32 2>/dev/null)" || {
        warn "vim package could not be resolved — run: ./run.sh build vim"
        return
    }
    if [ ! -f "$vim_dir/vim.wasm" ] || [ ! -d "$vim_dir/runtime" ]; then
        warn "vim cache at $vim_dir is missing vim.wasm or runtime/ — re-fetch the release"
        return
    fi

    step "Packaging vim.zip from cached vim package"
    local stage out
    stage="$(mktemp -d)"
    out="$REPO_ROOT/examples/browser/public/vim.zip"
    mkdir -p "$stage/bin" "$stage/share/vim/vim91" "$(dirname "$out")"
    cp "$vim_dir/vim.wasm" "$stage/bin/vim"
    chmod 755 "$stage/bin/vim"
    rsync -a "$vim_dir/runtime/" "$stage/share/vim/vim91/"
    rm -f "$out"
    (cd "$stage" && zip -r -q "$out" .)
    rm -rf "$stage"
    # shellcheck source=scripts/install-local-binary.sh
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary vim "$out"
    info "vim.zip built ($(du -h "$out" | cut -f1))"
}

build_nethack_zip() {
    if [ ! -f "$REPO_ROOT/examples/browser/public/nethack.zip" ]; then
        if [ ! -d "$REPO_ROOT/examples/libs/nethack/runtime/share/nethack" ]; then
            warn "NetHack runtime not found, skipping nethack.zip"
            return
        fi
        step "Building nethack.zip (binary + runtime)"
        bash "$REPO_ROOT/examples/browser/scripts/build-nethack-zip.sh"
        info "nethack.zip built"
    else
        info "nethack.zip"
    fi
}

build_shell_vfs() {
    if ! has_shell_vfs; then
        build_vim_zip
        build_nethack_zip
        step "Building Shell VFS image"
        bash "$REPO_ROOT/examples/browser/scripts/build-shell-vfs-image.sh"
        info "Shell VFS image built"
    else
        info "Shell VFS image"
    fi
}

build_erlang() {
    if has_erlang; then
        info "erlang"
        return
    fi
    need_kernel
    need_sdk
    if ! has_erlang; then
        step "Building Erlang/OTP 28 BEAM"
        bash "$REPO_ROOT/examples/libs/erlang/build-erlang.sh"
        # Build script puts beam.wasm at erlang/ root; browser+serve expect bin/
        local erlang_dir="$REPO_ROOT/examples/libs/erlang"
        if [ -f "$erlang_dir/beam.wasm" ] && [ ! -f "$erlang_dir/bin/beam.wasm" ]; then
            mkdir -p "$erlang_dir/bin"
            cp "$erlang_dir/beam.wasm" "$erlang_dir/bin/beam.wasm"
        fi
        info "Erlang built"
    else
        info "Erlang"
    fi
}

build_erlang_vfs() {
    if has_erlang_vfs; then
        info "Erlang VFS image"
        return
    fi
    build_erlang
    step "Building Erlang VFS image"
    bash "$REPO_ROOT/examples/browser/scripts/build-erlang-vfs-image.sh"
    info "Erlang VFS image built"
}

build_lamp_vfs() {
    if has_lamp_vfs; then
        info "LAMP VFS image"
        return
    fi
    build_wordpress
    step "Building LAMP VFS image"
    # Delegate to the package-system wrapper so install_local_binary
    # populates local-binaries/programs/wasm32/lamp.vfs (the path the
    # @binaries/ Vite alias resolves against).
    bash "$REPO_ROOT/examples/libs/lamp/build-lamp.sh"
    info "LAMP VFS image built"
}

build_nginx_vfs() {
    build_dinit
    build_nginx
    if ! has_nginx_vfs; then
        step "Building nginx VFS image"
        bash "$REPO_ROOT/examples/browser/scripts/build-nginx-vfs-image.sh"
        info "nginx VFS image built"
    else
        info "nginx VFS image"
    fi
}

build_redis_vfs() {
    build_dinit
    build_redis
    if ! has_redis_vfs; then
        step "Building Redis VFS image"
        bash "$REPO_ROOT/examples/browser/scripts/build-redis-vfs-image.sh"
        info "Redis VFS image built"
    else
        info "Redis VFS image"
    fi
}

build_nginx_php_vfs() {
    build_dinit
    build_nginx
    build_php_fpm
    if ! has_nginx_php_vfs; then
        step "Building nginx + PHP-FPM VFS image"
        bash "$REPO_ROOT/examples/browser/scripts/build-nginx-php-vfs-image.sh"
        info "nginx + PHP-FPM VFS image built"
    else
        info "nginx + PHP-FPM VFS image"
    fi
}

build_texlive() {
    if has_texlive; then
        info "texlive"
        return
    fi
    need_kernel
    need_sdk
    if ! has_texlive; then
        step "Building pdftex (TeX Live)"
        bash "$REPO_ROOT/examples/libs/texlive/build-texlive.sh"
        info "pdftex built"
    else
        info "pdftex (TeX Live)"
    fi
}

build_texlive_vfs() {
    if has_texlive_vfs; then
        info "TeX Live bundle"
        return
    fi
    # The bundle isn't a release artifact — it's a JSON dump of the
    # texlive runtime tree, only built locally. Without a host pdftex
    # (built by `bash examples/libs/texlive/build-texlive.sh`), the
    # bundle script fails. Skip with a clear hint instead of breaking
    # the browser bring-up — the texlive demo will surface the missing
    # bundle to the user.
    local host_pdftex="$REPO_ROOT/examples/libs/texlive/texlive-build/host/bin/pdftex"
    if [ ! -x "$host_pdftex" ]; then
        warn "Skipping TeX Live bundle (host pdftex not built — run: bash examples/libs/texlive/build-texlive.sh)"
        return
    fi
    build_texlive
    step "Building TeX Live browser bundle"
    bash "$REPO_ROOT/examples/browser/scripts/build-texlive-bundle.sh"
    info "TeX Live bundle built"
}

build_bc() {
    if has_bc; then
        info "bc"
        return
    fi
    need_kernel
    need_sdk
    if ! has_bc; then
        step "Building bc"
        bash "$REPO_ROOT/examples/libs/bc/build-bc.sh"
        info "bc built"
    else
        info "bc"
    fi
}

build_file() {
    if has_file; then
        info "file"
        return
    fi
    need_kernel
    need_sdk
    if ! has_file; then
        step "Building file"
        bash "$REPO_ROOT/examples/libs/file/build-file.sh"
        info "file built"
    else
        info "file"
    fi
}

build_less() {
    if has_less; then
        info "less"
        return
    fi
    need_kernel
    need_sdk
    if ! has_less; then
        step "Building less"
        bash "$REPO_ROOT/examples/libs/less/build-less.sh"
        info "less built"
    else
        info "less"
    fi
}

build_m4() {
    if has_m4; then
        info "m4"
        return
    fi
    need_kernel
    need_sdk
    if ! has_m4; then
        step "Building m4"
        bash "$REPO_ROOT/examples/libs/m4/build-m4.sh"
        info "m4 built"
    else
        info "m4"
    fi
}

build_make() {
    if has_make; then
        info "make"
        return
    fi
    need_kernel
    need_sdk
    if ! has_make; then
        step "Building make"
        bash "$REPO_ROOT/examples/libs/make/build-make.sh"
        info "make built"
    else
        info "make"
    fi
}

build_tar() {
    if has_tar; then
        info "tar"
        return
    fi
    need_kernel
    need_sdk
    if ! has_tar; then
        step "Building tar"
        bash "$REPO_ROOT/examples/libs/tar/build-tar.sh"
        info "tar built"
    else
        info "tar"
    fi
}

build_curl_cli() {
    if has_curl; then
        info "curl"
        return
    fi
    need_kernel
    need_sdk
    # libcurl's build script produces both libcurl.a and the curl CLI.
    step "Building curl (CLI)"
    bash "$REPO_ROOT/examples/libs/libcurl/build-libcurl.sh"
    info "curl built"
}

build_wget() {
    if has_wget; then
        info "wget"
        return
    fi
    need_kernel
    need_sdk
    if ! has_wget; then
        step "Building wget"
        bash "$REPO_ROOT/examples/libs/wget/build-wget.sh"
        info "wget built"
    else
        info "wget"
    fi
}

build_gzip() {
    if has_gzip; then
        info "gzip"
        return
    fi
    need_kernel
    need_sdk
    if ! has_gzip; then
        step "Building gzip"
        bash "$REPO_ROOT/examples/libs/gzip/build-gzip.sh"
        info "gzip built"
    else
        info "gzip"
    fi
}

build_bzip2() {
    if has_bzip2; then
        info "bzip2"
        return
    fi
    need_kernel
    need_sdk
    if ! has_bzip2; then
        step "Building bzip2"
        bash "$REPO_ROOT/examples/libs/bzip2/build-bzip2.sh"
        info "bzip2 built"
    else
        info "bzip2"
    fi
}

build_xz() {
    if has_xz; then
        info "xz"
        return
    fi
    need_kernel
    need_sdk
    if ! has_xz; then
        step "Building xz"
        bash "$REPO_ROOT/examples/libs/xz/build-xz.sh"
        info "xz built"
    else
        info "xz"
    fi
}

build_zstd() {
    if has_zstd; then
        info "zstd"
        return
    fi
    need_kernel
    need_sdk
    if ! has_zstd; then
        step "Building zstd"
        bash "$REPO_ROOT/examples/libs/zstd/build-zstd.sh"
        info "zstd built"
    else
        info "zstd"
    fi
}

build_zip() {
    if has_zip; then
        info "zip"
        return
    fi
    need_kernel
    need_sdk
    if ! has_zip; then
        step "Building zip"
        bash "$REPO_ROOT/examples/libs/zip/build-zip.sh"
        info "zip built"
    else
        info "zip"
    fi
}

build_unzip() {
    if has_unzip; then
        info "unzip"
        return
    fi
    need_kernel
    need_sdk
    if ! has_unzip; then
        step "Building unzip"
        bash "$REPO_ROOT/examples/libs/unzip/build-unzip.sh"
        info "unzip built"
    else
        info "unzip"
    fi
}

build_nano() {
    if has_nano; then
        info "nano"
        return
    fi
    # nano's build script resolves ncurses through the dep cache itself
    # (`cargo xtask build-deps resolve ncurses`); no sysroot prep here.
    need_kernel
    need_sdk
    step "Building nano"
    bash "$REPO_ROOT/examples/libs/nano/build-nano.sh"
    info "nano built"
}

build_zlib() {
    if has_zlib; then
        info "zlib"
        return
    fi
    need_kernel
    need_sdk
    if ! has_zlib; then
        step "Building zlib"
        bash "$REPO_ROOT/examples/libs/zlib/build-zlib.sh"
        # Install into sysroot
        local ZLIB_DIR="$REPO_ROOT/examples/libs/zlib/zlib-install"
        local SYSROOT="$REPO_ROOT/sysroot"
        cp "$ZLIB_DIR/include/zlib.h" "$ZLIB_DIR/include/zconf.h" "$SYSROOT/include/"
        cp "$ZLIB_DIR/lib/libz.a" "$SYSROOT/lib/"
        mkdir -p "$SYSROOT/lib/pkgconfig"
        sed "s|^prefix=.*|prefix=$SYSROOT|" "$ZLIB_DIR/lib/pkgconfig/zlib.pc" \
            > "$SYSROOT/lib/pkgconfig/zlib.pc"
        info "zlib built"
    else
        info "zlib"
    fi
}

build_openssl() {
    if has_openssl; then
        info "openssl"
        return
    fi
    need_kernel
    need_sdk
    if ! has_openssl; then
        step "Building OpenSSL"
        bash "$REPO_ROOT/examples/libs/openssl/build-openssl.sh"
        # Install into sysroot
        local OPENSSL_DIR="$REPO_ROOT/examples/libs/openssl/openssl-install"
        local SYSROOT="$REPO_ROOT/sysroot"
        # OpenSSL installs to lib/ or lib64/ depending on platform
        local LIBDIR="$OPENSSL_DIR/lib"
        [ -f "$LIBDIR/libssl.a" ] || LIBDIR="$OPENSSL_DIR/lib64"
        cp "$LIBDIR/libssl.a" "$LIBDIR/libcrypto.a" "$SYSROOT/lib/"
        cp -r "$OPENSSL_DIR/include/openssl" "$SYSROOT/include/"
        mkdir -p "$SYSROOT/lib/pkgconfig"
        for pc in libssl.pc libcrypto.pc openssl.pc; do
            if [ -f "$LIBDIR/pkgconfig/$pc" ]; then
                sed "s|^prefix=.*|prefix=$SYSROOT|" "$LIBDIR/pkgconfig/$pc" \
                    > "$SYSROOT/lib/pkgconfig/$pc"
            fi
        done
        info "OpenSSL built"
    else
        info "OpenSSL"
    fi
}

build_libcurl() {
    if has_libcurl; then
        info "libcurl"
        return
    fi
    # libcurl's build script resolves zlib + openssl through the dep cache.
    need_kernel
    need_sdk
    if ! has_libcurl; then
        step "Building libcurl"
        # Force reconfigure if curl was previously built without SSL
        local CURL_SRC="$REPO_ROOT/examples/libs/libcurl/curl-src"
        if [ -f "$CURL_SRC/Makefile" ]; then
            rm -f "$CURL_SRC/Makefile"
        fi
        bash "$REPO_ROOT/examples/libs/libcurl/build-libcurl.sh"
        # Install libcurl + headers into sysroot
        local SYSROOT="$REPO_ROOT/sysroot"
        cp "$CURL_SRC/lib/.libs/libcurl.a" "$SYSROOT/lib/"
        mkdir -p "$SYSROOT/include/curl"
        cp "$CURL_SRC/include/curl"/*.h "$SYSROOT/include/curl/"
        mkdir -p "$SYSROOT/lib/pkgconfig"
        if [ -f "$CURL_SRC/libcurl.pc" ]; then
            sed "s|^prefix=.*|prefix=$SYSROOT|" "$CURL_SRC/libcurl.pc" \
                > "$SYSROOT/lib/pkgconfig/libcurl.pc"
        fi
        info "libcurl built"
    else
        info "libcurl"
    fi
}

build_ncurses() {
    if has_ncurses; then
        info "ncurses"
        return
    fi
    need_kernel
    need_sdk
    if ! has_ncurses; then
        step "Building ncurses"
        bash "$REPO_ROOT/examples/libs/ncurses/build-ncurses.sh"
        info "ncurses built"
    else
        info "ncurses"
    fi
}

build_nethack() {
    if has_nethack; then
        info "NetHack"
        return
    fi
    # nethack's build script resolves ncurses through the dep cache.
    need_kernel
    need_sdk
    step "Building NetHack"
    bash "$REPO_ROOT/examples/libs/nethack/build-nethack.sh"
    info "NetHack built"
}

build_fbdoom() {
    if has_fbdoom; then
        info "fbDOOM"
        return
    fi
    need_kernel
    need_sdk
    step "Building fbDOOM"
    bash "$REPO_ROOT/examples/libs/fbdoom/build-fbdoom.sh"
    info "fbDOOM built"
}

build_vim() {
    if has_vim; then
        info "Vim"
        return
    fi
    # Vim's build script now resolves ncurses through the dep cache
    # (`cargo xtask build-deps resolve ncurses`), so we don't prep it
    # into the sysroot here.
    need_kernel
    need_sdk
    step "Building Vim"
    bash "$REPO_ROOT/examples/libs/vim/build-vim.sh"
    info "Vim built"
}

build_git() {
    if has_git; then
        info "git"
        return
    fi
    # git's build script resolves zlib/openssl/curl through the dep
    # cache itself; no sysroot prep here.
    need_kernel
    need_sdk
    step "Building git"
    bash "$REPO_ROOT/examples/libs/git/build-git.sh"
    info "git built"
    # Stub git-remote-http.wasm for browser demo if build somehow
    # didn't produce one (e.g. user skipped curl resolution manually).
    if [ ! -f "$REPO_ROOT/examples/libs/git/bin/git-remote-http.wasm" ]; then
        mkdir -p "$REPO_ROOT/examples/libs/git/bin"
        printf '\x00asm\x01\x00\x00\x00' > "$REPO_ROOT/examples/libs/git/bin/git-remote-http.wasm"
    fi
}

build_perl() {
    if has_perl; then
        info "perl"
        return
    fi
    need_kernel
    need_sdk
    if ! has_perl; then
        step "Building Perl"
        bash "$REPO_ROOT/examples/libs/perl/build-perl.sh"
        info "Perl built"
    else
        info "Perl"
    fi
}

build_ruby() {
    if has_ruby; then
        info "ruby"
        return
    fi
    need_kernel
    need_sdk
    if ! has_ruby; then
        step "Building Ruby"
        bash "$REPO_ROOT/examples/libs/ruby/build-ruby.sh"
        info "Ruby built"
    else
        info "Ruby"
    fi
}

build_dlopen() {
    if has_dlopen; then
        info "dlopen"
        return
    fi
    need_sysroot
    if ! has_dlopen; then
        step "Building dlopen example"
        bash "$REPO_ROOT/examples/dlopen/build.sh"
        info "dlopen built"
    else
        info "dlopen"
    fi
}

build_target() {
    local target="$1"
    case "$target" in
        kernel)     build_kernel ;;
        sysroot)    build_sysroot ;;
        sysroot64)  build_sysroot64 ;;
        sdk)        build_sdk ;;
        host)       build_host ;;
        programs)   build_programs ;;
        nginx)      build_nginx ;;
        php)        build_php ;;
        php-fpm)    build_php_fpm ;;
        dash)       build_dash ;;
        bash)       build_bash ;;
        coreutils)  build_coreutils ;;
        grep)       build_grep ;;
        sed)        build_sed ;;
        mariadb)    build_mariadb ;;
        mariadb64)  build_mariadb64 ;;
        mariadb-vfs) build_mariadb_vfs ;;
        mariadb64-vfs) build_mariadb64_vfs ;;
        redis)      build_redis ;;
        dinit)      build_dinit ;;
        cpython)    build_cpython ;;
        python-vfs) build_python_vfs ;;
        perl-vfs)   build_perl_vfs ;;
        shell-vfs)  build_shell_vfs ;;
        wordpress)  build_wordpress ;;
        wp-vfs)     build_wp_vfs ;;
        erlang)     build_erlang ;;
        erlang-vfs) build_erlang_vfs ;;
        lamp-vfs)   build_lamp_vfs ;;
        nginx-vfs)  build_nginx_vfs ;;
        redis-vfs)  build_redis_vfs ;;
        nginx-php-vfs) build_nginx_php_vfs ;;
        bc)         build_bc ;;
        file)       build_file ;;
        less)       build_less ;;
        m4)         build_m4 ;;
        make)       build_make ;;
        tar)        build_tar ;;
        curl-cli)   build_curl_cli ;;
        wget)       build_wget ;;
        gzip)       build_gzip ;;
        bzip2)      build_bzip2 ;;
        xz)         build_xz ;;
        zstd)       build_zstd ;;
        zip)        build_zip ;;
        unzip)      build_unzip ;;
        nano)       build_nano ;;
        nethack)    build_nethack ;;
        fbdoom)     build_fbdoom ;;
        ncurses)    build_ncurses ;;
        zlib)       build_zlib ;;
        openssl)    build_openssl ;;
        libcurl)    build_libcurl ;;
        vim)        build_vim ;;
        vim-zip)    build_vim_zip ;;
        git)        build_git ;;
        perl)       build_perl ;;
        ruby)       build_ruby ;;
        dlopen)     build_dlopen ;;
        texlive)    build_texlive ;;
        texlive-vfs) build_texlive_vfs ;;
        browser)    build_browser ;;
        all)        build_all ;;
        *)          err "Unknown build target: $target"; cmd_list; exit 1 ;;
    esac
}

# All targets needed for browser demos. Each entry's `has_X` short-
# circuits when its release binary is in `binaries/`, so this loop is
# a no-op on a fully-fetched checkout. sysroot/sysroot64 are NOT
# listed: they're toolchain prerequisites for source builds, and any
# `build_X` whose prebuilt is missing calls `need_sysroot` lazily.
# `less` and `wget` are omitted — both have known local-build failures
# (less: ncurses libtermcap duplicate tputs; wget: requires automake
# aclocal). They aren't in the release either, so the associated demo
# features skip gracefully at runtime.
BROWSER_DEPS=(kernel programs dash bash coreutils grep sed bc file m4 make tar curl-cli gzip bzip2 xz zstd zip unzip nano vim vim-zip nethack fbdoom git dinit nginx nginx-vfs php php-fpm nginx-php-vfs mariadb mariadb-vfs mariadb64 mariadb64-vfs redis redis-vfs cpython python-vfs perl perl-vfs ruby shell-vfs wp-vfs lamp-vfs erlang erlang-vfs texlive texlive-vfs)

build_browser() {
    for t in "${BROWSER_DEPS[@]}"; do
        build_target "$t"
    done
}

build_all() {
    build_kernel
    build_sysroot
    build_sdk
    build_host
    build_programs
    build_dash
    build_bash
    build_coreutils
    build_grep
    build_sed
    build_bc
    build_file
    build_less
    build_m4
    build_make
    build_tar
    build_curl_cli
    build_wget
    build_gzip
    build_bzip2
    build_xz
    build_zstd
    build_zip
    build_unzip
    build_nano
    build_vim
    build_nethack
    build_git
    build_nginx
    build_php
    build_php_fpm
    build_mariadb
    build_mariadb_vfs
    build_redis
    build_dinit
    build_cpython
    build_python_vfs
    build_perl
    build_perl_vfs
    build_ruby
    build_shell_vfs
    build_wordpress
    build_wp_vfs
    build_lamp_vfs
    build_erlang
    build_erlang_vfs
    build_texlive
    build_texlive_vfs
    build_dlopen
}

# ─── Clean targets ────────────────────────────────────────────────────────────

clean_target() {
    local target="$1"
    case "$target" in
        kernel)
            rm -f "$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm" \
                  "$REPO_ROOT/host/wasm/wasm_posix_userspace.wasm"
            rm -rf "$REPO_ROOT/target/wasm64-unknown-unknown/" "$REPO_ROOT/target/wasm32-unknown-unknown/"
            warn "Cleaned kernel" ;;
        sysroot)
            rm -rf "$REPO_ROOT/sysroot"
            warn "Cleaned sysroot" ;;
        sysroot64)
            rm -rf "$REPO_ROOT/sysroot64"
            warn "Cleaned sysroot64" ;;
        sdk)
            warn "SDK is worktree-local (sdk/bin wrappers + activate.sh)."
            warn "Nothing to clean. If you previously ran 'npm link', remove it with: (cd sdk && npm unlink)"
            ;;
        host)
            rm -rf "$REPO_ROOT/host/dist"
            warn "Cleaned host" ;;
        programs)
            rm -f "$REPO_ROOT/host/wasm/fork-exec.wasm"
            rm -f "$REPO_ROOT/host/wasm/"*.wasm 2>/dev/null || true
            # Keep kernel wasm files
            if [ -f "$REPO_ROOT/target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm" ]; then
                mkdir -p "$REPO_ROOT/host/wasm"
                cp "$REPO_ROOT/target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm" "$REPO_ROOT/host/wasm/"
            fi
            warn "Cleaned programs" ;;
        dash)
            rm -rf "$REPO_ROOT/examples/libs/dash/dash-src" \
                   "$REPO_ROOT/examples/libs/dash/bin"
            warn "Cleaned dash" ;;
        bash)
            rm -rf "$REPO_ROOT/examples/libs/bash/bash-src" \
                   "$REPO_ROOT/examples/libs/bash/bin"
            warn "Cleaned bash" ;;
        coreutils)
            rm -rf "$REPO_ROOT/examples/libs/coreutils/coreutils-src" \
                   "$REPO_ROOT/examples/libs/coreutils/bin"
            warn "Cleaned coreutils" ;;
        grep)
            rm -rf "$REPO_ROOT/examples/libs/grep/grep-src" \
                   "$REPO_ROOT/examples/libs/grep/bin"
            warn "Cleaned grep" ;;
        sed)
            rm -rf "$REPO_ROOT/examples/libs/sed/sed-src" \
                   "$REPO_ROOT/examples/libs/sed/bin"
            warn "Cleaned sed" ;;
        nginx)
            rm -rf "$REPO_ROOT/examples/nginx/nginx-src"
            rm -f "$REPO_ROOT/examples/nginx/nginx.wasm"
            warn "Cleaned nginx" ;;
        php)
            rm -rf "$REPO_ROOT/examples/libs/php/php-src" \
                   "$REPO_ROOT/examples/libs/php/php-install"
            warn "Cleaned PHP CLI" ;;
        php-fpm)
            rm -f "$REPO_ROOT/examples/nginx/php-fpm.wasm"
            rm -rf "$REPO_ROOT/examples/nginx/php-fpm-src"
            warn "Cleaned PHP-FPM" ;;
        mariadb)
            rm -rf "$REPO_ROOT/examples/libs/mariadb/mariadb-src" \
                   "$REPO_ROOT/examples/libs/mariadb/mariadb-install" \
                   "$REPO_ROOT/examples/libs/mariadb/mariadb-cross-build" \
                   "$REPO_ROOT/examples/libs/mariadb/mariadb-glue-objs" \
                   "$REPO_ROOT/examples/libs/mariadb/mariadb-host-build" \
                   "$REPO_ROOT/examples/libs/mariadb/pcre2-"* \
                   "$REPO_ROOT/examples/libs/mariadb/pcre2-wasm-build"
            ;;
        mariadb64)
            rm -rf "$REPO_ROOT/examples/libs/mariadb/mariadb-install-64" \
                   "$REPO_ROOT/examples/libs/mariadb/mariadb-cross-build-64" \
                   "$REPO_ROOT/examples/libs/mariadb/mariadb-glue-objs-64"
            warn "Cleaned MariaDB" ;;
        mariadb-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/mariadb.vfs" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/mariadb-vfs.vfs"
            warn "Cleaned MariaDB VFS image (wasm32)" ;;
        mariadb64-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/mariadb-64.vfs" \
                  "$REPO_ROOT/local-binaries/programs/wasm64/mariadb-vfs.vfs"
            warn "Cleaned MariaDB VFS image (wasm64)" ;;
        redis)
            rm -rf "$REPO_ROOT/examples/libs/redis/redis-src" \
                   "$REPO_ROOT/examples/libs/redis/bin"
            warn "Cleaned Redis" ;;
        dinit)
            rm -rf "$REPO_ROOT/examples/libs/dinit/dinit-src" \
                   "$REPO_ROOT/examples/libs/dinit/bin"
            warn "Cleaned dinit" ;;
        cpython)
            rm -rf "$REPO_ROOT/examples/libs/cpython/cpython-src" \
                   "$REPO_ROOT/examples/libs/cpython/cpython-host-build" \
                   "$REPO_ROOT/examples/libs/cpython/cpython-cross-build" \
                   "$REPO_ROOT/examples/libs/cpython/cpython-install" \
                   "$REPO_ROOT/examples/libs/cpython/bin"
            warn "Cleaned CPython" ;;
        python-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/python.vfs"
            warn "Cleaned Python VFS image" ;;
        perl-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/perl.vfs"
            warn "Cleaned Perl VFS image" ;;
        shell-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/shell.vfs"
            warn "Cleaned Shell VFS image" ;;
        wordpress)
            rm -rf "$REPO_ROOT/examples/wordpress/wordpress"
            warn "Cleaned WordPress" ;;
        wp-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/wordpress.vfs" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/wordpress.vfs"
            warn "Cleaned WP VFS image" ;;
        lamp-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/lamp.vfs" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/lamp.vfs"
            warn "Cleaned LAMP VFS image" ;;
        nginx-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/nginx.vfs" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/nginx-vfs.vfs"
            warn "Cleaned nginx VFS image" ;;
        redis-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/redis.vfs" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/redis-vfs.vfs"
            warn "Cleaned Redis VFS image" ;;
        nginx-php-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/nginx-php.vfs" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/nginx-php-vfs.vfs"
            warn "Cleaned nginx + PHP-FPM VFS image" ;;
        erlang)
            rm -rf "$REPO_ROOT/examples/libs/erlang/erlang-src" \
                   "$REPO_ROOT/examples/libs/erlang/erlang-install" \
                   "$REPO_ROOT/examples/libs/erlang/bin"
            warn "Cleaned Erlang" ;;
        erlang-vfs)
            rm -f "$REPO_ROOT/examples/browser/public/erlang.vfs"
            warn "Cleaned Erlang VFS image" ;;
        bc)
            rm -rf "$REPO_ROOT/examples/libs/bc/bc-src" \
                   "$REPO_ROOT/examples/libs/bc/bin"
            warn "Cleaned bc" ;;
        file)
            rm -rf "$REPO_ROOT/examples/libs/file/file-src" \
                   "$REPO_ROOT/examples/libs/file/bin"
            warn "Cleaned file" ;;
        less)
            rm -rf "$REPO_ROOT/examples/libs/less/less-src" \
                   "$REPO_ROOT/examples/libs/less/bin"
            warn "Cleaned less" ;;
        m4)
            rm -rf "$REPO_ROOT/examples/libs/m4/m4-src" \
                   "$REPO_ROOT/examples/libs/m4/bin"
            warn "Cleaned m4" ;;
        make)
            rm -rf "$REPO_ROOT/examples/libs/make/make-src" \
                   "$REPO_ROOT/examples/libs/make/bin"
            warn "Cleaned make" ;;
        tar)
            rm -rf "$REPO_ROOT/examples/libs/tar/tar-src" \
                   "$REPO_ROOT/examples/libs/tar/bin"
            warn "Cleaned tar" ;;
        curl-cli)
            rm -rf "$REPO_ROOT/examples/libs/curl/curl-src" \
                   "$REPO_ROOT/examples/libs/curl/bin"
            warn "Cleaned curl" ;;
        wget)
            rm -rf "$REPO_ROOT/examples/libs/wget/wget-src" \
                   "$REPO_ROOT/examples/libs/wget/bin"
            warn "Cleaned wget" ;;
        gzip)
            rm -rf "$REPO_ROOT/examples/libs/gzip/gzip-src" \
                   "$REPO_ROOT/examples/libs/gzip/bin"
            warn "Cleaned gzip" ;;
        bzip2)
            rm -rf "$REPO_ROOT/examples/libs/bzip2/bzip2-src" \
                   "$REPO_ROOT/examples/libs/bzip2/bin"
            warn "Cleaned bzip2" ;;
        xz)
            rm -rf "$REPO_ROOT/examples/libs/xz/xz-src" \
                   "$REPO_ROOT/examples/libs/xz/bin"
            warn "Cleaned xz" ;;
        zstd)
            rm -rf "$REPO_ROOT/examples/libs/zstd/zstd-src" \
                   "$REPO_ROOT/examples/libs/zstd/bin"
            warn "Cleaned zstd" ;;
        zip)
            rm -rf "$REPO_ROOT/examples/libs/zip/zip-src" \
                   "$REPO_ROOT/examples/libs/zip/bin"
            warn "Cleaned zip" ;;
        unzip)
            rm -rf "$REPO_ROOT/examples/libs/unzip/unzip-src" \
                   "$REPO_ROOT/examples/libs/unzip/bin"
            warn "Cleaned unzip" ;;
        nano)
            rm -rf "$REPO_ROOT/examples/libs/nano/nano-src" \
                   "$REPO_ROOT/examples/libs/nano/bin"
            warn "Cleaned nano" ;;
        nethack)
            rm -rf "$REPO_ROOT/examples/libs/nethack/nethack-src" \
                   "$REPO_ROOT/examples/libs/nethack/bin" \
                   "$REPO_ROOT/examples/libs/nethack/runtime"
            rm -f "$REPO_ROOT/examples/browser/public/nethack.zip" \
                  "$REPO_ROOT/examples/browser/public/shell.vfs"
            warn "Cleaned NetHack (also invalidated nethack.zip and shell.vfs; run '$0 build shell-vfs' to regenerate for browser demo)" ;;
        fbdoom)
            rm -rf "$REPO_ROOT/examples/libs/fbdoom/fbdoom-src" \
                   "$REPO_ROOT/local-binaries/programs/wasm32/fbdoom"
            rm -f "$REPO_ROOT/examples/libs/fbdoom/fbdoom.wasm" \
                  "$REPO_ROOT/examples/libs/fbdoom/doom1.wad" \
                  "$REPO_ROOT/examples/libs/fbdoom/COPYING.txt" \
                  "$REPO_ROOT/examples/libs/fbdoom/CREDITS.txt" \
                  "$REPO_ROOT/examples/libs/fbdoom/CREDITS-MUSIC.txt"
            warn "Cleaned fbDOOM" ;;
        ncurses)
            rm -rf "$REPO_ROOT/examples/libs/ncurses/ncurses-src"
            # ncurses installs into sysroot, cleaned with sysroot
            warn "Cleaned ncurses (rebuild sysroot to fully clean)" ;;
        zlib)
            rm -rf "$REPO_ROOT/examples/libs/zlib/zlib-src" \
                   "$REPO_ROOT/examples/libs/zlib/zlib-install"
            # zlib installs into sysroot, cleaned with sysroot
            warn "Cleaned zlib (rebuild sysroot to fully clean)" ;;
        openssl)
            rm -rf "$REPO_ROOT/examples/libs/openssl/openssl-src" \
                   "$REPO_ROOT/examples/libs/openssl/openssl-install"
            warn "Cleaned OpenSSL (rebuild sysroot to fully clean)" ;;
        libcurl)
            rm -rf "$REPO_ROOT/examples/libs/libcurl/curl-src"
            warn "Cleaned libcurl (rebuild sysroot to fully clean)" ;;
        vim)
            rm -rf "$REPO_ROOT/examples/libs/vim/vim-src" \
                   "$REPO_ROOT/examples/libs/vim/bin" \
                   "$REPO_ROOT/examples/libs/vim/runtime"
            rm -f "$REPO_ROOT/examples/browser/public/vim.zip" \
                  "$REPO_ROOT/examples/browser/public/shell.vfs" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/vim.zip"
            warn "Cleaned Vim (also invalidated vim.zip and shell.vfs; run '$0 build shell-vfs' to regenerate for browser demo)" ;;
        vim-zip)
            rm -f "$REPO_ROOT/examples/browser/public/vim.zip" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/vim.zip"
            warn "Cleaned vim.zip" ;;
        git)
            rm -rf "$REPO_ROOT/examples/libs/git/git-src" \
                   "$REPO_ROOT/examples/libs/git/bin"
            warn "Cleaned git" ;;
        perl)
            rm -rf "$REPO_ROOT/examples/libs/perl/perl-src" \
                   "$REPO_ROOT/examples/libs/perl/bin"
            warn "Cleaned Perl" ;;
        ruby)
            rm -rf "$REPO_ROOT/examples/libs/ruby/ruby-src" \
                   "$REPO_ROOT/examples/libs/ruby/ruby-host-build" \
                   "$REPO_ROOT/examples/libs/ruby/ruby-cross-build" \
                   "$REPO_ROOT/examples/libs/ruby/ruby-install" \
                   "$REPO_ROOT/examples/libs/ruby/bin"
            warn "Cleaned Ruby" ;;
        texlive)
            rm -rf "$REPO_ROOT/examples/libs/texlive/texlive-src" \
                   "$REPO_ROOT/examples/libs/texlive/texlive-host-build" \
                   "$REPO_ROOT/examples/libs/texlive/texlive-cross-build" \
                   "$REPO_ROOT/examples/libs/texlive/bin"
            warn "Cleaned TeX Live" ;;
        texlive-vfs)
            rm -rf "$REPO_ROOT/examples/libs/texlive/texlive-dist" \
                   "$REPO_ROOT/examples/libs/texlive/texlive-fmt" \
                   "$REPO_ROOT/examples/libs/texlive/install-tl" \
                   "$REPO_ROOT/examples/libs/texlive/texlive.profile"
            rm -f "$REPO_ROOT/examples/browser/public/texlive-bundle.json"
            warn "Cleaned TeX Live VFS" ;;
        dlopen)
            rm -f "$REPO_ROOT/examples/dlopen/hello-lib.so" \
                  "$REPO_ROOT/examples/dlopen/main.wasm"
            warn "Cleaned dlopen" ;;
        browser)
            for t in "${BROWSER_DEPS[@]}"; do
                clean_target "$t"
            done ;;
        all)
            for t in kernel sysroot sysroot64 host programs dash bash coreutils grep sed bc file less m4 make tar curl-cli wget gzip bzip2 xz zstd zip unzip nano ncurses zlib openssl libcurl vim vim-zip git nginx php php-fpm mariadb mariadb-vfs mariadb64 mariadb64-vfs redis cpython python-vfs perl perl-vfs ruby shell-vfs wordpress wp-vfs lamp-vfs erlang erlang-vfs texlive texlive-vfs dlopen; do
                clean_target "$t"
            done ;;
        *)  err "Unknown clean target: $target"; exit 1 ;;
    esac
}

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_build() {
    if [ $# -eq 0 ]; then
        build_all
    else
        for t in "$@"; do
            build_target "$t"
        done
    fi
    echo ""
    info "Build complete"
}

cmd_clean() {
    if [ $# -eq 0 ]; then
        err "Usage: $0 clean <target...>"
        err "Use 'clean all' to clean everything"
        exit 1
    fi
    for t in "$@"; do
        clean_target "$t"
    done
    echo ""
    info "Clean complete"
}

cmd_rebuild() {
    if [ $# -eq 0 ]; then
        err "Usage: $0 rebuild <target...>"
        err "Use 'rebuild all' to rebuild everything"
        exit 1
    fi
    for t in "$@"; do
        clean_target "$t"
        build_target "$t"
    done
    echo ""
    info "Rebuild complete"
}

cmd_run() {
    if [ $# -eq 0 ]; then
        err "Usage: $0 run <example> [args...]"
        err "Examples: shell, nginx, redis, mariadb, wordpress, wordpress-nginx, lamp, erlang, dlopen"
        exit 1
    fi

    local example="$1"; shift
    need_node_modules

    case "$example" in
        nginx)
            build_nginx
            step "Starting nginx"
            exec npx tsx "$REPO_ROOT/examples/nginx/serve.ts" "$@"
            ;;
        mariadb)
            build_mariadb
            step "Starting MariaDB"
            exec npx tsx "$REPO_ROOT/examples/mariadb/serve.ts" "$@"
            ;;
        redis)
            build_redis
            step "Starting Redis"
            exec npx tsx "$REPO_ROOT/examples/redis/serve.ts" "$@"
            ;;
        wordpress)
            build_php
            build_wordpress
            step "Starting WordPress (PHP built-in server + SQLite)"
            exec npx tsx "$REPO_ROOT/examples/wordpress/serve.ts" "$@"
            ;;
        wordpress-nginx)
            build_nginx
            build_php_fpm
            build_wordpress
            step "Starting WordPress (nginx + PHP-FPM + SQLite)"
            exec npx tsx "$REPO_ROOT/examples/wordpress/serve-nginx.ts" "$@"
            ;;
        lamp)
            build_mariadb
            build_nginx
            build_php_fpm
            # LAMP uses its own WordPress setup (MySQL mode)
            if [ ! -f "$REPO_ROOT/examples/lamp/wordpress/wp-settings.php" ]; then
                step "Setting up LAMP WordPress"
                bash "$REPO_ROOT/examples/lamp/setup.sh"
            fi
            step "Starting LAMP stack (MariaDB + PHP-FPM + nginx + WordPress)"
            exec npx tsx "$REPO_ROOT/examples/lamp/serve.ts" "$@"
            ;;
        shell)
            build_programs
            build_dash
            build_coreutils
            build_grep
            build_sed
            need_host
            step "Starting interactive shell"
            exec npx tsx "$REPO_ROOT/examples/shell/serve.ts" "$@"
            ;;
        erlang)
            build_erlang
            step "Starting Erlang BEAM"
            exec npx tsx "$REPO_ROOT/examples/erlang/serve.ts" "$@"
            ;;
        dlopen)
            build_dlopen
            step "Running dlopen example"
            exec npx tsx "$REPO_ROOT/examples/dlopen/serve.ts" "$@"
            ;;
        *)
            err "Unknown example: $example"
            err "Available: shell, nginx, redis, mariadb, wordpress, wordpress-nginx, lamp, erlang, dlopen"
            exit 1
            ;;
    esac
}

cmd_fetch() {
    if [ ! -f "$REPO_ROOT/binaries.lock" ]; then
        err "binaries.lock not found"
        exit 1
    fi
    step "Fetching binaries for the pinned release"
    "$REPO_ROOT/scripts/fetch-binaries.sh" "${ALLOW_STALE_ARGS[@]+"${ALLOW_STALE_ARGS[@]}"}" "$@"
}

cmd_browser() {
    local BROWSER_DIR="$REPO_ROOT/examples/browser"

    # Fetch the release binaries pinned by binaries.lock first. The
    # resolver-aware has_X guards below then treat fetched binaries as
    # "already built", so build_browser's per-target loop is a no-op
    # for anything that's in the release. Only genuinely missing
    # artifacts (local-only programs, stale VFS images) trigger a build.
    if [ -f "$REPO_ROOT/binaries.lock" ]; then
        step "Fetching binaries for the pinned release"
        "$REPO_ROOT/scripts/fetch-binaries.sh" "${ALLOW_STALE_ARGS[@]+"${ALLOW_STALE_ARGS[@]}"}"
    fi

    build_browser

    # Install browser deps if needed (re-run if package.json is newer than node_modules)
    if [ ! -d "$BROWSER_DIR/node_modules" ] || [ "$BROWSER_DIR/package.json" -nt "$BROWSER_DIR/node_modules" ]; then
        warn "Installing browser example dependencies"
        cd "$BROWSER_DIR" && npm install && cd "$REPO_ROOT"
    fi

    step "Starting Vite browser dev server"
    cd "$BROWSER_DIR"
    exec npx vite "$@"
}

cmd_test() {
    local suites=("$@")
    if [ ${#suites[@]} -eq 0 ]; then
        suites=(cargo vitest libc posix)
    fi

    local failed=0
    for suite in "${suites[@]}"; do
        case "$suite" in
            cargo)
                step "Running cargo tests"
                if ! cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib; then
                    failed=1
                fi
                ;;
            vitest)
                step "Running vitest"
                cd "$REPO_ROOT/host"
                if ! npx vitest run; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            libc)
                step "Running libc-test suite"
                if ! bash "$REPO_ROOT/scripts/run-libc-tests.sh"; then
                    failed=1
                fi
                ;;
            posix)
                step "Running POSIX test suite"
                if ! bash "$REPO_ROOT/scripts/run-posix-tests.sh"; then
                    failed=1
                fi
                ;;
            sortix)
                step "Running Sortix test suite"
                if ! bash "$REPO_ROOT/scripts/run-sortix-tests.sh" --all; then
                    failed=1
                fi
                ;;
            browser)
                step "Running browser E2E tests"
                cd "$REPO_ROOT/examples/browser"
                [ -d node_modules ] || npm install
                if ! npx playwright test --grep-invert "@slow"; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            browser-all)
                step "Running ALL browser E2E tests (including @slow)"
                cd "$REPO_ROOT/examples/browser"
                [ -d node_modules ] || npm install
                if ! npx playwright test; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            mariadb)
                info "Running MariaDB mysql-test suite..."
                if ! bash "$REPO_ROOT/scripts/run-mariadb-tests.sh"; then
                    failed=1
                fi
                ;;
            browser-mariadb)
                info "Running MariaDB mysql-test suite (browser)..."
                if ! bash "$REPO_ROOT/scripts/run-browser-mariadb-tests.sh"; then
                    failed=1
                fi
                ;;
            nginx)
                info "Running nginx test suite..."
                if ! bash "$REPO_ROOT/scripts/run-nginx-tests.sh"; then
                    failed=1
                fi
                ;;
            sqlite)
                info "Running SQLite test suite..."
                if ! bash "$REPO_ROOT/scripts/run-sqlite-tests.sh"; then
                    failed=1
                fi
                ;;
            sqlite-upstream)
                step "Running SQLite upstream test suite"
                if ! bash "$REPO_ROOT/scripts/run-sqlite-upstream-tests.sh" --quick; then
                    failed=1
                fi
                ;;
            all)
                cmd_test cargo vitest libc posix sortix browser
                return $?
                ;;
            *)
                err "Unknown test suite: $suite"
                err "Available: cargo, vitest, libc, posix, sortix, sqlite-upstream, browser, browser-all, mariadb, browser-mariadb, nginx, sqlite, all"
                exit 1
                ;;
        esac
    done

    if [ "$failed" -ne 0 ]; then
        err "Some test suites failed"
        exit 1
    fi
    info "All test suites passed"
}

cmd_list() {
    echo "${BOLD}Build targets:${RESET}"
    echo "  kernel      Rust kernel + userspace Wasm         $(has_kernel && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sysroot     musl libc sysroot (wasm32)           $(has_sysroot && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sysroot64   musl libc sysroot (wasm64)           $(has_sysroot64 && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sdk         SDK cross-compilation tools           $(has_sdk && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  host        TypeScript host (tsup)                $(has_host && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  programs    Simple C programs (sh, cat, ls, ...)  $(has_programs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  dash        dash 0.5.12 shell                      $(has_dash && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  bash        bash 5.2 shell                         $(has_bash && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  coreutils   GNU coreutils 9.6                      $(has_coreutils && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  grep        GNU grep 3.11                          $(has_grep && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sed         GNU sed 4.9                            $(has_sed && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  bc          bc calculator                          $(has_bc && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  file        file type identifier                   $(has_file && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  less        less pager                             $(has_less && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  m4          GNU m4 macro processor                 $(has_m4 && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  make        GNU make                               $(has_make && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  tar         GNU tar                                $(has_tar && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  curl-cli    curl CLI                               $(has_curl && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  wget        GNU wget                               $(has_wget && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  gzip        gzip compression                       $(has_gzip && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  bzip2       bzip2 compression                      $(has_bzip2 && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  xz          xz/lzma compression                    $(has_xz && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  zstd        Zstandard compression                  $(has_zstd && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  zip         zip archiver                           $(has_zip && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  unzip       unzip extractor                        $(has_unzip && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  nano        nano text editor                       $(has_nano && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  ncurses     ncurses library                        $(has_ncurses && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  vim         Vim 9.1 text editor                    $(has_vim && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  nethack     NetHack 3.6.7 roguelike (curses)       $(has_nethack && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  fbdoom      fbDOOM (framebuffer DOOM via /dev/fb0) $(has_fbdoom && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  git         Git 2.47.1                             $(has_git && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  nginx       nginx 1.24 Wasm binary                $(has_nginx && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  php         PHP 8.3 CLI binary                    $(has_php && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  php-fpm     PHP-FPM Wasm binary                   $(has_php_fpm && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  mariadb     MariaDB 10.5 Wasm binary (wasm32)     $(has_mariadb && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  mariadb64   MariaDB 10.5 Wasm binary (wasm64)     $(has_mariadb64 && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  redis       Redis 7.2 Wasm binary                 $(has_redis && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  cpython     CPython 3.13 Wasm binary              $(has_cpython && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  python-vfs  Python stdlib VFS image               $(has_python_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  perl-vfs    Perl stdlib VFS image                 $(has_perl_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  shell-vfs   Shell environment VFS image           $(has_shell_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  wordpress   WordPress + SQLite plugin             $(has_wordpress && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  wp-vfs      WordPress VFS image                   $(has_wp_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  lamp-vfs    WordPress LAMP VFS image              $(has_lamp_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  perl        Perl 5.40                              $(has_perl && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  ruby        Ruby                                   $(has_ruby && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  erlang      Erlang/OTP 28 BEAM VM                   $(has_erlang && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  erlang-vfs  Erlang OTP VFS image                  $(has_erlang_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  dlopen      dlopen shared library example          $(has_dlopen && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  browser     All browser demo dependencies"
    echo "  all         Build everything"
    echo ""
    echo "${BOLD}Clean/rebuild:${RESET}"
    echo "  ./run.sh clean <target...>           Remove build artifacts"
    echo "  ./run.sh clean all                   Remove all build artifacts"
    echo "  ./run.sh rebuild <target...>         Clean + rebuild specific targets"
    echo ""
    echo "${BOLD}Binaries:${RESET}"
    echo "  ./run.sh fetch                       Fetch binaries pinned by binaries.lock"
    echo ""
    echo "${BOLD}Top-level flags:${RESET}"
    echo "  --allow-stale                        Soften the install-release manifest"
    echo "                                        gate (forwarded to fetch-binaries.sh)."
    echo "                                        Equivalent to WASM_POSIX_ALLOW_STALE=1."
    echo ""
    echo "${BOLD}Run examples:${RESET}"
    echo "  ./run.sh run shell                   Interactive shell (dash + coreutils + grep + sed)"
    echo "  ./run.sh run nginx [port]            nginx HTTP server"
    echo "  ./run.sh run redis [port]            Redis key-value store"
    echo "  ./run.sh run mariadb                 MariaDB standalone"
    echo "  ./run.sh run wordpress [port]        WordPress (PHP built-in + SQLite)"
    echo "  ./run.sh run wordpress-nginx [port]  WordPress (nginx + PHP-FPM + SQLite)"
    echo "  ./run.sh run lamp [port]             Full LAMP stack (MariaDB + nginx + PHP-FPM)"
    echo "  ./run.sh run erlang [-eval 'Expr']    Erlang BEAM VM"
    echo "  ./run.sh run dlopen                  dlopen shared library demo"
    echo ""
    echo "${BOLD}Browser:${RESET}"
    echo "  ./run.sh browser                     Start Vite dev server for browser demos"
    echo ""
    echo "${BOLD}Test suites:${RESET}"
    echo "  ./run.sh test                        Run default suites (cargo + vitest + libc + posix)"
    echo "  ./run.sh test cargo                  Kernel unit tests"
    echo "  ./run.sh test vitest                 Host integration tests"
    echo "  ./run.sh test libc                   musl libc-test conformance"
    echo "  ./run.sh test posix                  Open POSIX test suite"
    echo "  ./run.sh test sortix                 Sortix os-test suite"
    echo "  ./run.sh test browser                Browser E2E tests (fast only)"
    echo "  ./run.sh test browser-all            Browser E2E tests (including slow)"
    echo "  ./run.sh test mariadb                MariaDB mysql-test suite (Node.js)"
    echo "  ./run.sh test browser-mariadb        MariaDB mysql-test suite (browser)"
    echo "  ./run.sh test nginx                  nginx test suite (32 upstream tests)"
    echo "  ./run.sh test sqlite                 SQLite test suite (17 SQL tests)"
    echo "  ./run.sh test all                    All suites including sortix + browser"
}

# ─── Main dispatch ────────────────────────────────────────────────────────────

case "${1:-list}" in
    build)    cmd_build "${@:2}" ;;
    rebuild)  cmd_rebuild "${@:2}" ;;
    clean)    cmd_clean "${@:2}" ;;
    fetch)    cmd_fetch "${@:2}" ;;
    run)      cmd_run "${@:2}" ;;
    browser)  cmd_browser "${@:2}" ;;
    test)     cmd_test "${@:2}" ;;
    list)     cmd_list ;;
    -h|--help|help) cmd_list ;;
    *)
        err "Unknown command: $1"
        echo ""
        cmd_list
        exit 1
        ;;
esac
