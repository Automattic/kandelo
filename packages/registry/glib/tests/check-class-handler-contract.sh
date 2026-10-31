#!/usr/bin/env bash
# Exact production-source admission + separate-TU Wasm ABI model; no package build.
set -euo pipefail
source_root=${1:?fully patched GLib source};before_root=${2:?source before new class-handler patch};work=${3:?private work directory}
: "${KANDELO_DEV_SHELL_TOOL_PATH:?declared shell required}"
test_dir="$(cd "$(dirname "$0")/class-handler" && pwd)"
mkdir -p "$work"
python3 - "$source_root" "$before_root" "$work" <<'PY'
from pathlib import Path
import json,hashlib,sys
source,before,work=map(Path,sys.argv[1:])
def function(root,leaf,signature):
 text=(root/'gobject'/leaf).read_text();start=text.index(signature);end=text.index('\n}',start)+2;return text[start:end]+'\n'
manifest={}
for side,root in [('before',before),('after',source)]:
 units={
  'api':function(root,'gsignal.c','guint\ng_signal_new_class_handler (')+function(root,'gsignal.c','void\ng_signal_override_class_handler ('),
  'marshal':function(root,'gmarshal.c','void\ng_cclosure_marshal_VOID__ENUM ('),
  'meta':'' if side=='before' else function(root,'gclosure.c','static void\ng_wasm_class_handler_meta_marshal (')+function(root,'gclosure.c','static void\ng_wasm_class_handler_meta_marshalv (')+function(root,'gclosure.c','GClosure *\n_g_cclosure_new_class_handler ('),
 }
 for unit,body in units.items():
  name=side+'-'+unit+'.c';text='#include "contract.h"\n'+body;(work/name).write_text(text);manifest[name]=hashlib.sha256(text.encode()).hexdigest()
(work/'source-admission.json').write_text(json.dumps({'scope':'Exact extracted API/meta/marshal source; explicit registry/GValue/ffi test doubles in model.c; not real GObject runtime proof','files':manifest},indent=2)+'\n')
PY
for optimization in 0 2; do
 for side in before after; do
  objects=()
  for unit in "$test_dir/model.c" "$test_dir/callbacks.c" "$work/$side-api.c" "$work/$side-marshal.c" "$work/$side-meta.c"; do
   object="$work/$side-O$optimization-$(basename "$unit").o"
   "$LLVM_PREFIX/bin/clang" --target=wasm32-unknown-unknown -O"$optimization" -nostdlib -I"$test_dir" -c "$unit" -o "$object"
   objects+=("$object")
  done
  "$LLVM_PREFIX/bin/wasm-ld" --no-entry --export=run_case "${objects[@]}" -o "$work/$side-O$optimization.wasm"
 done
 node "$test_dir/run.mjs" "$work/before-O$optimization.wasm" "$work/after-O$optimization.wasm"
done
if pkg-config --exists gobject-2.0; then
 clang -O2 $(pkg-config --cflags gobject-2.0) "$test_dir/native-gobject.c" $(pkg-config --libs gobject-2.0) -o "$work/native-gobject"
 "$work/native-gobject"
else
 echo 'Native actual GObject semantic control UNRUN: gobject-2.0 unavailable'
fi
