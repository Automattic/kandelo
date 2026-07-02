#!/usr/bin/env bash
# Build the curl CLI for wasm32-posix-kernel.
#
# The curl CLI is a side-output of libcurl's build (libcurl's configure
# builds both `lib/libcurl.a` and `src/curl`). To keep curl as its own
# package-management entry — exposing `programs/curl.wasm` to consumers
# — this script delegates to libcurl's build-libcurl.sh and surfaces
# the produced binary at the path the resolver expects.
#
# When invoked under `xtask build-deps resolve curl`:
#   - WASM_POSIX_DEP_OUT_DIR is set to curl's scratch dir.
#   - Direct zlib/openssl dependencies are surfaced to the delegated
#     libcurl build script so the standalone CLI gets HTTPS and --compressed.
#   - libcurl's build script writes the produced CLI to
#     $WASM_POSIX_DEP_OUT_DIR/curl.wasm.
#   - validate_outputs for the curl manifest finds curl.wasm at OUT_DIR.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

exec bash "$REPO_ROOT/packages/registry/libcurl/build-libcurl.sh" "$@"
