#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$(kandelo_package_make_work_dir tmux)"
trap 'rm -rf "$WORK_DIR"' EXIT
SRC_DIR="$WORK_DIR/source"
: "${WASM_POSIX_DEP_LIBEVENT_DIR:?declare libevent}"
: "${WASM_POSIX_DEP_NCURSES_DIR:?declare ncurses}"
: "${WASM_POSIX_DEP_UTF8PROC_DIR:?declare utf8proc}"
kandelo_package_stage_primary_source tmux "$SRC_DIR" "$WORK_DIR"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
export CPPFLAGS="${CPPFLAGS:-} -I$WASM_POSIX_DEP_LIBEVENT_DIR/include -I$WASM_POSIX_DEP_NCURSES_DIR/include -I$WASM_POSIX_DEP_UTF8PROC_DIR/include"
export LDFLAGS="${LDFLAGS:-} -L$WASM_POSIX_DEP_LIBEVENT_DIR/lib -L$WASM_POSIX_DEP_NCURSES_DIR/lib -L$WASM_POSIX_DEP_UTF8PROC_DIR/lib"
export PKG_CONFIG_PATH="$WASM_POSIX_DEP_LIBEVENT_DIR/lib/pkgconfig:$WASM_POSIX_DEP_NCURSES_DIR/lib/pkgconfig:$WASM_POSIX_DEP_UTF8PROC_DIR/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LIBEVENT_CORE_CFLAGS="-I$WASM_POSIX_DEP_LIBEVENT_DIR/include"
export LIBEVENT_CORE_LIBS="-L$WASM_POSIX_DEP_LIBEVENT_DIR/lib -levent_core"
export LIBTINFOW_CFLAGS="-I$WASM_POSIX_DEP_NCURSES_DIR/include"
export LIBTINFOW_LIBS="-L$WASM_POSIX_DEP_NCURSES_DIR/lib -ltinfow"
export LIBUTF8PROC_CFLAGS="-I$WASM_POSIX_DEP_UTF8PROC_DIR/include"
export LIBUTF8PROC_LIBS="-L$WASM_POSIX_DEP_UTF8PROC_DIR/lib -lutf8proc"
cd "$SRC_DIR"
CFLAGS="${CFLAGS:--O2}" wasm32posix-configure --prefix=/usr \
    --enable-static --enable-utf8proc --disable-utempter --disable-systemd
make -j4 tmux
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary tmux "$SRC_DIR/tmux" tmux.wasm
