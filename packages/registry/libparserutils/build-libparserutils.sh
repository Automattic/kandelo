#!/usr/bin/env bash
#
# Build libparserutils (libparserutils.a) for wasm32-posix-kernel with the
# NetSurf build system. See scripts/netsurf-library-build.sh for how and why.
#
# The build runs upstream's build/make-aliases.pl (Perl, from the dev shell)
# to generate the charset alias table from build/Aliases.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../../scripts/netsurf-library-build.sh"

netsurf_library_setup "$SCRIPT_DIR" libparserutils
netsurf_library_stage_source
netsurf_library_make_install
netsurf_library_install
