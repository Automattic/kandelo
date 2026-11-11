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
    "$node_consumer/private-key-test-api.h" \
    "$node_consumer/per-context.cpp" \
    "$node_consumer/module-wrap.cpp" \
    "$node_consumer/module-wrap.h" \
    "$node_consumer/error-stack.cpp" \
    "$node_consumer/error-stack.h" \
    "$node_consumer/realm.cpp" \
    "$node_consumer/realm.h" \
    "$node_consumer/per-context.h" "$shell_sources/"
# Keep the portable registry's include names independent of Mozilla shell paths.
# Mozilla's checker treats js/src as the root of internal header include names.
cp "$node_import/native/builtin-source-registry.h" "$mozilla_source/js/src/"
python3 - "$node_import" "$mozilla_source/js/src/node-env-properties.h" <<'PY'
import hashlib, json, pathlib, sys
root, output = map(pathlib.Path, sys.argv[1:])
record = next(r for r in json.loads((root/'sources.json').read_bytes())['files']
              if r['path'] == 'src/env_properties.h')
source = (root/'upstream'/record['path']).read_bytes()
if len(source) != record['bytes'] or hashlib.sha256(source).hexdigest() != record['sha256']:
    raise ValueError('original Node env_properties.h identity mismatch')
output.write_bytes(source)
PY

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
