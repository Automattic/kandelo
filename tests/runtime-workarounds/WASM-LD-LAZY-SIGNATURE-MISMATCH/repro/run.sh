#!/usr/bin/env bash
# Self-judging reproduction: wasm-ld links an invalid module when a lazy
# definition (an archive member or a --start-lib object) comes before an
# undefined reference to the same function with a different signature.
#
#   foo.c   int foo(int a, int b)            (the definition)
#   main.c  extern int foo(); ... foo()      (an unprototyped call: () -> i32)
#
# Linked with the definition after main.o (direct object, archive or
# --start-lib), wasm-ld warns "function signature mismatch" and calls a
# trapping stub: a valid module. Linked with the archive or --start-lib
# object before main.o, it gives no warning and emits a direct call to
# foo with no arguments, which no engine accepts.
#
# Usage (from any directory): bash run.sh
# CLANG, WASM_LD, LLVM_AR and NODE select the tools (default: on PATH).
# The last line is REPRO-VERDICT {"verdict": ..., "details": ...}.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
clang="${CLANG:-clang}"
wasm_ld="${WASM_LD:-wasm-ld}"
llvm_ar="${LLVM_AR:-llvm-ar}"
node="${NODE:-node}"

verdict() {
  local details="$2"
  details="${details//\\/\\\\}"
  details="${details//\"/\\\"}"
  details="${details//$'\n'/\\n}"
  printf 'REPRO-VERDICT {"verdict": "%s", "details": "%s"}\n' "$1" "$details"
  exit 0
}

version="$("$wasm_ld" --version 2>/dev/null | head -n 1)"
[ -n "$version" ] || verdict inconclusive "cannot run $wasm_ld"
"$node" --version >/dev/null 2>&1 || verdict inconclusive "cannot run $node to validate modules"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
printf 'int foo(int a, int b) { return a + b; }\n' > foo.c
printf 'extern int foo();\nint _start(void) { return foo(); }\n' > main.c
# NIX_HARDENING_ENABLE: a Nix-wrapped clang adds host hardening flags that
# the wasm32 target rejects. It has no effect on other clangs.
NIX_HARDENING_ENABLE= "$clang" --target=wasm32-unknown-unknown -std=gnu17 -O0 -c foo.c -o foo.o 2>/dev/null &&
  NIX_HARDENING_ENABLE= "$clang" --target=wasm32-unknown-unknown -std=gnu17 -O0 -c main.c -o main.o 2>/dev/null ||
  verdict inconclusive "$version: cannot compile the inputs with $clang"
"$llvm_ar" rcs libfoo.a foo.o || verdict inconclusive "cannot run $llvm_ar"

valid() {
  "$node" -e 'try { new WebAssembly.Module(require("fs").readFileSync(process.argv[1])); console.log("valid") } catch (e) { console.log("invalid") }' "$1"
}

link() {
  local out="$1"
  shift
  "$wasm_ld" --no-entry --export=_start "$@" -o "$out" > /dev/null 2>&1 || {
    echo "link-failed"
    return
  }
  valid "$out"
}

control_object="$(link control-object.wasm main.o foo.o)"
control_archive="$(link control-archive.wasm main.o libfoo.a)"
control_lazy="$(link control-lazy.wasm main.o --start-lib foo.o --end-lib)"
lazy_first="$(link lazy-first.wasm --start-lib foo.o --end-lib main.o)"
archive_first="$(link archive-first.wasm libfoo.a main.o)"

controls="object=$control_object archive=$control_archive lazy-after=$control_lazy"
if [ "$control_object" != valid ] || [ "$control_archive" != valid ] || [ "$control_lazy" != valid ]; then
  verdict inconclusive "$version: controls did not all link valid modules ($controls)"
fi
if [ "$lazy_first" = invalid ] || [ "$archive_first" = invalid ]; then
  verdict reproduced "$version: lazy-first=$lazy_first archive-first=$archive_first; controls valid ($controls)"
fi
if [ "$lazy_first" = valid ] && [ "$archive_first" = valid ]; then
  verdict not-reproduced "$version: lazy-first and archive-first link valid modules; controls valid"
fi
verdict inconclusive "$version: lazy-first=$lazy_first archive-first=$archive_first"
