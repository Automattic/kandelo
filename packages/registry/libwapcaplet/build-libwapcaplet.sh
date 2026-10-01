#!/usr/bin/env bash
#
# Build libwapcaplet (libwapcaplet.a) for wasm32-posix-kernel with the NetSurf
# build system. See scripts/netsurf-library-build.sh for how and why.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../../scripts/netsurf-library-build.sh"

netsurf_library_setup "$SCRIPT_DIR" libwapcaplet 0.4.3 \
    9b2aa1dd6d6645f8e992b3697fdbd87f0c0e1da5721fa54ed29b484d13160c5c
netsurf_library_stage_source
netsurf_library_make_install
netsurf_library_install
