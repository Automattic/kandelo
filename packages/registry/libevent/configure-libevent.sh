#!/usr/bin/env bash
# Shared upstream configure contract for the library and its regression runner.
kandelo_libevent_configure() {
    local source_dir="$1" arch="$2"
    case "$arch" in
        wasm32|wasm64) ;;
        *) echo "Unsupported libevent architecture: $arch" >&2; return 2 ;;
    esac
    export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
    if [ "$arch" = wasm64 ]; then export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot64"; fi
    cd "$source_dir"
    CFLAGS="${CFLAGS:--O2}" "${arch}posix-configure" \
        --prefix=/usr --enable-static --disable-shared \
        --disable-openssl --disable-samples
    make include/event2/event-config.h
    if ! grep -q '^#define EVENT__HAVE_EPOLL 1$' include/event2/event-config.h; then
        echo "libevent must build its epoll backend" >&2
        return 1
    fi
}
