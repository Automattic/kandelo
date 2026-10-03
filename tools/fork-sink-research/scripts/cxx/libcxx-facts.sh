#!/usr/bin/env bash
# Type facts (plugin v4) for the libc++/libc++abi members a link uses,
# compiled facts-only (-emit-llvm) with the libcxx recipe's flags.
set -uo pipefail
D=$PWD/.context/fpr2; PL=$D/KandeloCallTypes.dylib
R=/Users/brandon/conductor/workspaces/kandelo/ljubljana/.context/fpr/runtime/repo/packages/registry/libcxx
REAL=/nix/store/lyq5q6lw9bbayni7gcchg4vgr1qs8nq4-llvm-21.1.7-tree/bin/clang
mkdir -p $D/libcxx-side
for inputs in "$@"; do
  grep -o 'lib/libc++[a-z]*\.a([^)]*)' $inputs
done | sort -u | while read m; do
  ar=$(echo "$m" | sed 's|lib/\(.*\.a\)(.*|\1|'); mem=$(echo "$m" | sed 's|.*(\(.*\))|\1|')
  src=${mem%.obj}
  case $ar in libc++abi.a) tgt=libcxxabi/src/CMakeFiles/cxxabi_static.dir; base=libcxxabi/src ;; *) tgt=libcxx/src/CMakeFiles/cxx_static.dir; base=libcxx/src ;; esac
  path=$(cd $R/llvm-source-wasm32 && find $base libunwind/src -name "$src" 2>/dev/null | head -1)
  [ -n "$path" ] || { echo "no source for $m"; continue; }
  FM=$R/build-wasm32/$tgt/flags.make
  case $src in *.c) lang=C ;; *) lang=CXX ;; esac
  case $path in libunwind/*) FM=$(find $R/build-wasm32/libunwind -name flags.make | head -1) ;; esac
  DEF=$(sed -n "s/^${lang}_DEFINES = //p" $FM); INC=$(sed -n "s/^${lang}_INCLUDES = //p" $FM); FL=$(sed -n "s/^${lang}_FLAGS = //p" $FM)
  out=$D/libcxx-side/$ar-$mem.calltypes
  eval "$REAL $DEF $INC $FL" -Xclang -fsanitize=cfi-icall -Xclang -fsanitize-trap=cfi-icall -Xclang -flto-unit -Xclang -fwhole-program-vtables -Xclang -load -Xclang $PL -Xclang -add-plugin -Xclang kandelo-fncasts -fpass-plugin=$PL -mllvm -kandelo-calltypes-out=$out -emit-llvm -c $R/llvm-source-wasm32/$path -o /dev/null > $out.log 2>&1
  if [ ! -s $out ]; then
    # Retry with libc++'s own flags plus libunwind/libcxxabi includes
    # (cxa_default_handlers needs C++20; libunwind needs its headers).
    FM2=$R/build-wasm32/libcxx/src/CMakeFiles/cxx_static.dir/flags.make
    DEF=$(sed -n "s/^CXX_DEFINES = //p" $FM2); INC=$(sed -n "s/^CXX_INCLUDES = //p" $FM2); FL=$(sed -n "s/^${lang}_FLAGS = //p" $FM2)
    eval "$REAL $DEF $INC -I$R/llvm-source-wasm32/libunwind/include -I$R/llvm-source-wasm32/libcxxabi/src -D_LIBCXXABI_BUILDING_LIBRARY $FL" -Xclang -fsanitize=cfi-icall -Xclang -fsanitize-trap=cfi-icall -Xclang -flto-unit -Xclang -fwhole-program-vtables -Xclang -load -Xclang $PL -Xclang -add-plugin -Xclang kandelo-fncasts -fpass-plugin=$PL -mllvm -kandelo-calltypes-out=$out -emit-llvm -c $R/llvm-source-wasm32/$path -o /dev/null >> $out.log 2>&1
  fi
  if [ -s $out ]; then printf '%s\t%s\t%s\n' $ar $mem $out; else echo "FAILED $m (see $out.log)" >&2; fi
done
