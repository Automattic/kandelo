#!/usr/bin/env bash
# Test actual upstream container allocation/free in a native release build.
# Pass a staged source directory (with package patches applied) and private work.
set -euo pipefail
source_dir=${1:?staged json-c source directory is required}
work_dir=${2:?owned work directory is required}
test_dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$work_dir"
work_dir=$(cd "$work_dir" && pwd)
cmake -S "$source_dir" -B "$work_dir/build" \
    -DCMAKE_C_COMPILER="$(command -v clang)" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON -DBUILD_APPS=OFF \
    -DBUILD_TESTING=OFF -DDISABLE_EXTRA_LIBS=ON
cmake --build "$work_dir/build" --parallel 4
# Only json_object.c allocations are counted; other source files and libc
# retain their ordinary allocators. The actual release implementation and
# public json_object_put API must retire every object created by the fixture.
clang -O2 -DNDEBUG -I"$source_dir" -I"$work_dir/build" \
    -Dmalloc=repro_malloc -Dfree=repro_free \
    -c "$source_dir/json_object.c" -o "$work_dir/json_object.c.o"
cp "$work_dir/build/libjson-c.a" "$work_dir/libjson-c.a"
llvm-ar r "$work_dir/libjson-c.a" "$work_dir/json_object.c.o"
clang -O2 -I"$source_dir" -I"$work_dir/build" \
    "$test_dir/release-free.c" "$work_dir/libjson-c.a" -o "$work_dir/release-free"
"$work_dir/release-free"
