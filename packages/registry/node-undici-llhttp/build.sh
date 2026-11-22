#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
source "$root/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
out="$KANDELO_PACKAGE_OUT_DIR"
source "$root/sdk/activate.sh"
kandelo_package_stage_source_dependency node-core-source "$work/node-source" "$work"
src="$work/node-source/deps/undici/src/deps/llhttp"
python3 "$here/namespace-prefix.py" "$src" "$work/namespace.h"
mkdir -p "$work/objects" "$out/lib" "$out/include" "$out/share/kandelo/undici-llhttp" "$out/share/licenses/node-undici-llhttp"
objects=()
for unit in api http llhttp; do
  object="$work/objects/$unit.o"
  # Original Undici parser compiler settings; PIC replaces reactor linkage for
  # the reviewed native-library boundary. Do not substitute Node HTTP's parser.
  wasm32posix-cc -Ofast -fno-exceptions -fvisibility=hidden -fPIC \
    -include "$work/namespace.h" -I "$src/include" -c "$src/src/$unit.c" -o "$object"
  objects+=("$object")
done
wasm32posix-cc -O2 -fvisibility=hidden -fPIC -include "$work/namespace.h" \
  -I "$src/include" -I "$here" -c "$here/provider.c" -o "$work/objects/provider.o"
wasm32posix-cc -shared -Wl,--no-export-dynamic \
  -Wl,--export=kandelo_undici_llhttp_get_api_v1 "${objects[@]}" "$work/objects/provider.o" \
  -o "$work/libnode-undici-llhttp.raw.so"
node "$here/native-imports.mjs" "$work/libnode-undici-llhttp.raw.so" "$work/native-imports.json"
"$root/scripts/run-wasm-fork-instrument.sh" "$work/libnode-undici-llhttp.raw.so" -o "$work/libnode-undici-llhttp.so"
(cd "$root" && cargo xtask stamp-abi-contract "$work/libnode-undici-llhttp.so")
install -m644 "$work/libnode-undici-llhttp.so" "$out/lib/"
install -m644 "$here/kandelo_undici_llhttp.h" "$out/include/"
install -m644 "$work/native-imports.json" "$out/share/kandelo/undici-llhttp/"
install -m644 "$work/node-source/LICENSE" "$out/share/licenses/node-undici-llhttp/LICENSE.node"
python3 - "$src" "$out/share/kandelo/undici-llhttp/SOURCE.json" <<'PYRECEIPT'
from pathlib import Path
import hashlib,json,sys
p=Path(sys.argv[1]);header=(p/'include/llhttp.h').read_text()
for name,version in [('MAJOR',9),('MINOR',3),('PATCH',1)]:
    assert f'#define LLHTTP_VERSION_{name} {version}' in header
files=[p/'include/llhttp.h',*sorted((p/'src').glob('*.c'))]
Path(sys.argv[2]).write_text(json.dumps({'nodeVersion':'26.13.0','llhttpVersion':'9.3.1','purpose':'Temporary native version of original Undici Wasm helper','algorithmEdits':False,'originalSources':[{'path':str(f.relative_to(p)),'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in files]},indent=2)+'\n')
PYRECEIPT
