#!/usr/bin/env bash
# SPIKE: build the prebuilt fork and large-library fixtures used by
# host/test/spike-shared-lib-exec.test.ts. Run inside scripts/dev-shell.sh.
# Output: <repo>/.scratch/spike-e2e (gitignored).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SRC/../../../.." && pwd)"
OUT="$REPO/.scratch/spike-e2e"
CC="$REPO/sdk/bin/wasm32posix-cc"
FI="$REPO/scripts/run-wasm-fork-instrument.sh"
mkdir -p "$OUT/forklib" "$OUT/forklib-a" "$OUT/biglib"
cd "$OUT"

# A: library without fork; the executable forks after startup loading.
"$CC" -shared -fPIC -O2 -DNO_LIB_FORK "$SRC/foo.c" -o forklib-a/libfoo.so
bash "$FI" forklib-a/libfoo.so -o forklib-a/libfoo.so
"$CC" -O2 -fPIC -DNO_LIB_FORK -c "$SRC/forkmain.c" -o forkmain-a.o
"$CC" -O2 forkmain-a.o -Lforklib-a -lfoo -Wl,-rpath,"$OUT/forklib-a" -o forkmain-a.wasm
bash "$FI" forkmain-a.wasm -o forkmain-a.wasm

# B: the library calls fork; the executable calls it through a direct import.
"$CC" -shared -fPIC -O2 "$SRC/foo.c" -o forklib/libfoo.so
bash "$FI" forklib/libfoo.so -o forklib/libfoo.so
"$CC" -O2 -fPIC -c "$SRC/forkmain.c" -o forkmain.o
"$CC" -O2 forkmain.o -Lforklib -lfoo -Wl,-rpath,"$OUT/forklib" -o forkmain-b.wasm
bash "$FI" --side-modules=assume-all-entries-fork-returning forkmain-b.wasm -o forkmain-b.wasm

# C: as B, through a function pointer (call_indirect).
"$CC" -O2 -fPIC -DVIA_POINTER -c "$SRC/forkmain.c" -o forkmain-c.o
"$CC" -O2 forkmain-c.o -Lforklib -lfoo -Wl,-rpath,"$OUT/forklib" -o forkmain-c.wasm
bash "$FI" --side-modules=assume-all-entries-fork-returning forkmain-c.wasm -o forkmain-c.wasm

# Large synthetic library (4000 functions, ~1 MB) and per-call benchmark.
python3 "$SRC/gen-big.py" . 4000
"$CC" -shared -fPIC -O2 big.c -o biglib/libbig.so
"$CC" -O2 -fPIC -c bigmain.c -o bigmain.o
"$CC" -O2 bigmain.o -Lbiglib -lbig -Wl,-rpath,"$OUT/biglib" -o bigmain-dyn.wasm
"$CC" -O2 bigmain.o big.c -o bigmain-static.wasm
ls -la forkmain-a.wasm forkmain-b.wasm forkmain-c.wasm biglib/libbig.so bigmain-dyn.wasm bigmain-static.wasm
