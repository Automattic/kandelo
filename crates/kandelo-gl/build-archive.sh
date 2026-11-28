#!/usr/bin/env bash
# Builds the kandelo-gl guest driver (crates/kandelo-gl) as the wasm32 static
# library SDK-built C programs link: local-binaries/libkandelo_gl.a.
#
# The archive carries its own core, alloc and compiler_builtins, built for
# the Kandelo no_std target (sdk/rust/wasm32-unknown-kandelo.json) so its
# objects agree with the SDK's C objects on the shared-memory features
# (+atomics, +bulk-memory, +mutable-globals). It is not installed in the
# sysroot yet; the slice's test programs link it by path
# (scripts/build-programs.sh, host/test/kgpu-gl-link.test.ts).
#
# WHY not build-wasm.sh: that name marks a co-resident side module, a .wasm
# the hosts load beside the kernel; xtask requires each one in
# CORESIDENT_SIDE_MODULES and projects it into local-binaries/source-only-v1/.
# This archive is a link input for guest programs, never loaded by a host.
#
# Usage (inside scripts/dev-shell.sh):
#   bash crates/kandelo-gl/build-archive.sh                 build
#   bash crates/kandelo-gl/build-archive.sh --verify-fresh  exit 0 iff current
set -euo pipefail
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
HOST="$(rustc -vV | awk '/^host/ {print $2}')"
TARGET_SPEC="sdk/rust/wasm32-unknown-kandelo.json"
ARTIFACT="local-binaries/libkandelo_gl.a"
# The closure covers kandelo-gl's workspace dependencies (kgpu-stream,
# wasm-posix-shared) through cargo metadata.
KEY="$(cargo run -q -p xtask --target "$HOST" -- workspace-closure-sha \
    --crates kandelo-gl --recipe crates/kandelo-gl/build-archive.sh)"
if [ "${1:-}" = --verify-fresh ]; then
    test -f "$ARTIFACT" && test -f "$ARTIFACT.build-key" && test "$(cat "$ARTIFACT.build-key")" = "$KEY"
    exit
fi
test "$#" = 0

# The target spec already selects panic = abort; naming it keeps the
# library's panic strategy explicit next to the std crates it rebuilds.
export CARGO_PROFILE_RELEASE_PANIC=abort
# Only the staticlib: rustc skips LTO when an rlib is produced alongside it,
# which would leave every core and alloc codegen unit as its own member.
cargo rustc --release -p kandelo-gl --lib --crate-type staticlib \
    -Z json-target-spec -Z build-std=core,alloc,compiler_builtins \
    --target "$TARGET_SPEC"
SOURCE="target/wasm32-unknown-kandelo/release/libkandelo_gl.a"

# The driver's C entry points must be defined in the archive; an entry
# point that is only declared would become an unresolved symbol at the
# program's link instead.
DEFINED="$(llvm-nm --defined-only "$SOURCE" 2>/dev/null)"
if ! grep -qE '^[0-9a-f]+ T eglGetError$' <<<"$DEFINED"; then
    echo "error: $SOURCE does not define eglGetError" >&2
    exit 1
fi

mkdir -p local-binaries
cp "$SOURCE" "$ARTIFACT.next"
mv "$ARTIFACT.next" "$ARTIFACT"
printf '%s\n' "$KEY" > "$ARTIFACT.build-key"
echo "$ARTIFACT: $(wc -c < "$ARTIFACT" | tr -d ' ') bytes"
