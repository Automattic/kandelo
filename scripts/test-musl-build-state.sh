#!/usr/bin/env bash
# No compiler mocks: test the shared content/completeness decision directly.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
source "$REPO_ROOT/scripts/musl-build-state.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
fail() { echo "test-musl-build-state: $*" >&2; exit 1; }

for arch in wasm32posix wasm64posix; do
    sysroot="$test_root/$arch"
    mkdir -p "$sysroot/lib" "$sysroot/include/bits"
    for path in lib/libc.a lib/crt1.o lib/crti.o lib/crtn.o \
        lib/libkandelo-ucontext-unsupported.a include/stdio.h \
        include/bits/alltypes.h include/bits/kandelo_thread_syscalls.h; do
        printf 'fixture %s %s\n' "$arch" "$path" > "$sysroot/$path"
    done
    node "$REPO_ROOT/scripts/musl-output-state.mjs" write "$sysroot" > "$sysroot/.kandelo-musl.outputs.json"
    write_build_stamp "$sysroot/.kandelo-musl.input-hash" input-one
    kandelo_musl_is_current "$sysroot" input-one || fail "$arch rejected a complete current SDK"
    cp "$sysroot/.kandelo-musl.outputs.json" "$sysroot/receipt-backup"
    printf '{}\n' > "$sysroot/.kandelo-musl.outputs.json"
    if kandelo_musl_is_current "$sysroot" input-one; then fail "$arch accepted an empty receipt"; fi
    cp "$sysroot/receipt-backup" "$sysroot/.kandelo-musl.outputs.json"
    if kandelo_musl_is_current "$sysroot" input-two; then fail "$arch accepted stale source identity"; fi
    printf 'stale archive\n' > "$sysroot/lib/libc.a"
    if kandelo_musl_is_current "$sysroot" input-one; then fail "$arch accepted replaced libc.a"; fi
    node "$REPO_ROOT/scripts/musl-output-state.mjs" write "$sysroot" > "$sysroot/.kandelo-musl.outputs.json"
    rm "$sysroot/lib/libkandelo-ucontext-unsupported.a"
    if kandelo_musl_is_current "$sysroot" input-one; then fail "$arch accepted an incomplete SDK"; fi
done

# Exercise the fingerprint itself, not only comparison of stored stamps.
# These are minimal source inputs; use the real declared LLVM tools.
input_repo="$test_root/input-repo"
mkdir -p "$input_repo/libc/musl"
for path in scripts/build-musl.sh scripts/musl-build-state.sh \
    scripts/musl-input-hash.mjs scripts/musl-output-state.mjs \
    scripts/build-step-input-hash.sh scripts/install-overlay-headers.sh \
    libc/musl/Makefile sdk/src/lib/calltypes-plugin.ts; do
    mkdir -p "$input_repo/$(dirname "$path")"
    printf 'input %s\n' "$path" > "$input_repo/$path"
done
cp "$REPO_ROOT/scripts/musl-input-hash.mjs" "$input_repo/scripts/musl-input-hash.mjs"
for path in libc/musl/tools libc/musl/include libc/musl/src \
    libc/musl/arch libc/musl/crt libc/musl-overlay libc/glue sdk/src/plugin; do
    mkdir -p "$input_repo/$path"
    printf 'input %s\n' "$path" > "$input_repo/$path/fixture"
done
git -C "$input_repo/libc/musl" init --quiet
git -C "$input_repo/libc/musl" add .
git -C "$input_repo/libc/musl" -c user.name=Fixture \
    -c user.email=fixture@example.invalid commit --quiet -m 'fixture'
printf 'plugin bytes\n' > "$test_root/plugin"
fingerprint() {
    kandelo_musl_input_hash "$input_repo" "$1" \
        "$LLVM_BIN/clang" "$test_root/plugin"
}
initial="$(fingerprint wasm32posix)"
touch "$input_repo/libc/glue/fixture"
[ "$initial" = "$(fingerprint wasm32posix)" ] || fail 'mtime invalidated source fingerprint'
mkdir -p "$input_repo/libc/musl/obj"
printf 'unrelated build output\n' > "$input_repo/libc/musl/obj/fixture.o"
[ "$initial" = "$(fingerprint wasm32posix)" ] || fail 'build output invalidated source fingerprint'
[ "$initial" != "$(fingerprint wasm64posix)" ] || fail 'architectures share a fingerprint'
printf 'changed glue\n' > "$input_repo/libc/glue/fixture"
changed="$(fingerprint wasm32posix)"
[ "$initial" != "$changed" ] || fail 'changed source bytes retained the fingerprint'
printf 'changed plugin bytes\n' > "$test_root/plugin"
[ "$changed" != "$(fingerprint wasm32posix)" ] || fail 'changed compiler plugin retained the fingerprint'
echo 'test-musl-build-state: ok'
