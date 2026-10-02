#!/usr/bin/env bash
# Compile the musl libc and libc++/libc++abi sources that quickshell links,
# with the KandeloCallTypes plugin, into scratch. Never writes into libc/musl.
# Run under scripts/dev-shell.sh from the repo root.
set -uo pipefail
ROOT=$PWD
OUT=$ROOT/.context/ir/plugin-runtime
P=$ROOT/.context/calltypes-plugin/KandeloCallTypes.dylib
PF="-Xclang -fsanitize=cfi-icall -Xclang -fsanitize-trap=cfi-icall -Xclang -flto-unit -Xclang -fwhole-program-vtables -Xclang -load -Xclang $P -fpass-plugin=$P"
mkdir -p "$OUT/musl" "$OUT/cxx" "$OUT/gen/include/bits" "$OUT/gen/internal"
cp "$ROOT/sysroot/include/bits/alltypes.h" "$ROOT/sysroot/include/bits/syscall.h" "$OUT/gen/include/bits/"
echo '#define VERSION "kandelo"' > "$OUT/gen/internal/version.h"
LINKED=$ROOT/.context/ir/linked-members.txt
# musl: dry-run commands, retargeted to wasm32 and scratch outputs.
(cd "$ROOT/libc/musl" && make -n -B lib/libc.a 2>/dev/null) | grep -E " -c -o obj/src/" > "$OUT/musl.cmds"
python3 - "$OUT" "$LINKED" "$PF" <<'PY' > "$OUT/musl.jobs"
import sys, shlex, os
out, linked, pf = sys.argv[1], set(open(sys.argv[2]).read().split()), sys.argv[3]
for line in open(f"{out}/musl.cmds"):
    a = shlex.split(line)
    o = a[a.index("-o") + 1]
    if os.path.basename(o) not in linked: continue
    a[a.index("-o") + 1] = f"{out}/musl/{o.replace('/', '_')}"
    a = [x.replace("wasm64-unknown-unknown", "wasm32-unknown-unknown").replace("arch/wasm64posix", "arch/wasm32posix") for x in a]
    a = [f"-I{out}/gen/include" if x == "-Iobj/include" else f"-I{out}/gen/internal" if x == "-Iobj/src/internal" else x for x in a]
    dst = a[a.index("-o") + 1]
    print(shlex.join(a + shlex.split(pf) + ["-mllvm", f"-kandelo-calltypes-out={dst}.calltypes"]))
PY
echo "musl jobs: $(wc -l < "$OUT/musl.jobs")"
(cd "$ROOT/libc/musl" && xargs -P 16 -I{} sh -c '{} >/dev/null 2>&1 || echo FAIL' < "$OUT/musl.jobs") | sort | uniq -c
# libc++ and libc++abi sources.
SRC=$WASM_POSIX_LLVM_LIBCXX_SOURCE
export WASM_POSIX_SYSROOT=$ROOT/.context/qs-sysroot
ls "$SRC"/libcxxabi/src/*.cpp "$SRC"/libcxx/src/*.cpp > "$OUT/cxx.files"
fail=0; n=0
while read -r f; do
  n=$((n+1)); dst="$OUT/cxx/$(echo "$f" | sed 's|.*/\(libcxx[a-z]*\)/src/|\1_|').o"
  echo "wasm32posix-c++ -O2 -fexceptions -std=c++23 -D_LIBCXXABI_BUILDING_LIBRARY -D_LIBCPP_BUILDING_LIBRARY -DLIBCXX_BUILDING_LIBCXXABI -I$SRC/libcxxabi/include -I$SRC/libcxx/src -I$SRC/libcxxabi/src $PF -mllvm -kandelo-calltypes-out=$dst.calltypes -c $f -o $dst"
done < "$OUT/cxx.files" > "$OUT/cxx.jobs"
echo "cxx jobs: $(wc -l < "$OUT/cxx.jobs")"
xargs -P 16 -I{} sh -c '{} >/dev/null 2>&1 || echo FAIL' < "$OUT/cxx.jobs" | sort | uniq -c
ls "$OUT"/musl/*.calltypes "$OUT"/cxx/*.calltypes 2>/dev/null | wc -l
# Kandelo libc glue: the SDK compiles these into every executable at link.
mkdir -p "$OUT/glue"
for g in channel_syscall compiler_rt cxxrt; do
  wasm32posix-cc -Os -I"$ROOT/libc/glue" $PF -mllvm -kandelo-calltypes-out="$OUT/glue/$g.o.calltypes" \
    -c "$ROOT/libc/glue/$g.c" -o "$OUT/glue/$g.o" >/dev/null 2>&1 || echo "FAIL glue $g"
done
ls "$OUT"/glue/*.calltypes 2>/dev/null | wc -l
