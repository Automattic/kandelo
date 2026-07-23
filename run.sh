#!/usr/bin/env bash
#
# Unified build, run, and test script for kandelo.
#
# Usage:
#   ./run.sh build [target...]    Build specific targets (or all)
#   ./run.sh rebuild [target...]  Force-rebuild (clean + build)
#   ./run.sh clean [target...]    Remove build artifacts
#   ./run.sh fetch                Fetch binaries pinned by per-package package.toml
#   ./run.sh run <example> [args] Run a Node.js example
#   ./run.sh prepare-browser      Fetch/build browser UI assets
#   ./run.sh browser [args]       Start the Vite browser dev server
#   ./run.sh list                 Show available targets and examples
#   ./run.sh test [suite...]      Run test suites
#
# Top-level flags (recognized anywhere in the argument list):
#   --allow-stale                 Accepted for back-compat; the resolver
#                                  source-builds automatically on any
#                                  verification failure. No-op today.
#   --fetch-only                  Refuse source-build fallback when fetching
#                                  package binaries.
#   --already-materialized        Skip browser package fetching because the
#                                  exact binaries/ tree was prepared earlier.
#   --pr-staging                  Use the current PR's staging binary index
#                                  unless WASM_POSIX_BINARY_INDEX_URL is set.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# Activate the worktree-local SDK toolchain (no global npm link required).
# Build scripts also source this directly; sourcing here makes the tools
# available to anything `run.sh` shells out to (e.g. `bash run.sh build_X`).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"

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
# Scrub top-level flags from $@ and turn them into env vars so any
# downstream invocation of fetch-binaries.sh (called directly or
# nested via build_target) picks them up. Also honor env vars if the
# user prefers `WASM_POSIX_ALLOW_STALE=1 ./run.sh browser`,
# `WASM_POSIX_FETCH_ONLY=1 ./run.sh prepare-browser`, or
# `WASM_POSIX_ALREADY_MATERIALIZED=1 ./run.sh prepare-browser`, or
# `WASM_POSIX_USE_PR_STAGING=1 ./run.sh browser`.
ALLOW_STALE_ARGS=()
FETCH_ONLY_ARGS=()
ALREADY_MATERIALIZED=0
USE_PR_STAGING=0
NEW_ARGS=()
for a in "$@"; do
    case "$a" in
        --allow-stale)
            ALLOW_STALE_ARGS=(--allow-stale)
            ;;
        --fetch-only)
            FETCH_ONLY_ARGS=(--fetch-only)
            ;;
        --already-materialized)
            ALREADY_MATERIALIZED=1
            ;;
        --pr-staging)
            USE_PR_STAGING=1
            ;;
        *)
            NEW_ARGS+=("$a")
            ;;
    esac
done
set -- "${NEW_ARGS[@]+"${NEW_ARGS[@]}"}"
if [ "${WASM_POSIX_ALLOW_STALE:-0}" = "1" ]; then
    ALLOW_STALE_ARGS=(--allow-stale)
fi
if [ "${WASM_POSIX_FETCH_ONLY:-0}" = "1" ]; then
    FETCH_ONLY_ARGS=(--fetch-only)
fi
if [ "${WASM_POSIX_ALREADY_MATERIALIZED:-0}" = "1" ]; then
    ALREADY_MATERIALIZED=1
fi
if [ "${#ALLOW_STALE_ARGS[@]}" -gt 0 ] && [ "${#FETCH_ONLY_ARGS[@]}" -gt 0 ]; then
    err "--allow-stale and --fetch-only cannot be combined."
    exit 2
fi
export WASM_POSIX_ALLOW_STALE=$([ "${#ALLOW_STALE_ARGS[@]}" -gt 0 ] && echo 1 || echo 0)
export WASM_POSIX_FETCH_ONLY=$([ "${#FETCH_ONLY_ARGS[@]}" -gt 0 ] && echo 1 || echo 0)
export WASM_POSIX_ALREADY_MATERIALIZED=$ALREADY_MATERIALIZED
if [ "${WASM_POSIX_USE_PR_STAGING:-0}" = "1" ]; then
    USE_PR_STAGING=1
fi
export WASM_POSIX_USE_PR_STAGING=$USE_PR_STAGING

pr_staging_manual_override_hint() {
    local repo_hint=${1:-"<owner>/<repo>"}
    local pr_hint=${2:-"<PR>"}
    err "Manual override:"
    err "  WASM_POSIX_BINARY_INDEX_URL=https://github.com/${repo_hint}/releases/download/pr-${pr_hint}-staging/index.toml ./run.sh fetch --allow-stale"
}

configure_pr_staging_binary_index() {
    [ "$USE_PR_STAGING" = "1" ] || return 0

    if [ -n "${WASM_POSIX_BINARY_INDEX_URL:-}" ]; then
        warn "WASM_POSIX_BINARY_INDEX_URL is already set; leaving it unchanged."
        return 0
    fi

    if ! command -v gh >/dev/null 2>&1; then
        err "PR staging binary index requested, but gh is not on PATH."
        pr_staging_manual_override_hint
        exit 2
    fi

    local pr_number
    if ! pr_number=$(gh pr view --json number --jq '.number' 2>/dev/null) \
        || [ -z "$pr_number" ] || [ "$pr_number" = "null" ]; then
        err "PR staging binary index requested, but this branch is not associated with a GitHub PR."
        pr_staging_manual_override_hint
        exit 2
    fi

    local repo pr_url
    pr_url=$(gh pr view --json url --jq '.url' 2>/dev/null || true)
    repo=$(sed -E 's#^https://github.com/([^/]+/[^/]+)/pull/[0-9]+.*$#\1#' <<<"$pr_url")
    if [ -z "$repo" ] || [ "$repo" = "$pr_url" ]; then
        repo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
    fi
    if [ -z "$repo" ] || [ "$repo" = "null" ]; then
        err "PR staging binary index requested, but gh could not determine the GitHub repository."
        pr_staging_manual_override_hint "<owner>/<repo>" "$pr_number"
        exit 2
    fi

    local tag="pr-${pr_number}-staging"
    local assets
    if ! assets=$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' 2>/dev/null); then
        err "PR staging release $repo@$tag is not available."
        pr_staging_manual_override_hint "$repo" "$pr_number"
        exit 2
    fi
    if ! grep -Fxq "index.toml" <<<"$assets"; then
        err "PR staging release $repo@$tag does not contain index.toml."
        pr_staging_manual_override_hint "$repo" "$pr_number"
        exit 2
    fi

    export WASM_POSIX_BINARY_INDEX_URL="https://github.com/$repo/releases/download/$tag/index.toml"
    warn "Using PR #$pr_number staging binary index: $WASM_POSIX_BINARY_INDEX_URL"
}

configure_pr_staging_binary_index

# ─── Artifact checks ─────────────────────────────────────────────────────────

# `has_resolvable <rel>` is true when the binary resolves via
# `local-binaries/` or `binaries/`. Used to treat fetched binaries as
# "already built" so build_target skips.
has_resolvable() {
    "$REPO_ROOT/scripts/resolve-binary.sh" "$1" >/dev/null 2>&1
}

KERNEL_REQUIRED_EXPORTS=(
    __abi_version
    kernel_alloc_scratch
    kernel_create_process
    kernel_create_process_with_stdio
    kernel_get_parent_pid
    kernel_get_process_state
    kernel_handle_channel
    kernel_has_sa_nocldstop
    kernel_host_adapter_manifest_len
    kernel_host_adapter_manifest_ptr
    kernel_mark_process_signaled
    kernel_reap_exited_child
    kernel_remove_process
    kernel_wait_child_poll
)

has_valid_kernel_file() {
    local path="$1"
    local current_abi
    [ -f "$path" ] || return 1
    current_abi="$(wasm_current_abi_version "$REPO_ROOT" || true)"
    ! wasm_has_legacy_asyncify "$path" &&
        ! wasm_has_stale_abi "$path" "$current_abi" &&
        ! wasm_has_missing_exports "$path" "${KERNEL_REQUIRED_EXPORTS[@]}"
}

# pkg_xtask_bin: build xtask once (lazy) and return the binary path so
# repeated `pkg_has_output` calls don't pay cargo's setup cost on each
# call (~50ms × 40 has_* lookups in cmd_status = a real delay).
PKG_XTASK_BIN=""
pkg_xtask_bin() {
    if [ -n "$PKG_XTASK_BIN" ] && [ -x "$PKG_XTASK_BIN" ]; then
        echo "$PKG_XTASK_BIN"
        return 0
    fi
    local host
    host=$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')
    if [ -z "$host" ]; then
        return 1
    fi
    PKG_XTASK_BIN="$REPO_ROOT/target/$host/release/xtask"
    if [ ! -x "$PKG_XTASK_BIN" ]; then
        if [ -n "${KANDELO_DEV_SHELL_TOOL_PATH:-}" ]; then
            # Consumer jobs already run inside the declared dev shell, where
            # `nix` is intentionally absent. Build directly in that shell if a
            # caller did not provide the prepared xtask binary.
            (cd "$REPO_ROOT" && \
                cargo build --release -p xtask --target "$host" --quiet) >&2 || return 1
        else
            (cd "$REPO_ROOT" && bash scripts/dev-shell.sh \
                cargo build --release -p xtask --target "$host" --quiet) >&2 || return 1
        fi
    fi
    echo "$PKG_XTASK_BIN"
}

# pkg_output_rel <pkg-name> <wasm-basename> [arch]
#
# Print the package system's canonical path below programs/<arch>/ for one
# declared output. Keep local materialization and cleanup on this same metadata
# path so output layout changes cannot strand stale artifacts.
pkg_output_rel() {
    local pkg=$1
    local wasm=$2
    local arch=${3:-wasm32}
    local xtask
    xtask=$(pkg_xtask_bin) || return 1
    "$xtask" build-deps --arch "$arch" output-path "$pkg" "$wasm" 2>/dev/null
}

# pkg_local_output_path <pkg-name> <wasm-basename> [arch]
pkg_local_output_path() {
    local pkg=$1
    local wasm=$2
    local arch=${3:-wasm32}
    local rel
    rel=$(pkg_output_rel "$pkg" "$wasm" "$arch") || return 1
    case "$rel" in
        ""|/*|../*|*/../*|*/..)
            err "Package resolver returned an unsafe output path for $pkg: $rel"
            return 1
            ;;
    esac
    printf '%s\n' "$REPO_ROOT/local-binaries/programs/$arch/$rel"
}

pkg_remove_local_output() {
    local output
    output=$(pkg_local_output_path "$@") || return 1
    rm -f -- "$output"
}

# pkg_has_output <pkg-name> <wasm-basename> [arch]
#
# True when the package's named output is resolvable via the package
# system — i.e. xtask's `build-deps output-path` returns its rel path
# under `programs/<arch>/` AND that path resolves through `binaries/`
# or `local-binaries/`. This is the single source of truth for "is
# this package built?" — replaces ~30 hand-coded has_<pkg> checks
# that hardcoded the flat-vs-nested layout convention and silently
# drifted when a package moved from scalar to package-directory layout
# (the Erlang build exposed this bug). Layout decisions live in
# `output_dest_rel_for` only.
#
# The wasm-basename arg is the file listed in `[[outputs]].wasm`
# (e.g. `python.wasm`, `mariadbd.wasm`), NOT the output `name` field.
# Arch defaults to wasm32; pass wasm64 for the per-arch variants.
pkg_has_output() {
    local pkg=$1
    local wasm=$2
    local arch=${3:-wasm32}
    local rel
    rel=$(pkg_output_rel "$pkg" "$wasm" "$arch") || return 1
    if [ "$arch" = "wasm32" ]; then
        # `has_resolvable programs/<x>` injects `wasm32/` per the
        # default-arch shim (matches host/src/binary-resolver.ts). No
        # explicit arch segment needed.
        has_resolvable "programs/$rel"
    else
        has_resolvable "programs/$arch/$rel"
    fi
}

has_kernel()    { has_resolvable kernel.wasm || has_valid_kernel_file "$REPO_ROOT/host/wasm/kandelo-kernel.wasm"; }
has_sysroot()   { [ -f "$REPO_ROOT/sysroot/lib/libc.a" ]; }
has_sysroot64() { [ -f "$REPO_ROOT/sysroot64/lib/libc.a" ]; }
has_sdk()       { command -v wasm32posix-cc &>/dev/null; }
has_host()      { [ -d "$REPO_ROOT/host/dist" ]; }
has_rootfs()    { [ -f "$REPO_ROOT/host/wasm/rootfs.vfs" ]; }
has_programs() {
    has_resolvable programs/fork-exec.wasm &&
    has_resolvable programs/fbtest.wasm &&
    [ -f "$REPO_ROOT/examples/pthread_channel_reuse_test.wasm" ] &&
    [ -f "$REPO_ROOT/examples/wait_lifecycle_test.wasm" ] &&
    [ -f "$REPO_ROOT/examples/wait_lifecycle_test.wasm64.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/pipe-throughput.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/file-throughput.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/syscall-latency.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/fork-bench.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/clone-bench.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/spawn-bench.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/hello.wasm" ]
}

# Package-system entries: layout derived from package.toml's
# `[[outputs]]` via `xtask build-deps output-path`. Source-tree
# fallbacks left in place for the developer-hand-built case.
has_nginx()         { pkg_has_output nginx nginx.wasm || [ -f "$REPO_ROOT/packages/registry/nginx/nginx.wasm" ]; }
has_php()           { pkg_has_output php php.wasm || [ -f "$REPO_ROOT/packages/registry/php/php-src/sapi/cli/php" ]; }
has_php_fpm()       { pkg_has_output php php-fpm.wasm || [ -f "$REPO_ROOT/packages/registry/php/php-src/sapi/fpm/php-fpm" ]; }
has_mariadb()       { pkg_has_output mariadb mariadbd.wasm || [ -f "$REPO_ROOT/packages/registry/mariadb/mariadb-install/bin/mariadbd.wasm" ]; }
has_mariadb64()     { pkg_has_output mariadb mariadbd.wasm wasm64 || [ -f "$REPO_ROOT/packages/registry/mariadb/mariadb-install-64/bin/mariadbd.wasm" ]; }
has_mariadb_vfs()   { pkg_has_output mariadb-vfs mariadb-vfs.vfs.zst; }
has_mariadb64_vfs() { pkg_has_output mariadb-vfs mariadb-vfs.vfs.zst wasm64; }
has_wordpress()     { [ -f "$REPO_ROOT/packages/registry/wordpress/wordpress/wp-settings.php" ]; }
has_wp_vfs()        { pkg_has_output wordpress wordpress.vfs.zst; }
has_dash()          { pkg_has_output dash dash.wasm || [ -f "$REPO_ROOT/packages/registry/dash/bin/dash.wasm" ]; }
has_bash()          { pkg_has_output bash bash.wasm || [ -f "$REPO_ROOT/packages/registry/bash/bin/bash.wasm" ]; }
has_coreutils()     { pkg_has_output coreutils coreutils.wasm || [ -f "$REPO_ROOT/packages/registry/coreutils/bin/coreutils.wasm" ]; }
has_grep()          { pkg_has_output grep grep.wasm || [ -f "$REPO_ROOT/packages/registry/grep/bin/grep.wasm" ]; }
has_sed()           { pkg_has_output sed sed.wasm || [ -f "$REPO_ROOT/packages/registry/sed/bin/sed.wasm" ]; }
has_redis()         { pkg_has_output redis redis-server.wasm || [ -f "$REPO_ROOT/packages/registry/redis/bin/redis-server.wasm" ]; }
has_dinit()         { pkg_has_output dinit dinit.wasm || [ -f "$REPO_ROOT/packages/registry/dinit/bin/dinit.wasm" ]; }
has_msmtpd()        { pkg_has_output msmtpd msmtpd.wasm || [ -f "$REPO_ROOT/packages/registry/msmtpd/bin/msmtpd.wasm" ]; }
has_cpython()       { pkg_has_output cpython python.wasm || [ -f "$REPO_ROOT/packages/registry/cpython/bin/python.wasm" ]; }
has_python_vfs()    { pkg_has_output python-vfs python-vfs.vfs.zst || [ -f "$REPO_ROOT/apps/browser-demos/public/python.vfs.zst" ]; }
has_perl_vfs()      { pkg_has_output perl-vfs perl-vfs.vfs.zst || [ -f "$REPO_ROOT/apps/browser-demos/public/perl.vfs.zst" ]; }
has_shell_vfs()     { pkg_has_output shell shell.vfs.zst; }
has_node()          { pkg_has_output node node.wasm; }
has_spidermonkey_node() { pkg_has_output spidermonkey-node node.wasm || [ -f "$REPO_ROOT/packages/registry/spidermonkey-node/bin/node.wasm" ]; }
has_node_vfs()      { pkg_has_output node-vfs node-vfs.vfs.zst || [ -f "$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst" ]; }
has_erlang()        { pkg_has_output erlang erlang.wasm || [ -f "$REPO_ROOT/packages/registry/erlang/bin/beam.wasm" ]; }
has_erlang_vfs()    { pkg_has_output erlang-vfs erlang-vfs.vfs.zst || [ -f "$REPO_ROOT/apps/browser-demos/public/erlang.vfs.zst" ]; }
has_lamp_vfs()      { pkg_has_output lamp lamp.vfs.zst; }
has_mariadb_test_vfs() { pkg_has_output mariadb-test mariadb-test.vfs.zst; }
has_bc()            { pkg_has_output bc bc.wasm || [ -f "$REPO_ROOT/packages/registry/bc/bin/bc.wasm" ]; }
has_file()          { pkg_has_output file file.wasm || [ -f "$REPO_ROOT/packages/registry/file/bin/file.wasm" ]; }
has_less()          { pkg_has_output less less.wasm || [ -f "$REPO_ROOT/packages/registry/less/bin/less.wasm" ]; }
has_m4()            { pkg_has_output m4 m4.wasm || [ -f "$REPO_ROOT/packages/registry/m4/bin/m4.wasm" ]; }
has_make()          { pkg_has_output make make.wasm || [ -f "$REPO_ROOT/packages/registry/make/bin/make.wasm" ]; }
has_tar()           { pkg_has_output tar tar.wasm || [ -f "$REPO_ROOT/packages/registry/tar/bin/tar.wasm" ]; }
has_curl()          { pkg_has_output curl curl.wasm || [ -f "$REPO_ROOT/packages/registry/curl/bin/curl.wasm" ]; }
has_wget()          { pkg_has_output wget wget.wasm || [ -f "$REPO_ROOT/packages/registry/wget/bin/wget.wasm" ]; }
has_gzip()          { pkg_has_output gzip gzip.wasm || [ -f "$REPO_ROOT/packages/registry/gzip/bin/gzip.wasm" ]; }
has_bzip2()         { pkg_has_output bzip2 bzip2.wasm || [ -f "$REPO_ROOT/packages/registry/bzip2/bin/bzip2.wasm" ]; }
has_xz()            { pkg_has_output xz xz.wasm || [ -f "$REPO_ROOT/packages/registry/xz/bin/xz.wasm" ]; }
has_zstd()          { pkg_has_output zstd zstd.wasm || [ -f "$REPO_ROOT/packages/registry/zstd/bin/zstd.wasm" ]; }
has_zip()           { pkg_has_output zip zip.wasm || [ -f "$REPO_ROOT/packages/registry/zip/bin/zip.wasm" ]; }
has_lsof()          { pkg_has_output lsof lsof.wasm || [ -f "$REPO_ROOT/packages/registry/lsof/lsof.wasm" ]; }
has_unzip()         { pkg_has_output unzip unzip.wasm || [ -f "$REPO_ROOT/packages/registry/unzip/bin/unzip.wasm" ]; }
has_nano()          { pkg_has_output nano nano.wasm || [ -f "$REPO_ROOT/packages/registry/nano/bin/nano.wasm" ]; }
has_nethack()       { pkg_has_output nethack nethack.wasm || [ -f "$REPO_ROOT/packages/registry/nethack/bin/nethack.wasm" ]; }
has_fbdoom()        { pkg_has_output fbdoom fbdoom.wasm || [ -f "$REPO_ROOT/packages/registry/fbdoom/fbdoom.wasm" ]; }
has_vim()           { pkg_has_output vim vim.wasm || [ -f "$REPO_ROOT/packages/registry/vim/bin/vim.wasm" ]; }
has_git()           { pkg_has_output git git.wasm || [ -f "$REPO_ROOT/packages/registry/git/bin/git.wasm" ]; }
has_perl()          { pkg_has_output perl perl.wasm || [ -f "$REPO_ROOT/packages/registry/perl/bin/perl.wasm" ]; }
has_ruby()          { pkg_has_output ruby ruby.wasm || [ -f "$REPO_ROOT/packages/registry/ruby/bin/ruby.wasm" ]; }
has_texlive()       { pkg_has_output texlive pdftex.wasm || [ -f "$REPO_ROOT/packages/registry/texlive/bin/pdftex.wasm" ]; }
has_texlive_vfs()   { pkg_has_output texlive texlive-bundle.json || [ -f "$REPO_ROOT/apps/browser-demos/public/texlive-bundle.json" ]; }

# Non-package targets — these live outside the package system; their
# layout is hand-rolled and doesn't go through `output-path`.
has_nginx_vfs()     { has_resolvable programs/nginx-vfs.vfs.zst; }
has_redis_vfs()     { has_resolvable programs/redis-vfs.vfs.zst; }
has_nginx_php_vfs() { has_resolvable programs/nginx-php-vfs.vfs.zst; }
has_ncurses()       { pkg_has_output ncurses clear.wasm && pkg_has_output ncurses tic.wasm && pkg_has_output ncurses tput.wasm; }
has_zlib()          { [ -f "$REPO_ROOT/sysroot/lib/libz.a" ]; }
has_openssl()       { [ -f "$REPO_ROOT/sysroot/lib/libssl.a" ] && [ -f "$REPO_ROOT/sysroot/lib/libcrypto.a" ]; }
has_libcurl()       { [ -f "$REPO_ROOT/sysroot/lib/libcurl.a" ] && [ -f "$REPO_ROOT/sysroot/include/curl/curl.h" ]; }
has_vim_zip()       { has_resolvable programs/vim.zip || [ -f "$REPO_ROOT/apps/browser-demos/public/vim.zip" ]; }
has_nethack_zip()   { has_resolvable programs/nethack.zip || [ -f "$REPO_ROOT/apps/browser-demos/public/nethack.zip" ]; }
has_dlopen()        { [ -f "$REPO_ROOT/examples/dlopen/hello-lib.so" ] && \
                      [ -f "$REPO_ROOT/examples/dlopen/main.wasm" ]; }

# ─── Need functions (ensure dependency is built) ─────────────────────────────

need_kernel() {
    if ! has_kernel; then
        step "Building kernel"
        bash "$REPO_ROOT/packages/registry/kernel/build-kernel.sh"
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
        # few cp) and ensures newly-added libc/musl-overlay/include/ files reach
        # an existing sysroot without forcing a full musl rebuild.
        bash "$REPO_ROOT/scripts/install-overlay-headers.sh" "$REPO_ROOT/sysroot"
        info "Sysroot"
    fi
}

need_fork_instrument() {
    if [ ! -x "$REPO_ROOT/tools/bin/wasm-fork-instrument" ]; then
        step "Building wasm-fork-instrument"
        bash "$REPO_ROOT/scripts/build-fork-instrument-tool.sh"
        info "wasm-fork-instrument built"
    else
        info "wasm-fork-instrument"
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

need_rootfs() {
    if ! has_rootfs; then
        step "Building rootfs.vfs"
        bash "$REPO_ROOT/scripts/build-rootfs.sh"
        info "rootfs.vfs built"
    else
        info "rootfs.vfs"
    fi
}

need_node_modules() {
    if [ ! -d "$REPO_ROOT/node_modules" ]; then
        warn "Installing root npm dependencies"
        cd "$REPO_ROOT" && npm install --prefer-offline
    fi
}

# Source composition of the bottle-built shell uses the repository's pinned
# tsx and mkrootfs dependency trees. Run exact lockfile installs every time the
# source-capable path is selected: presence checks cannot prove that an old
# node_modules tree matches the cache key's current package-lock inputs.
need_shell_vfs_build_tools() {
    step "Installing locked Shell VFS TypeScript dependencies"
    (cd "$REPO_ROOT" && \
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
        npm ci --no-audit --no-fund --prefer-offline)
    info "Shell VFS TypeScript dependencies installed"

    step "Installing locked mkrootfs dependencies"
    npm --prefix "$REPO_ROOT/tools/mkrootfs" ci \
        --no-audit --no-fund --prefer-offline
    info "mkrootfs dependencies installed"
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

build_rootfs() {
    need_rootfs
}

build_programs() {
    if has_programs; then
        info "programs"
        return
    fi
    need_kernel
    need_sysroot
    # The owned browser wait-lifecycle fixture exercises the memory64 ABI.
    need_sysroot64
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
        bash "$REPO_ROOT/packages/registry/nginx/build-nginx-local.sh"
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
        bash "$REPO_ROOT/packages/registry/php/build-php.sh"
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
        bash "$REPO_ROOT/packages/registry/php/build-php.sh"
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
        bash "$REPO_ROOT/packages/registry/mariadb/build-mariadb.sh"
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
        bash "$REPO_ROOT/packages/registry/mariadb/build-mariadb.sh" --wasm64
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
    # populates local-binaries/programs/wasm32/mariadb-vfs.vfs.zst (the
    # path the @binaries/ Vite alias resolves against).
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        bash "$REPO_ROOT/packages/registry/mariadb-vfs/build-mariadb-vfs.sh"
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
        bash "$REPO_ROOT/packages/registry/mariadb-vfs/build-mariadb-vfs.sh"
    info "MariaDB VFS image (wasm64) built"
}

build_mariadb_test_vfs() {
    if has_mariadb_test_vfs; then
        info "MariaDB test VFS image"
        return
    fi
    build_mariadb
    build_dash
    build_coreutils
    build_dinit
    step "Building MariaDB test VFS image"
    bash "$REPO_ROOT/packages/registry/mariadb-test/build-mariadb-test.sh"
    info "MariaDB test VFS image built"
}

build_wordpress() {
    if ! has_wordpress; then
        step "Downloading WordPress"
        bash "$REPO_ROOT/packages/registry/wordpress/setup.sh"
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
    build_shell_vfs
    # Source needed only if we have to build the VFS from scratch.
    build_wordpress
    build_msmtpd
    step "Building WordPress VFS image"
    # Delegate to the package-system wrapper so install_local_binary
    # populates local-binaries/programs/wasm32/wordpress.vfs.zst (the path
    # the @binaries/ Vite alias resolves against).
    bash "$REPO_ROOT/packages/registry/wordpress/build-wordpress.sh"
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
        bash "$REPO_ROOT/packages/registry/dash/build-dash.sh"
        info "dash built"
    else
        info "dash"
    fi
    # host/wasm/sh.wasm is dash — needed by vitest and run-example.ts
    if [ -f "$REPO_ROOT/packages/registry/dash/bin/dash.wasm" ] && [ ! -f "$REPO_ROOT/host/wasm/sh.wasm" ]; then
        mkdir -p "$REPO_ROOT/host/wasm"
        cp "$REPO_ROOT/packages/registry/dash/bin/dash.wasm" "$REPO_ROOT/host/wasm/sh.wasm"
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
    bash "$REPO_ROOT/packages/registry/bash/build-bash.sh"
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
        bash "$REPO_ROOT/packages/registry/coreutils/build-coreutils.sh"
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
        bash "$REPO_ROOT/packages/registry/grep/build-grep.sh"
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
        bash "$REPO_ROOT/packages/registry/sed/build-sed.sh"
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
        bash "$REPO_ROOT/packages/registry/redis/build-redis.sh"
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
        bash "$REPO_ROOT/packages/registry/dinit/build-dinit.sh"
        info "dinit built"
    else
        info "dinit"
    fi
}

build_msmtpd() {
    if has_msmtpd; then
        info "msmtpd"
        return
    fi
    need_kernel
    need_sdk
    need_sysroot
    need_fork_instrument
    if ! has_msmtpd; then
        step "Building msmtpd"
        bash "$REPO_ROOT/packages/registry/msmtpd/build-msmtpd.sh"
        info "msmtpd built"
    else
        info "msmtpd"
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
        bash "$REPO_ROOT/packages/registry/cpython/build-cpython.sh"
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
    bash "$REPO_ROOT/images/vfs/scripts/build-python-vfs-image.sh"
    info "Python VFS image built"
}

build_perl_vfs() {
    if ! has_perl_vfs; then
        if [ ! -f "$REPO_ROOT/packages/registry/perl/perl-src/lib/strict.pm" ]; then
            warn "Perl source not found, skipping perl VFS image"
            return
        fi
        step "Building Perl VFS image"
        bash "$REPO_ROOT/images/vfs/scripts/build-perl-vfs-image.sh"
        info "Perl VFS image built"
    else
        info "Perl VFS image"
    fi
}

build_node() {
    if has_node; then
        info "node"
        return
    fi
    need_kernel
    need_sdk
    local node_wasm="$REPO_ROOT/packages/registry/spidermonkey-node/bin/node.wasm"
    if [ ! -f "$node_wasm" ]; then
        node_wasm="$REPO_ROOT/packages/registry/spidermonkey/bin/node.wasm"
    fi
    if [ ! -f "$node_wasm" ]; then
        build_spidermonkey_node
        node_wasm="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/spidermonkey-node.wasm 2>/dev/null || true)"
    fi
    if [ -f "$node_wasm" ]; then
        step "Installing existing node.wasm into local-binaries"
        source "$REPO_ROOT/scripts/install-local-binary.sh"
        local tmp_dir
        tmp_dir="$(mktemp -d)"
        cp "$node_wasm" "$tmp_dir/node.wasm"
        install_local_binary node "$tmp_dir/node.wasm"
        rm -rf "$tmp_dir"
        info "node installed"
        return
    fi
    step "Building node.wasm"
    local host_target
    host_target="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$host_target" --quiet -- build-deps resolve node)
    info "node built"
}

build_spidermonkey_node() {
    if has_spidermonkey_node; then
        info "spidermonkey-node"
        return
    fi
    need_kernel
    need_sdk
    step "Resolving spidermonkey-node.wasm"
    local host_target
    host_target="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$host_target" --quiet -- \
        build-deps --arch wasm32 --binaries-dir "$REPO_ROOT/binaries" resolve spidermonkey-node)
    info "spidermonkey-node resolved"
}

build_node_vfs() {
    if has_node_vfs; then
        info "Node VFS image"
        return
    fi
    build_shell_vfs
    build_node
    step "Building Node VFS image"
    bash "$REPO_ROOT/packages/registry/node-vfs/build-node-vfs.sh"
    info "Node VFS image built"
}

build_vim_zip() {
    if has_vim_zip; then
        info "vim.zip"
        return
    fi

    step "Packaging vim.zip from cached vim package"
    bash "$REPO_ROOT/images/vfs/scripts/build-vim-zip.sh"
    info "vim.zip built ($(du -h "$REPO_ROOT/apps/browser-demos/public/vim.zip" | cut -f1))"
}

build_nethack_zip() {
    if has_nethack_zip; then
        info "nethack.zip"
        return
    fi

    # nethack.zip = nethack.wasm + runtime tree (nhdat, symbols, license),
    # packaged for the browser shell demo's lazy-archive fetch. NetHack's
    # release archive ships both pieces (build-nethack.sh stages
    # runtime/ alongside nethack.wasm into the resolver scratch), so this
    # builder reads from the cache canonical dir and rezips. Mirrors
    # build_vim_zip.
    step "Packaging nethack.zip from cached nethack package"
    bash "$REPO_ROOT/images/vfs/scripts/build-nethack-zip.sh"
    info "nethack.zip built ($(du -h "$REPO_ROOT/apps/browser-demos/public/nethack.zip" | cut -f1))"
}

build_shell_vfs() {
    # `clean` removes only the resolver-owned local link and deliberately keeps
    # immutable fetched `binaries/`. A rebuild marker must therefore bypass the
    # ordinary availability guard so the resolver rematerializes the local
    # output even when the downloaded artifact remains usable.
    if [ "${KANDELO_REBUILD_TARGET:-}" != "shell-vfs" ] && has_shell_vfs; then
        info "Shell VFS image"
        return
    fi

    step "Resolving the bottle-built Shell VFS image"
    local xtask
    local resolve_args=(
        build-deps --arch wasm32
        --binaries-dir "$REPO_ROOT/local-binaries"
    )
    if [ "${#FETCH_ONLY_ARGS[@]}" -gt 0 ]; then
        # Preserve the caller's explicit no-source-build contract. This
        # path needs no composer dependencies because any archive miss or
        # verification failure must remain a failure.
        resolve_args+=("${FETCH_ONLY_ARGS[@]}")
    else
        # The normal resolver may use a valid public archive or execute
        # the source composer. Prepare the latter's exact lockfile-owned
        # tools so fallback never depends on ambient npm state.
        need_shell_vfs_build_tools
    fi
    resolve_args+=(resolve shell)
    xtask="$(pkg_xtask_bin)" || {
        err "Could not build the package resolver needed for the Shell VFS image"
        return 1
    }
    mkdir -p "$REPO_ROOT/local-binaries"
    (cd "$REPO_ROOT" && "$xtask" "${resolve_args[@]}" >/dev/null)
    if ! pkg_has_output shell shell.vfs.zst; then
        err "Package resolver did not materialize the declared shell.vfs.zst output"
        return 1
    fi
    info "Bottle-built Shell VFS image resolved"
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
        bash "$REPO_ROOT/packages/registry/erlang/build-erlang.sh"
        # Build script puts beam.wasm at erlang/ root; browser+serve expect bin/
        local erlang_dir="$REPO_ROOT/packages/registry/erlang"
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
    bash "$REPO_ROOT/images/vfs/scripts/build-erlang-vfs-image.sh"
    info "Erlang VFS image built"
}

build_lamp_vfs() {
    if has_lamp_vfs; then
        info "LAMP VFS image"
        return
    fi
    build_shell_vfs
    build_wordpress
    build_msmtpd
    step "Building LAMP VFS image"
    # Delegate to the package-system wrapper so install_local_binary
    # populates local-binaries/programs/wasm32/lamp.vfs.zst (the path the
    # @binaries/ Vite alias resolves against).
    bash "$REPO_ROOT/packages/registry/lamp/build-lamp.sh"
    info "LAMP VFS image built"
}

build_nginx_vfs() {
    build_dinit
    build_nginx
    if ! has_nginx_vfs; then
        build_shell_vfs
        step "Building nginx VFS image"
        bash "$REPO_ROOT/images/vfs/scripts/build-nginx-vfs-image.sh"
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
        bash "$REPO_ROOT/images/vfs/scripts/build-redis-vfs-image.sh"
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
        build_shell_vfs
        step "Building nginx + PHP-FPM VFS image"
        bash "$REPO_ROOT/images/vfs/scripts/build-nginx-php-vfs-image.sh"
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
        bash "$REPO_ROOT/packages/registry/texlive/build-texlive.sh"
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
    # (built by `bash packages/registry/texlive/build-texlive.sh`), the
    # bundle script fails. Skip with a clear hint instead of breaking
    # the browser bring-up — the texlive demo will surface the missing
    # bundle to the user.
    local host_pdftex="$REPO_ROOT/packages/registry/texlive/texlive-build/host/bin/pdftex"
    if [ ! -x "$host_pdftex" ]; then
        warn "Skipping TeX Live bundle (host pdftex not built — run: bash packages/registry/texlive/build-texlive.sh)"
        return
    fi
    build_texlive
    step "Building TeX Live browser bundle"
    bash "$REPO_ROOT/images/vfs/scripts/build-texlive-bundle.sh"
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
        bash "$REPO_ROOT/packages/registry/bc/build-bc.sh"
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
        bash "$REPO_ROOT/packages/registry/file/build-file.sh"
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
        bash "$REPO_ROOT/packages/registry/less/build-less.sh"
        info "less built"
    else
        info "less"
    fi
}

build_lsof() {
    if has_lsof; then
        info "lsof"
        return
    fi
    need_kernel
    need_sdk
    if ! has_lsof; then
        step "Building lsof"
        bash "$REPO_ROOT/packages/registry/lsof/build-lsof.sh"
        info "lsof built"
    else
        info "lsof"
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
        bash "$REPO_ROOT/packages/registry/m4/build-m4.sh"
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
        bash "$REPO_ROOT/packages/registry/make/build-make.sh"
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
        bash "$REPO_ROOT/packages/registry/tar/build-tar.sh"
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
    bash "$REPO_ROOT/packages/registry/libcurl/build-libcurl.sh"
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
        bash "$REPO_ROOT/packages/registry/wget/build-wget.sh"
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
        bash "$REPO_ROOT/packages/registry/gzip/build-gzip.sh"
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
        bash "$REPO_ROOT/packages/registry/bzip2/build-bzip2.sh"
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
        bash "$REPO_ROOT/packages/registry/xz/build-xz.sh"
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
        bash "$REPO_ROOT/packages/registry/zstd/build-zstd.sh"
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
        bash "$REPO_ROOT/packages/registry/zip/build-zip.sh"
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
        bash "$REPO_ROOT/packages/registry/unzip/build-unzip.sh"
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
    bash "$REPO_ROOT/packages/registry/nano/build-nano.sh"
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
        bash "$REPO_ROOT/packages/registry/zlib/build-zlib.sh"
        # Install into sysroot
        local ZLIB_DIR="$REPO_ROOT/packages/registry/zlib/zlib-install"
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
        bash "$REPO_ROOT/packages/registry/openssl/build-openssl.sh"
        # Install into sysroot
        local OPENSSL_DIR="$REPO_ROOT/packages/registry/openssl/openssl-install"
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
        local CURL_SRC="$REPO_ROOT/packages/registry/libcurl/curl-src"
        if [ -f "$CURL_SRC/Makefile" ]; then
            rm -f "$CURL_SRC/Makefile"
        fi
        bash "$REPO_ROOT/packages/registry/libcurl/build-libcurl.sh"
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
        bash "$REPO_ROOT/packages/registry/ncurses/build-ncurses.sh"
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
    bash "$REPO_ROOT/packages/registry/nethack/build-nethack.sh"
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
    bash "$REPO_ROOT/packages/registry/fbdoom/build-fbdoom.sh"
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
    bash "$REPO_ROOT/packages/registry/vim/build-vim.sh"
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
    bash "$REPO_ROOT/packages/registry/git/build-git.sh"
    info "git built"
    # Stub git-remote-http.wasm for browser demo if build somehow
    # didn't produce one (e.g. user skipped curl resolution manually).
    if [ ! -f "$REPO_ROOT/packages/registry/git/bin/git-remote-http.wasm" ]; then
        mkdir -p "$REPO_ROOT/packages/registry/git/bin"
        printf '\x00asm\x01\x00\x00\x00' > "$REPO_ROOT/packages/registry/git/bin/git-remote-http.wasm"
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
        bash "$REPO_ROOT/packages/registry/perl/build-perl.sh"
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
        bash "$REPO_ROOT/packages/registry/ruby/build-ruby.sh"
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
        rootfs)     build_rootfs ;;
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
        mariadb-test) build_mariadb_test_vfs ;;
        redis)      build_redis ;;
        dinit)      build_dinit ;;
        msmtpd)     build_msmtpd ;;
        cpython)    build_cpython ;;
        python-vfs) build_python_vfs ;;
        perl-vfs)   build_perl_vfs ;;
        shell-vfs)  build_shell_vfs ;;
        node)       build_node ;;
        spidermonkey-node) build_spidermonkey_node ;;
        node-vfs)   build_node_vfs ;;
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
        lsof)       build_lsof ;;
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
        nethack-zip) build_nethack_zip ;;
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

# Packages backing gallery entries that are supplied by kandelo-software
# rather than local app inputs. `./run.sh browser` must not fetch them: a stale
# or missing archive would otherwise fall through to slow local source builds
# for entries the local app does not bundle.
BROWSER_EXTERNAL_GALLERY_PKGS=(cpython python-vfs perl perl-vfs ruby erlang erlang-vfs texlive redis)

# Browser preparation intentionally does not fetch the `node` alias package or
# the SpiderMonkey JS shell package directly. `spidermonkey-node` carries the
# browser UI's Node-compatible runtime; `build_node` installs that same
# runtime at `programs/node.wasm` for the Kandelo Node preset.
BROWSER_FETCH_SKIP_PKGS=(spidermonkey node)

# All targets needed for the Kandelo browser UI and retained browser labs.
# Each entry's `has_X` short-circuits when its release binary is in
# `binaries/`, so this loop is a no-op on a fully-fetched checkout.
# sysroot/sysroot64 are NOT listed: they're toolchain prerequisites for source
# builds, and any `build_X` whose prebuilt is missing calls `need_sysroot`
# lazily.
BROWSER_DEPS=(kernel rootfs programs dash bash coreutils grep sed bc file less m4 make tar curl-cli wget gzip bzip2 xz zstd zip unzip nano lsof vim vim-zip nethack nethack-zip fbdoom git dinit msmtpd nginx nginx-vfs php php-fpm nginx-php-vfs mariadb mariadb-vfs mariadb-test mariadb64 mariadb64-vfs shell-vfs spidermonkey-node node node-vfs wp-vfs lamp-vfs)

build_browser() {
    for t in "${BROWSER_DEPS[@]}"; do
        build_target "$t"
    done
}

fetch_browser_binaries() {
    local disabled_pkgs
    local fetch_args=()
    disabled_pkgs="${BROWSER_EXTERNAL_GALLERY_PKGS[*]} ${BROWSER_FETCH_SKIP_PKGS[*]}"
    if [ "${#FETCH_ONLY_ARGS[@]}" -gt 0 ]; then
        fetch_args+=("${FETCH_ONLY_ARGS[@]}")
    fi
    if [ "${#ALLOW_STALE_ARGS[@]}" -gt 0 ]; then
        fetch_args+=("${ALLOW_STALE_ARGS[@]}")
    fi
    if [ ${#fetch_args[@]} -eq 0 ]; then
        # Browser prep has a source-build fallback for every enabled demo
        # target below. A single stale release archive should not abort before
        # build_browser gets a chance to satisfy the missing artifact locally.
        fetch_args=(--allow-stale)
    fi
    WASM_POSIX_FETCH_SKIP_PKGS="${WASM_POSIX_FETCH_SKIP_PKGS:-} $disabled_pkgs" \
        "$REPO_ROOT/scripts/fetch-binaries.sh" "${fetch_args[@]}"
}

build_all() {
    build_kernel
    build_sysroot
    build_sdk
    build_host
    build_rootfs
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
    build_msmtpd
    build_cpython
    build_python_vfs
    build_perl
    build_perl_vfs
    build_ruby
    build_shell_vfs
    build_node_vfs
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
            rm -f "$REPO_ROOT/host/wasm/kandelo-kernel.wasm" \
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
        rootfs)
            rm -f "$REPO_ROOT/host/wasm/rootfs.vfs"
            warn "Cleaned rootfs.vfs" ;;
        programs)
            rm -f "$REPO_ROOT/host/wasm/fork-exec.wasm"
            rm -f "$REPO_ROOT/host/wasm/"*.wasm 2>/dev/null || true
            # Keep kernel wasm files
            if [ -f "$REPO_ROOT/target/wasm32-unknown-unknown/release/kandelo_kernel.wasm" ]; then
                mkdir -p "$REPO_ROOT/host/wasm"
                cp "$REPO_ROOT/target/wasm32-unknown-unknown/release/kandelo_kernel.wasm" \
                    "$REPO_ROOT/host/wasm/kandelo-kernel.wasm"
            fi
            warn "Cleaned programs" ;;
        dash)
            rm -rf "$REPO_ROOT/packages/registry/dash/dash-src" \
                   "$REPO_ROOT/packages/registry/dash/bin"
            warn "Cleaned dash" ;;
        bash)
            rm -rf "$REPO_ROOT/packages/registry/bash/bash-src" \
                   "$REPO_ROOT/packages/registry/bash/bin"
            warn "Cleaned bash" ;;
        coreutils)
            rm -rf "$REPO_ROOT/packages/registry/coreutils/coreutils-src" \
                   "$REPO_ROOT/packages/registry/coreutils/bin"
            warn "Cleaned coreutils" ;;
        grep)
            rm -rf "$REPO_ROOT/packages/registry/grep/grep-src" \
                   "$REPO_ROOT/packages/registry/grep/bin"
            warn "Cleaned grep" ;;
        sed)
            rm -rf "$REPO_ROOT/packages/registry/sed/sed-src" \
                   "$REPO_ROOT/packages/registry/sed/bin"
            warn "Cleaned sed" ;;
        nginx)
            rm -rf "$REPO_ROOT/packages/registry/nginx/nginx-src"
            rm -f "$REPO_ROOT/packages/registry/nginx/nginx.wasm"
            warn "Cleaned nginx" ;;
        php)
            rm -rf "$REPO_ROOT/packages/registry/php/php-src" \
                   "$REPO_ROOT/packages/registry/php/php-install"
            warn "Cleaned PHP CLI" ;;
        php-fpm)
            rm -f "$REPO_ROOT/local-binaries/programs/wasm32/php/php-fpm.wasm" \
                  "$REPO_ROOT/packages/registry/php/php-src/sapi/fpm/php-fpm"
            warn "Cleaned PHP-FPM" ;;
        mariadb)
            rm -rf "$REPO_ROOT/packages/registry/mariadb/mariadb-src" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-install" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-cross-build" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-glue-objs" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-host-build" \
                   "$REPO_ROOT/packages/registry/mariadb/pcre2-"* \
                   "$REPO_ROOT/packages/registry/mariadb/pcre2-wasm-build"
            ;;
        mariadb64)
            rm -rf "$REPO_ROOT/packages/registry/mariadb/mariadb-install-64" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-cross-build-64" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-glue-objs-64"
            warn "Cleaned MariaDB" ;;
        mariadb-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/mariadb.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/mariadb-vfs.vfs.zst"
            warn "Cleaned MariaDB VFS image (wasm32)" ;;
        mariadb64-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/mariadb-64.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm64/mariadb-vfs.vfs.zst"
            warn "Cleaned MariaDB VFS image (wasm64)" ;;
        redis)
            rm -rf "$REPO_ROOT/packages/registry/redis/redis-src" \
                   "$REPO_ROOT/packages/registry/redis/bin"
            warn "Cleaned Redis" ;;
        dinit)
            rm -rf "$REPO_ROOT/packages/registry/dinit/dinit-src" \
                   "$REPO_ROOT/packages/registry/dinit/bin"
            warn "Cleaned dinit" ;;
        msmtpd)
            rm -rf "$REPO_ROOT/packages/registry/msmtpd/msmtp-src" \
                   "$REPO_ROOT/packages/registry/msmtpd/bin" \
                   "$REPO_ROOT/packages/registry/msmtpd"/msmtp-*.tar.xz
            warn "Cleaned msmtpd" ;;
        cpython)
            rm -rf "$REPO_ROOT/packages/registry/cpython/cpython-src" \
                   "$REPO_ROOT/packages/registry/cpython/cpython-host-build" \
                   "$REPO_ROOT/packages/registry/cpython/cpython-cross-build" \
                   "$REPO_ROOT/packages/registry/cpython/cpython-install" \
                   "$REPO_ROOT/packages/registry/cpython/bin"
            warn "Cleaned CPython" ;;
        python-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/python.vfs.zst"
            warn "Cleaned Python VFS image" ;;
        perl-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/perl.vfs.zst"
            warn "Cleaned Perl VFS image" ;;
        shell-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"
            pkg_remove_local_output shell shell.vfs.zst wasm32
            warn "Cleaned Shell VFS image" ;;
        node)
            rm -rf "$REPO_ROOT/packages/registry/spidermonkey-node/bin" \
                   "$REPO_ROOT/local-binaries/programs/wasm32/node.wasm"
            warn "Cleaned node" ;;
        spidermonkey-node)
            rm -rf "$REPO_ROOT/packages/registry/spidermonkey-node/bin" \
                   "$REPO_ROOT/local-binaries/programs/wasm32/spidermonkey-node.wasm"
            warn "Cleaned spidermonkey-node" ;;
        node-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/node-vfs.vfs.zst"
            warn "Cleaned Node VFS image" ;;
        wordpress)
            rm -rf "$REPO_ROOT/packages/registry/wordpress/wordpress" \
                   "$REPO_ROOT/packages/registry/wordpress/sqlite-database-integration"
            warn "Cleaned WordPress" ;;
        wp-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/wordpress.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/wordpress.vfs.zst"
            warn "Cleaned WP VFS image" ;;
        lamp-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/lamp.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/lamp.vfs.zst"
            warn "Cleaned LAMP VFS image" ;;
        nginx-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/nginx.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/nginx-vfs.vfs.zst"
            warn "Cleaned nginx VFS image" ;;
        redis-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/redis.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/redis-vfs.vfs.zst"
            warn "Cleaned Redis VFS image" ;;
        nginx-php-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/nginx-php.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst"
            warn "Cleaned nginx + PHP-FPM VFS image" ;;
        erlang)
            rm -rf "$REPO_ROOT/packages/registry/erlang/erlang-src" \
                   "$REPO_ROOT/packages/registry/erlang/erlang-install" \
                   "$REPO_ROOT/packages/registry/erlang/bin"
            warn "Cleaned Erlang" ;;
        erlang-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/erlang.vfs.zst"
            warn "Cleaned Erlang VFS image" ;;
        bc)
            rm -rf "$REPO_ROOT/packages/registry/bc/bc-src" \
                   "$REPO_ROOT/packages/registry/bc/bin"
            warn "Cleaned bc" ;;
        file)
            rm -rf "$REPO_ROOT/packages/registry/file/file-src" \
                   "$REPO_ROOT/packages/registry/file/bin"
            warn "Cleaned file" ;;
        less)
            rm -rf "$REPO_ROOT/packages/registry/less/less-src" \
                   "$REPO_ROOT/packages/registry/less/bin"
            warn "Cleaned less" ;;
        m4)
            rm -rf "$REPO_ROOT/packages/registry/m4/m4-src" \
                   "$REPO_ROOT/packages/registry/m4/bin"
            warn "Cleaned m4" ;;
        make)
            rm -rf "$REPO_ROOT/packages/registry/make/make-src" \
                   "$REPO_ROOT/packages/registry/make/bin"
            warn "Cleaned make" ;;
        tar)
            rm -rf "$REPO_ROOT/packages/registry/tar/tar-src" \
                   "$REPO_ROOT/packages/registry/tar/bin"
            warn "Cleaned tar" ;;
        curl-cli)
            rm -rf "$REPO_ROOT/packages/registry/curl/curl-src" \
                   "$REPO_ROOT/packages/registry/curl/bin"
            warn "Cleaned curl" ;;
        wget)
            rm -rf "$REPO_ROOT/packages/registry/wget/wget-src" \
                   "$REPO_ROOT/packages/registry/wget/bin"
            warn "Cleaned wget" ;;
        gzip)
            rm -rf "$REPO_ROOT/packages/registry/gzip/gzip-src" \
                   "$REPO_ROOT/packages/registry/gzip/bin"
            warn "Cleaned gzip" ;;
        bzip2)
            rm -rf "$REPO_ROOT/packages/registry/bzip2/bzip2-src" \
                   "$REPO_ROOT/packages/registry/bzip2/bin"
            warn "Cleaned bzip2" ;;
        xz)
            rm -rf "$REPO_ROOT/packages/registry/xz/xz-src" \
                   "$REPO_ROOT/packages/registry/xz/bin"
            warn "Cleaned xz" ;;
        zstd)
            rm -rf "$REPO_ROOT/packages/registry/zstd/zstd-src" \
                   "$REPO_ROOT/packages/registry/zstd/bin"
            warn "Cleaned zstd" ;;
        zip)
            rm -rf "$REPO_ROOT/packages/registry/zip/zip-src" \
                   "$REPO_ROOT/packages/registry/zip/bin"
            warn "Cleaned zip" ;;
        unzip)
            rm -rf "$REPO_ROOT/packages/registry/unzip/unzip-src" \
                   "$REPO_ROOT/packages/registry/unzip/bin"
            warn "Cleaned unzip" ;;
        nano)
            rm -rf "$REPO_ROOT/packages/registry/nano/nano-src" \
                   "$REPO_ROOT/packages/registry/nano/bin"
            warn "Cleaned nano" ;;
        nethack)
            rm -rf "$REPO_ROOT/packages/registry/nethack/nethack-src" \
                   "$REPO_ROOT/packages/registry/nethack/bin" \
                   "$REPO_ROOT/packages/registry/nethack/runtime"
            rm -f "$REPO_ROOT/apps/browser-demos/public/nethack.zip" \
                  "$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"
            warn "Cleaned NetHack (also invalidated nethack.zip and shell.vfs.zst; run '$0 build shell-vfs' to regenerate for browser demo)" ;;
        fbdoom)
            rm -rf "$REPO_ROOT/packages/registry/fbdoom/fbdoom-src" \
                   "$REPO_ROOT/local-binaries/programs/wasm32/fbdoom"
            rm -f "$REPO_ROOT/packages/registry/fbdoom/fbdoom.wasm" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/fbdoom.wasm" \
                  "$REPO_ROOT/packages/registry/fbdoom/doom1.wad" \
                  "$REPO_ROOT/packages/registry/fbdoom/COPYING.txt" \
                  "$REPO_ROOT/packages/registry/fbdoom/CREDITS.txt" \
                  "$REPO_ROOT/packages/registry/fbdoom/CREDITS-MUSIC.txt"
            warn "Cleaned fbDOOM" ;;
        ncurses)
            rm -rf "$REPO_ROOT/packages/registry/ncurses/ncurses-src"
            # ncurses installs into sysroot, cleaned with sysroot
            warn "Cleaned ncurses (rebuild sysroot to fully clean)" ;;
        zlib)
            rm -rf "$REPO_ROOT/packages/registry/zlib/zlib-src" \
                   "$REPO_ROOT/packages/registry/zlib/zlib-install"
            # zlib installs into sysroot, cleaned with sysroot
            warn "Cleaned zlib (rebuild sysroot to fully clean)" ;;
        openssl)
            rm -rf "$REPO_ROOT/packages/registry/openssl/openssl-src" \
                   "$REPO_ROOT/packages/registry/openssl/openssl-install"
            warn "Cleaned OpenSSL (rebuild sysroot to fully clean)" ;;
        libcurl)
            rm -rf "$REPO_ROOT/packages/registry/libcurl/curl-src"
            warn "Cleaned libcurl (rebuild sysroot to fully clean)" ;;
        vim)
            rm -rf "$REPO_ROOT/packages/registry/vim/vim-src" \
                   "$REPO_ROOT/packages/registry/vim/bin" \
                   "$REPO_ROOT/packages/registry/vim/runtime"
            rm -f "$REPO_ROOT/apps/browser-demos/public/vim.zip" \
                  "$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/vim.zip"
            warn "Cleaned Vim (also invalidated vim.zip and shell.vfs.zst; run '$0 build shell-vfs' to regenerate for browser demo)" ;;
        vim-zip)
            rm -f "$REPO_ROOT/apps/browser-demos/public/vim.zip" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/vim.zip"
            warn "Cleaned vim.zip" ;;
        git)
            rm -rf "$REPO_ROOT/packages/registry/git/git-src" \
                   "$REPO_ROOT/packages/registry/git/bin"
            warn "Cleaned git" ;;
        perl)
            rm -rf "$REPO_ROOT/packages/registry/perl/perl-src" \
                   "$REPO_ROOT/packages/registry/perl/bin"
            warn "Cleaned Perl" ;;
        ruby)
            rm -rf "$REPO_ROOT/packages/registry/ruby/ruby-src" \
                   "$REPO_ROOT/packages/registry/ruby/ruby-host-build" \
                   "$REPO_ROOT/packages/registry/ruby/ruby-cross-build" \
                   "$REPO_ROOT/packages/registry/ruby/ruby-install" \
                   "$REPO_ROOT/packages/registry/ruby/bin"
            warn "Cleaned Ruby" ;;
        texlive)
            rm -rf "$REPO_ROOT/packages/registry/texlive/texlive-src" \
                   "$REPO_ROOT/packages/registry/texlive/texlive-host-build" \
                   "$REPO_ROOT/packages/registry/texlive/texlive-cross-build" \
                   "$REPO_ROOT/packages/registry/texlive/bin"
            warn "Cleaned TeX Live" ;;
        texlive-vfs)
            rm -rf "$REPO_ROOT/packages/registry/texlive/texlive-dist" \
                   "$REPO_ROOT/packages/registry/texlive/texlive-fmt" \
                   "$REPO_ROOT/packages/registry/texlive/install-tl" \
                   "$REPO_ROOT/packages/registry/texlive/texlive.profile"
            rm -f "$REPO_ROOT/apps/browser-demos/public/texlive-bundle.json"
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
            for t in kernel sysroot sysroot64 host rootfs programs dash bash coreutils grep sed bc file less m4 make tar curl-cli wget gzip bzip2 xz zstd zip unzip nano ncurses zlib openssl libcurl vim vim-zip git nginx php php-fpm mariadb mariadb-vfs mariadb64 mariadb64-vfs redis dinit msmtpd cpython python-vfs perl perl-vfs ruby shell-vfs node node-vfs wordpress wp-vfs lamp-vfs erlang erlang-vfs texlive texlive-vfs dlopen; do
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
        KANDELO_REBUILD_TARGET="$t" build_target "$t"
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
            exec npx tsx "$REPO_ROOT/packages/registry/nginx/demo/serve.ts" "$@"
            ;;
        mariadb)
            build_mariadb
            step "Starting MariaDB"
            exec npx tsx "$REPO_ROOT/packages/registry/mariadb/demo/serve.ts" "$@"
            ;;
        redis)
            build_redis
            step "Starting Redis"
            exec npx tsx "$REPO_ROOT/packages/registry/redis/demo/serve.ts" "$@"
            ;;
        wordpress)
            build_php
            build_wordpress
            step "Starting WordPress (PHP built-in server + SQLite)"
            exec npx tsx "$REPO_ROOT/packages/registry/wordpress/demo/serve.ts" "$@"
            ;;
        wordpress-nginx)
            build_nginx
            build_php_fpm
            build_wordpress
            step "Starting WordPress (nginx + PHP-FPM + SQLite)"
            exec npx tsx "$REPO_ROOT/packages/registry/wordpress/demo/serve-nginx.ts" "$@"
            ;;
        lamp)
            build_mariadb
            build_nginx
            build_php_fpm
            # LAMP uses its own WordPress setup (MySQL mode)
            if [ ! -f "$REPO_ROOT/packages/registry/lamp/demo/wordpress/wp-settings.php" ]; then
                step "Setting up LAMP WordPress"
                bash "$REPO_ROOT/packages/registry/lamp/demo/setup.sh"
            fi
            step "Starting LAMP stack (MariaDB + PHP-FPM + nginx + WordPress)"
            exec npx tsx "$REPO_ROOT/packages/registry/lamp/demo/serve.ts" "$@"
            ;;
        shell)
            build_programs
            build_dash
            build_coreutils
            build_grep
            build_sed
            need_host
            step "Starting interactive shell"
            exec npx tsx "$REPO_ROOT/packages/registry/shell/demo/serve.ts" "$@"
            ;;
        erlang)
            build_erlang
            step "Starting Erlang BEAM"
            exec npx tsx "$REPO_ROOT/packages/registry/erlang/demo/serve.ts" "$@"
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
    step "Fetching binaries pinned by per-package package.toml"
    local fetch_args=()
    if [ "${#FETCH_ONLY_ARGS[@]}" -gt 0 ]; then
        fetch_args+=("${FETCH_ONLY_ARGS[@]}")
    fi
    if [ "${#ALLOW_STALE_ARGS[@]}" -gt 0 ]; then
        fetch_args+=("${ALLOW_STALE_ARGS[@]}")
    fi
    "$REPO_ROOT/scripts/fetch-binaries.sh" "${fetch_args[@]}" "$@"
}

cmd_prepare_browser() {
    # Fetch the per-package binaries for the browser UI and retained labs first.
    # The resolver-aware has_X
    # guards below then treat fetched binaries as "already built", so
    # build_browser's per-target loop is a no-op for anything that's
    # already published. Only genuinely missing artifacts (local-only
    # programs, stale VFS images) trigger a build.
    if [ "$ALREADY_MATERIALIZED" -eq 1 ]; then
        step "Using already-materialized binaries for Kandelo browser UI"
    else
        step "Fetching binaries for Kandelo browser UI"
        fetch_browser_binaries
    fi

    build_browser
}

cmd_browser() {
    local BROWSER_DIR="$REPO_ROOT/apps/browser-demos"

    cmd_prepare_browser

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
                if ! cargo test -p kandelo --target aarch64-apple-darwin --lib; then
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
                cd "$REPO_ROOT/apps/browser-demos"
                [ -d node_modules ] || npm install
                if ! npx playwright test --grep-invert "@slow"; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            browser-all)
                step "Running ALL browser E2E tests (including @slow)"
                cd "$REPO_ROOT/apps/browser-demos"
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
    echo "  rootfs      Canonical host rootfs.vfs             $(has_rootfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
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
    echo "  dinit       dinit service supervisor              $(has_dinit && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  msmtpd      Local SMTP capture server             $(has_msmtpd && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  cpython     CPython 3.13 Wasm binary              $(has_cpython && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  python-vfs  Python stdlib VFS image               $(has_python_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  perl-vfs    Perl stdlib VFS image                 $(has_perl_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  shell-vfs   Shell environment VFS image           $(has_shell_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  node        SpiderMonkey Node compatibility binary $(has_node && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  spidermonkey-node  SpiderMonkey Node-compatible binary $(has_spidermonkey_node && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  node-vfs    Node + npm VFS image                  $(has_node_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
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
    echo "  ./run.sh fetch                       Fetch binaries pinned by per-package package.toml"
    echo ""
    echo "${BOLD}Top-level flags:${RESET}"
    echo "  --allow-stale                        Accepted for back-compat. The resolver"
    echo "                                        source-builds automatically on any"
    echo "                                        verification failure. No-op today."
    echo "  --fetch-only                         Refuse source-build fallback when"
    echo "                                        fetching package binaries."
    echo "  --already-materialized               Skip browser package fetching and use"
    echo "                                        the existing binaries/ tree."
    echo "  --pr-staging                         Use the current PR's staging binary"
    echo "                                        index unless WASM_POSIX_BINARY_INDEX_URL"
    echo "                                        is already set."
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
    echo "  ./run.sh prepare-browser             Fetch/build browser UI assets"
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
    prepare-browser) cmd_prepare_browser ;;
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
