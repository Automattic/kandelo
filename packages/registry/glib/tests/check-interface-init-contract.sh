#!/usr/bin/env bash
set -euo pipefail
source_root=${1:?patched GLib source root is required}
before_root=${2:?GLib source root before the contract repair is required}
work_dir=${3:?private existing work directory is required}
test_dir=$(cd "$(dirname "$0")/interface-init" && pwd)
wasm_cc="${LLVM_PREFIX:?enter the declared dev shell}/bin/clang"
mkdir -p "$work_dir"

# Exercise the exact registration macros and thunk from the patched pinned
# source, rather than a second implementation of their dispatch decisions.
python3 - "$source_root" "$before_root" "$work_dir" <<'PY'
from pathlib import Path
import re, sys
source, before, work = map(Path, sys.argv[1:])
def macro(root, leaf, name):
    text = (root/'gobject'/leaf).read_text()
    start = text.index('#define '+name+'(')
    return text[start:text.index('\n}', start)+2]+'\n'
definitions = []
for leaf, name in [('gtype.h','G_IMPLEMENT_INTERFACE'),
                   ('gtypemodule.h','G_IMPLEMENT_INTERFACE_DYNAMIC')]:
    definitions += [macro(source,leaf,name), macro(source,leaf,name+'_UNARY')]
    definitions.append(macro(before,leaf,name).replace('#define '+name+'(', '#define OLD_'+name+'(', 1))
(work/'control-macros.h').write_text('\n'.join(definitions))
text = (source/'gobject/gtype.c').read_text()
start = text.index('void\ng_wasm_iface_init_thunk (')
thunk = text[start:text.index('\n}',start)+2]
(work/'thunk.c').write_text('#include "contract.h"\n'+thunk+'\n')
PY

for language in c c++; do
for optimization in 0 2; do
  objects=()
  for unit in callbacks registrations invoke; do
    object="$work_dir/$unit-$language-O$optimization.o"
    "$wasm_cc" -x "$language" --target=wasm32-unknown-unknown -O"$optimization" -nostdlib \
      -I"$test_dir" -I"$work_dir" -c "$test_dir/$unit.c" -o "$object"
    objects+=("$object")
  done
  "$wasm_cc" -x "$language" --target=wasm32-unknown-unknown -O"$optimization" -nostdlib \
    -I"$test_dir" -c "$work_dir/thunk.c" -o "$work_dir/thunk-$language-O$optimization.o"
  wasm="$work_dir/interface-init-$language-O$optimization.wasm"
  "$LLVM_PREFIX/bin/wasm-ld" --no-entry --export=run_case --export=calls \
    "${objects[@]}" "$work_dir/thunk-$language-O$optimization.o" -o "$wasm"
  echo "Wasm32 $language -O$optimization:"
  node "$test_dir/run.mjs" "$wasm"
done
done

if pkg-config --exists gobject-2.0; then
  clang -O2 -I"$test_dir" -c "$work_dir/thunk.c" -o "$work_dir/native-thunk.o"
  # Intentional pkg-config word splitting: these are declared native flags.
  clang -O2 -I"$work_dir" $(pkg-config --cflags gobject-2.0) \
    "$test_dir/native-gobject.c" "$work_dir/native-thunk.o" \
    $(pkg-config --libs gobject-2.0) -o "$work_dir/native-gobject"
  "$work_dir/native-gobject"
else
  echo "native GObject control not run: gobject-2.0 development package unavailable"
fi
