#!/usr/bin/env bash
# Create research build shims under $1 (run under scripts/dev-shell.sh):
#   $1/llvm/        a WASM_POSIX_LLVM_DIR: every LLVM tool symlinked, plus
#                   clang/clang++ that add the KandeloCallTypes plugin to wasm
#                   compile-only invocations, and wasm-ld that keeps a copy of
#                   each executable link (before clang's post-link wasm-opt)
#                   with a link map.
#   $1/instrument   a WASM_POSIX_FORK_INSTRUMENT wrapper that keeps the
#                   input and output of every instrumentation.
# Captures go to $1/side, $1/links and $1/instr. The shipped code is not
# changed: the plugin leaves object code identical, -Map only adds a file,
# and the copies are taken after the real tools finish.
set -euo pipefail
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
PLUGIN=${FPR_PLUGIN:?set FPR_PLUGIN to KandeloCallTypes.dylib}
: "${LLVM_BIN:?run under scripts/dev-shell.sh}"
REAL_INSTR=${FPR_REAL_INSTRUMENT:-$(git rev-parse --show-toplevel)/tools/bin/wasm-fork-instrument}
SHA256=$(command -v sha256sum)
PY=$(command -v python3)
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT/llvm" "$OUT/side" "$OUT/links" "$OUT/instr"
for t in "$LLVM_BIN"/*; do ln -sf "$t" "$OUT/llvm/$(basename "$t")"; done
for cc in clang clang++; do
  rm -f "$OUT/llvm/$cc"
  cat > "$OUT/llvm/$cc" <<SH
#!/bin/sh
REAL="$LLVM_BIN/$cc"
compile=0; wasm=0; out=""; prev=""; nsrc=0
for a in "\$@"; do
  case "\$a" in -c) compile=1 ;; --target=wasm*|-target) wasm=1 ;; esac
  [ "\$prev" = "-o" ] && out="\$a"
  case "\$prev" in -o|-MF|-MT|-MQ|-x|-include|-I|-isystem|-iquote|-idirafter|-imacros|-Xclang|-mllvm|-target|-arch|-isysroot|--sysroot) ;;
    *) case "\$a" in -*) ;; *.c|*.cc|*.cpp|*.cxx|*.C|*.c++|*.m|*.mm) nsrc=\$((nsrc+1)); src="\$a" ;; esac ;;
  esac
  prev="\$a"
done
# cc -c file.c without -o writes file.o in the current directory.
if [ -z "\$out" ] && [ \$compile = 1 ] && [ \$nsrc = 1 ]; then out="\$(basename "\${src%.*}").o"; fi
case "\$out" in *conftest*|*CMakeScratch*|*CMakeTmp*|*TryCompile*|/dev/null|"") compile=0 ;; esac
if [ \$compile = 1 ] && [ \$wasm = 1 ]; then
  # Side files are named by the SHA-256 of the object they describe, so the
  # analysis can bind archive members and loose objects to them exactly.
  tmp=\$(mktemp "$OUT/side/.tmp.XXXXXX")
  "\$REAL" "\$@" -Xclang -fsanitize=cfi-icall,cfi-vcall -Xclang -fsanitize-trap=cfi-icall,cfi-vcall -Xclang -flto-unit -Xclang -load -Xclang "$PLUGIN" -fpass-plugin="$PLUGIN" -mllvm -kandelo-calltypes-out="\$tmp"
  rc=\$?
  if [ \$rc != 0 ] || [ ! -f "\$out" ]; then rm -f "\$tmp"; exit \$rc; fi
  sha=\$("$SHA256" "\$out" | cut -d' ' -f1)
  mv -f "\$tmp" "$OUT/side/\$sha.calltypes"
  abs=\$(cd "\$(dirname "\$out")" 2>/dev/null && pwd)/\$(basename "\$out")
  printf '%s\\t%s\\n' "\$sha" "\$abs" >> "$OUT/side/index.tsv"
  exit 0
fi
if [ \$compile = 1 ] && [ \$wasm = 1 ] && [ \$nsrc -gt 1 ] && [ -z "\$out" ]; then
  echo "kandelo research shim: multi-source -c without -o is not captured" >&2
fi
exec "\$REAL" "\$@"
SH
  chmod +x "$OUT/llvm/$cc"
done
rm -f "$OUT/llvm/wasm-ld"
cat > "$OUT/llvm/wasm-ld" <<SH
#!/bin/sh
REAL="$LLVM_BIN/wasm-ld"
out=""; prev=""; keep=1
for a in "\$@"; do
  case "\$a" in -r|--relocatable|--shared|-shared|--version|-v|--help) keep=0 ;; esac
  [ "\$prev" = "-o" ] && out="\$a"
  prev="\$a"
done
case "\$out" in *conftest*|*CMakeScratch*|*CMakeTmp*|*TryCompile*|/dev/null|"") keep=0 ;; esac
if [ \$keep = 0 ]; then exec "\$REAL" "\$@"; fi
id="\$(basename "\$out")-\$\$-\$(date +%s)"
"\$REAL" "\$@" -Map="$OUT/links/\$id.map" || exit \$?
cp "\$out" "$OUT/links/\$id.wasm"
{ pwd; printf '%s\n' "\$@"; } > "$OUT/links/\$id.args"
# Loose objects disappear with the build tree: hash them now.
"$PY" "$HERE/map-inputs.py" "$OUT/links/\$id.map" > "$OUT/links/\$id.inputs"
SH
chmod +x "$OUT/llvm/wasm-ld"
cat > "$OUT/instrument" <<SH
#!/bin/sh
# Keep the input and output of each real instrumentation.
REAL="$REAL_INSTR"
in=""; out=""; prev=""; mode=instrument
for a in "\$@"; do
  case "\$a" in --discover-only|--contract-inventory|--artifact-identity|--fork-capability-hex|--linked-frame-descriptor-hex|--reserved-env-imports) mode=query ;; esac
  case "\$prev" in -o|--output) out="\$a" ;; esac
  case "\$a" in -*) ;; *) [ -z "\$in" ] && [ "\$prev" != "-o" ] && [ "\$prev" != "--output" ] && [ "\$prev" != "--entry" ] && in="\$a" ;; esac
  prev="\$a"
done
if [ \$mode = query ] || [ -z "\$out" ]; then exec "\$REAL" "\$@"; fi
id="\$(basename "\$in" .wasm)-\$\$-\$(date +%s)"
cp "\$in" "$OUT/instr/\$id.in.wasm"
"\$REAL" "\$@" || exit \$?
cp "\$out" "$OUT/instr/\$id.out.wasm"
SH
chmod +x "$OUT/instrument"
echo "WASM_POSIX_LLVM_DIR=$OUT/llvm WASM_POSIX_FORK_INSTRUMENT=$OUT/instrument"
