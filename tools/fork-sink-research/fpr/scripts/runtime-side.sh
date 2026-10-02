#!/usr/bin/env bash
# Side files for the parts of a link that no package build compiles: musl
# (the sysroot's libc.a and crt objects) and the SDK's link-time glue.
# Run under scripts/dev-shell.sh from the repo root.
#   $1  research shim directory from make-shims.sh (side files land in
#       $1/side, named by object SHA-256)
#   $2  output directory: a scratch copy of libc/ + scripts/ in which
#       scripts/build-musl.sh runs with the shim compiler, and aliases.tsv
# The worktree's libc/musl tree and sysroot are never written. The scratch
# objects are compiled with the plugin, so they need not be byte-identical
# to the sysroot's; aliases.tsv binds sysroot members to them by name
# (archive, member) and the analysis unions duplicate member names.
set -uo pipefail
ROOT=$(git rev-parse --show-toplevel)
SHIMS=$(cd "$1" && pwd)
OUT=$(mkdir -p "$2" && cd "$2" && pwd)
P=$(grep -o '\-fpass-plugin="[^"]*"' "$SHIMS/llvm/clang" | head -1 | cut -d'"' -f2)
rm -rf "$OUT/repo" && mkdir -p "$OUT/repo" "$OUT/glue"
cp -c -R "$ROOT/libc" "$OUT/repo/libc" 2>/dev/null || cp -R "$ROOT/libc" "$OUT/repo/libc"
cp -R "$ROOT/scripts" "$OUT/repo/scripts"
rm -rf "$OUT/repo/libc/musl/obj"
LLVM_BIN="$SHIMS/llvm" bash "$OUT/repo/scripts/build-musl.sh" > "$OUT/build-musl.log" 2>&1
echo "build-musl exit=$? (log $OUT/build-musl.log)"
: > "$OUT/aliases.tsv"
while IFS= read -r o; do
  sha=$(sha256sum "$o" | cut -d' ' -f1)
  [ -f "$SHIMS/side/$sha.calltypes" ] || { echo "no side file for $o" >&2; continue; }
  case "$o" in
    */obj/crt/*|*/lib/crt1.o|*/lib/Scrt1.o|*/lib/crti.o|*/lib/crtn.o) printf 'loose\t%s\t%s\n' "$(basename "$o")" "$sha" ;;
    *) printf 'libc.a\t%s\t%s\n' "$(basename "$o")" "$sha" ;;
  esac
done < <(find "$OUT/repo/libc/musl/obj/src" "$OUT/repo/libc/musl/obj/crt" -name '*.o'; ls "$OUT"/repo/sysroot/lib/{__main_void,wasm_setjmp_rt,sigsetjmp_helpers}.o 2>/dev/null) >> "$OUT/aliases.tsv"
PF="-Xclang -fsanitize=cfi-icall -Xclang -fsanitize-trap=cfi-icall -Xclang -flto-unit -Xclang -fwhole-program-vtables -Xclang -load -Xclang $P -Xclang -add-plugin -Xclang kandelo-fncasts -fpass-plugin=$P"
for g in channel_syscall compiler_rt cxxrt dlopen; do
  side="$OUT/glue/$g.calltypes"
  wasm32posix-cc -c $PF -mllvm -kandelo-calltypes-out="$side" \
    "$ROOT/libc/glue/$g.c" -o "$OUT/glue/$g.o" >/dev/null 2>&1 || { echo "FAIL glue $g"; continue; }
  printf 'glue\t%s\t%s\n' "$g" "$side" >> "$OUT/aliases.tsv"
done
cut -f1 "$OUT/aliases.tsv" | sort | uniq -c
