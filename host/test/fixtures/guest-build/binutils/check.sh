#!/bin/sh
# Runs inside the build image. Each step's output goes to a file the test
# reads, so a tool that exits 0 without doing its work is caught by what it
# wrote, not by its status.
set -eu

# patch applies a unified diff and changes the file it names.
patch -p1 < fix.diff > patch.out
grep -q 'return 2;' greet.c

# A hunk that does not match fails, and leaves the file alone.
if patch -p1 --dry-run < stale.diff > stale.out 2>&1; then
    echo "stale.diff applied" >&2
    exit 1
fi

cc -c greet.c -o greet.o
ar rcs libgreet.a greet.o
ar t libgreet.a > ar.out
ranlib libgreet.a
nm greet.o > nm.out
cc -o greet.wasm greet.o
objdump -h greet.wasm > objdump.out
llvm-readobj --sections greet.wasm > readobj.out
# No plain readelf: its ELF answers on Wasm are empty successes.
if command -v readelf >/dev/null; then
    echo "readelf is installed" >&2
    exit 1
fi
size greet.wasm > size.out
c++filt _ZN7kandelo5greetEv > cxxfilt.out
strings -n 5 greet.wasm > strings.out

# A stripped program still loads: strip keeps the sections Kandelo needs.
cp greet.wasm greet-stripped.wasm
strip greet-stripped.wasm
./greet-stripped.wasm > run.out
