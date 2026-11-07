#!/usr/bin/env bash
# Source from Go package recipes before collecting their static dependencies.
KANDELO_GO_STATIC_LIBRARY_FLAGS=()

kandelo_go_require_static_archives() {
    local prefix="$1"
    shift
    local archive
    for archive in "$@"; do
        if [ ! -f "$prefix/lib/$archive" ]; then
            echo "Go static dependency is missing: $prefix/lib/$archive" >&2
            return 1
        fi
    done
    # Keep declared dependency prefixes in Go's flags. A temporary symlink
    # directory changes cgo build IDs even when it names identical archives.
    KANDELO_GO_STATIC_LIBRARY_FLAGS+=("-L$prefix/lib")
}
