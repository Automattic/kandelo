#!/usr/bin/env bash
#
# Build libcss (libcss.a) for wasm32-posix-kernel with the NetSurf build
# system. See scripts/netsurf-library-build.sh for how and why.
#
# libcss generates one parser per CSS property at build time: the build
# system compiles src/parse/properties/css_property_parser_gen.c with the
# host compiler (BUILD_CC) and runs it over properties.gen. Only that
# generator runs on the build machine; everything installed is Wasm.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../../scripts/netsurf-library-build.sh"

netsurf_library_setup "$SCRIPT_DIR" libcss
netsurf_library_require_dep libparserutils lib/libparserutils.a
netsurf_library_require_dep libwapcaplet lib/libwapcaplet.a
netsurf_library_stage_source
netsurf_library_make_install
netsurf_library_install
