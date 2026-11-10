#!/usr/bin/env bash
# Stage immutable Node sources/native compiler in the recipe-owned Mozilla tree.
# This helper prepares build inputs; it neither activates nor executes Node JS.
set -euo pipefail

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    echo "usage: prepare-build.sh <repository> <Mozilla-source> <object-dir> [host-SDK]" >&2
    exit 2
fi
repo_root="$1"
mozilla_source="$2"
object_dir="$3"
host_sdk="${4:-}"
node_import="$repo_root/third_party/nodejs"
node_consumer="$repo_root/packages/registry/spidermonkey/node-upstream"
shell_sources="$mozilla_source/js/src/shell/node-upstream"
node_objects="$object_dir/node-upstream"

mkdir -p "$shell_sources" "$node_objects"
cp "$node_import/native/builtin-source-registry.cpp" \
    "$node_consumer/builtin-compiler.cpp" \
    "$node_consumer/builtin-compiler.h" \
    "$node_consumer/private-key-test-api.cpp" \
    "$node_consumer/private-key-test-api.h" "$shell_sources/"
# Keep the portable registry's include names independent of Mozilla shell paths.
# Mozilla's checker treats js/src as the root of internal header include names.
cp "$node_import/native/builtin-source-registry.h" "$mozilla_source/js/src/"

host_sdk_flags=()
if [ -n "$host_sdk" ]; then
    if [ ! -d "$host_sdk" ]; then
        echo "ERROR: Node metadata host SDK directory does not exist: $host_sdk" >&2
        exit 1
    fi
    host_sdk_flags=(-isysroot "$host_sdk")
fi
# This tool consumes logical names/argument lists from the original Node C++
# policy; it does not infer target layouts, host state or guest capabilities.
clang++ -std=c++20 "${host_sdk_flags[@]}" \
    -I "$node_import/upstream/src" \
    "$repo_root/scripts/nodejs-builtin-metadata.cpp" \
    "$node_import/upstream/src/builtin_info.cc" \
    -o "$node_objects/nodejs-builtin-metadata"
python3 "$repo_root/scripts/generate-nodejs-source-registry.py" \
    --manifest "$node_import/sources.json" \
    --metadata-tool "$node_objects/nodejs-builtin-metadata" \
    --output "$mozilla_source/js/src/node-source-registry.generated.h"
