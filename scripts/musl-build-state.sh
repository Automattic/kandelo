#!/usr/bin/env bash
# Shared completeness/freshness contract, sourced by build-musl and its tests.
source "$(dirname "${BASH_SOURCE[0]}")/build-step-input-hash.sh"

kandelo_musl_input_hash() {
    local repo="$1" arch="$2" compiler="$3" plugin="$4"
    node "$repo/scripts/musl-input-hash.mjs" "$repo" "$arch" "$compiler" "$plugin"
}

kandelo_musl_is_current() {
    local sysroot="$1" hash="$2" output
    for output in lib/libc.a lib/crt1.o lib/crti.o lib/crtn.o \
        lib/libkandelo-ucontext-unsupported.a include/stdio.h \
        include/bits/alltypes.h include/bits/kandelo_thread_syscalls.h; do
        [ -s "$sysroot/$output" ] || return 1
    done
    build_step_is_current "$sysroot/lib/libc.a" "$sysroot/.kandelo-musl.input-hash" "$hash" || return
    node "$(dirname "${BASH_SOURCE[0]}")/musl-output-state.mjs" check "$sysroot" >/dev/null 2>&1
}
