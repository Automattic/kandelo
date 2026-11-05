#!/usr/bin/env bash
# Native-only dependency control. Run through the repository dev shell.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"
export PATH="$KANDELO_DEV_SHELL_TOOL_PATH"
node_source="${KANDELO_NODE_SOURCE_ROOT:-$repo/.context/nodejs-lts-cache-v2/node-v26.13.0}"
node_archive="${KANDELO_NODE_SOURCE_ARCHIVE:-$repo/.context/nodejs-lts-cache-v2/node-v26.13.0.tar.gz}"
output="${KANDELO_ENVIRONMENT_NATIVE_HELPER:-$repo/.context/node26-environment-native/owner.node}"
# Header identities must describe the exact audited target, not ambient headers.
python3 - "$node_source" "$node_archive" <<'PY'
from pathlib import Path
import hashlib,json,sys,tarfile
source,archive=map(Path,sys.argv[1:]);target=json.loads(Path('packages/registry/node-compat/target.json').read_text())
if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest()!=target['source']['sha256']:
    raise SystemExit('Prepare the exact audited Node source archive before building native controls')
prefix='node-v'+target['version']+'/'
with tarfile.open(archive) as tar:
    for member in tar:
        if not member.isfile() or not member.name.startswith(prefix):continue
        rel=member.name[len(prefix):]
        if not (rel.startswith('src/') or rel.startswith('deps/v8/include/')) or not rel.endswith(('.h','.inc')):continue
        path=source/rel
        if not path.is_file() or hashlib.sha256(path.read_bytes()).digest()!=hashlib.sha256(tar.extractfile(member).read()).digest():
            raise SystemExit('Native control header identity mismatch: '+rel)
PY
mkdir -p "$(dirname "$output")"
native_flags=()
if [[ "$(uname -s)" == Darwin ]]; then native_flags=(-undefined dynamic_lookup); fi
c++ -std=c++20 -shared -fPIC "${native_flags[@]}" \
  -I "$node_source/src" -I "$node_source/deps/v8/include" \
  host/test/fixtures/node-environment-object-addon.cpp -o "$output"
printf 'Native environment control: %s\n' "$output"
