#!/usr/bin/env bash
#
# Stage every release asset into a flat directory and generate
# manifest.json. Helper invoked by publish-release.sh.
#
# Usage:
#   scripts/stage-release.sh --out /tmp/release-staging
#
# Requires built binaries in their canonical locations:
#   target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm
#   target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm
#   host/wasm/{exec-caller,exec-child,fork-exec,ifhwaddr,mmap_shared_test,hello64,sh}.wasm
#   examples/libs/dash/bin/dash.wasm
#   examples/libs/git/bin/{git.wasm,git-remote-http.wasm}
#   examples/libs/vim/bin/vim.wasm (+ runtime at examples/libs/vim/runtime/)

set -euo pipefail

STAGING=""
while [ $# -gt 0 ]; do
    case "$1" in
        --out) STAGING="$2"; shift 2 ;;
        *) echo "unknown arg $1" >&2; exit 2 ;;
    esac
done
[ -n "$STAGING" ] || { echo "--out is required" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
rm -rf "$STAGING" && mkdir -p "$STAGING"

run_xtask() {
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- "$@"
}

# ---------------------------------------------------------------------------
# Kernel + userspace: plain wasm, no bundling.
# ---------------------------------------------------------------------------
run_xtask bundle-program --plain-wasm \
    --program kernel \
    --binary target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm \
    --out-dir "$STAGING"

run_xtask bundle-program --plain-wasm \
    --program userspace \
    --binary target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm \
    --out-dir "$STAGING"

# ---------------------------------------------------------------------------
# Test/example programs — bundle each into its own zip. Version 0.1.0
# placeholder since these don't track an upstream.
# ---------------------------------------------------------------------------
stage_example() {
    local name="$1"; local src="$2"
    run_xtask bundle-program \
        --plain-wasm \
        --program "$name" \
        --upstream-version 0.1.0 \
        --revision 1 \
        --binary "$src" \
        --out-dir "$STAGING"
}

stage_example exec-caller       local-binaries/programs/exec-caller.wasm
stage_example exec-child        local-binaries/programs/exec-child.wasm
stage_example fork-exec         local-binaries/programs/fork-exec.wasm
stage_example ifhwaddr          local-binaries/programs/ifhwaddr.wasm
stage_example mmap_shared_test  local-binaries/programs/mmap_shared_test.wasm
stage_example hello64           local-binaries/programs/hello64.wasm

# ---------------------------------------------------------------------------
# Ported programs with real upstream versions.
# ---------------------------------------------------------------------------
# dash: the canonical shell binary. VFS demos symlink /bin/sh -> /bin/dash
# at image-build time, so no separate `sh` release entry is needed.
run_xtask bundle-program --plain-wasm \
    --program dash \
    --upstream-version 0.5.12 \
    --revision 1 \
    --binary examples/libs/dash/bin/dash.wasm \
    --out-dir "$STAGING"

# git: the git binary + its git-remote-http transport helper in one
# bundle, since they're inseparable at runtime.
run_xtask bundle-program \
    --program git \
    --upstream-version 2.47.1 \
    --revision 1 \
    --binary examples/libs/git/bin/git.wasm \
    --extra-file "examples/libs/git/bin/git-remote-http.wasm=git-remote-http.wasm" \
    --out-dir "$STAGING"

# vim: the binary plus its runtime (syntax/ftplugin/colors/autoload/etc.)
VIM_LICENSE="examples/libs/vim/vim-src/LICENSE"
vim_license_arg=()
if [ -f "$VIM_LICENSE" ]; then
    vim_license_arg=(--license "$VIM_LICENSE")
fi
run_xtask bundle-program \
    --program vim \
    --upstream-version 9.1.0900 \
    --revision 1 \
    --binary examples/libs/vim/bin/vim.wasm \
    --runtime-root examples/libs/vim/runtime \
    --runtime-prefix share/vim/vim91 \
    "${vim_license_arg[@]}" \
    --out-dir "$STAGING"

# ---------------------------------------------------------------------------
# Single-binary ported programs. For each: invoke bundle-program with the
# binary and a version. Versions are kept in sync with each program's
# per-dir manifest at `examples/libs/<name>/deps.toml`. Chunk E will
# rewire stage-release to read versions from those manifests directly.
# ---------------------------------------------------------------------------
simple() {
    local program="$1"; local version="$2"; local binary="$3"
    [ -f "$binary" ] || { echo "skip $program: $binary missing"; return; }
    run_xtask bundle-program --plain-wasm \
        --program "$program" --upstream-version "$version" --revision 1 \
        --binary "$binary" --out-dir "$STAGING"
}

simple bc        1.07.1  examples/libs/bc/bin/bc.wasm
simple bzip2     1.0.8   examples/libs/bzip2/bin/bzip2.wasm
simple coreutils 9.6     examples/libs/coreutils/bin/coreutils.wasm
simple cpython   3.13.3  examples/libs/cpython/bin/python.wasm
simple curl      8.10.1  examples/libs/curl/bin/curl.wasm
simple erlang    28.2    examples/libs/erlang/beam.wasm
simple file      5.45    examples/libs/file/bin/file.wasm
simple gawk      5.3.0   examples/libs/gawk/bin/gawk.wasm
simple grep      3.11    examples/libs/grep/bin/grep.wasm
simple gzip      1.13    examples/libs/gzip/bin/gzip.wasm
simple m4        1.4.19  examples/libs/m4/bin/m4.wasm
simple make      4.4.1   examples/libs/make/bin/make.wasm
simple nano      8.0     examples/libs/nano/bin/nano.wasm
simple nginx     1.24.0  examples/nginx/nginx.wasm
simple perl      5.40.3  examples/libs/perl/bin/perl.wasm
simple ruby      3.3.5   examples/libs/ruby/bin/ruby.wasm
simple sed       4.9     examples/libs/sed/bin/sed.wasm
simple sqlite-cli 3.45.0  examples/libs/sqlite/sqlite-install/bin/sqlite3.wasm
simple tar       1.35    examples/libs/tar/bin/tar.wasm
simple tcl       9.0.1   examples/libs/tcl/bin/tclsh.wasm
simple unzip     6.0     examples/libs/unzip/bin/unzip.wasm
simple xz        5.6.2   examples/libs/xz/bin/xz.wasm
simple zip       3.0     examples/libs/zip/bin/zip.wasm
simple zstd      1.5.6   examples/libs/zstd/bin/zstd.wasm

# ---------------------------------------------------------------------------
# Multi-binary programs — bundle all binaries under a single program name.
# ---------------------------------------------------------------------------
run_xtask bundle-program \
    --program diffutils --upstream-version 3.10 --revision 1 \
    --binary examples/libs/diffutils/bin/diff.wasm \
    --extra-file "examples/libs/diffutils/bin/cmp.wasm=cmp.wasm" \
    --extra-file "examples/libs/diffutils/bin/diff3.wasm=diff3.wasm" \
    --extra-file "examples/libs/diffutils/bin/sdiff.wasm=sdiff.wasm" \
    --out-dir "$STAGING"

run_xtask bundle-program \
    --program findutils --upstream-version 4.10.0 --revision 1 \
    --binary examples/libs/findutils/bin/find.wasm \
    --extra-file "examples/libs/findutils/bin/xargs.wasm=xargs.wasm" \
    --out-dir "$STAGING"

run_xtask bundle-program \
    --program redis --upstream-version 7.2.5 --revision 1 \
    --binary examples/libs/redis/bin/redis-server.wasm \
    --extra-file "examples/libs/redis/bin/redis-cli.wasm=redis-cli.wasm" \
    --out-dir "$STAGING"

run_xtask bundle-program \
    --program mariadb --upstream-version 10.5.28 --revision 1 \
    --binary examples/libs/mariadb/mariadb-install/bin/mariadbd.wasm \
    --extra-file "examples/libs/mariadb/mariadb-install/bin/mysqltest.wasm=mysqltest.wasm" \
    --out-dir "$STAGING"

# PHP ships two binaries: the CLI (`php.wasm`) and the FastCGI Process
# Manager (`php-fpm.wasm`) used by nginx for serving PHP apps. The CLI
# is built by `examples/libs/php/build-php.sh`; php-fpm is built by
# `examples/nginx/build-php-fpm.sh`. Both are required for the full
# LAMP demo.
if [ -f "examples/nginx/php-fpm.wasm" ]; then
    run_xtask bundle-program \
        --program php --upstream-version 8.3.2 --revision 1 \
        --binary examples/libs/php/bin/php.wasm \
        --extra-file "examples/nginx/php-fpm.wasm=php-fpm.wasm" \
        --out-dir "$STAGING"
else
    # Fall back to CLI-only when php-fpm hasn't been built. The LAMP
    # demos will warn at runtime when php-fpm.wasm is missing.
    run_xtask bundle-program --plain-wasm \
        --program php --upstream-version 8.3.2 --revision 1 \
        --binary examples/libs/php/bin/php.wasm \
        --out-dir "$STAGING"
fi

# ---------------------------------------------------------------------------
# Generate manifest.
# ---------------------------------------------------------------------------
run_xtask build-manifest \
    --in "$STAGING" \
    --out "$STAGING/manifest.json" \
    --tag "binaries-abi-v$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')" \
    ${GENERATED_AT:+--generated-at "$GENERATED_AT"}

echo
echo "== Staged assets =="
ls -la "$STAGING/" | grep -v '^total' | grep -v '^d' | awk '{printf "  %10s  %s\n", $5, $NF}'
