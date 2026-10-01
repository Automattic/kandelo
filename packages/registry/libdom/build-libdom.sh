#!/usr/bin/env bash
#
# Build libdom (libdom.a) for wasm32-posix-kernel with the NetSurf build
# system. See scripts/netsurf-library-build.sh for how and why.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../../scripts/netsurf-library-build.sh"

netsurf_library_setup "$SCRIPT_DIR" libdom 0.4.2 \
    d05e45af16547014c2b0a3aecf3670fa13d419f505b3f5fc7ac8a1491fc30f3c
netsurf_library_require_dep libparserutils lib/libparserutils.a
netsurf_library_require_dep libwapcaplet lib/libwapcaplet.a
netsurf_library_require_dep libhubbub lib/libhubbub.a
netsurf_library_stage_source
# Build the HTML (libhubbub) binding only. The XML bindings would pull in
# expat or libxml2 for a code path no consumer calls; see package.toml.
netsurf_library_make_install \
    WITH_HUBBUB_BINDING=yes WITH_EXPAT_BINDING=no WITH_LIBXML_BINDING=no
netsurf_library_install
