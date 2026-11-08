#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
out="${WASM_POSIX_DEP_OUT_DIR:?resolve rust-profiler-runtime through the package resolver}"
source "$repo/sdk/activate.sh"

# An internal Rust runtime must have the compiler's actual metadata version.
# rust-src is supplied by the same pinned, immutable dev-shell toolchain.
expected_commit=ca9a134e0985765ded9cfdde4030a5df4db7e2bd
actual_commit="$(rustc -vV | sed -n 's/^commit-hash: //p')"
if [ "$actual_commit" != "$expected_commit" ]; then
  echo "rust-profiler-runtime requires the SDK compiler $expected_commit; found $actual_commit" >&2
  exit 1
fi
rust_source="$(rustc --print sysroot)/lib/rustlib/src/rust/library/profiler_builtins"
test -f "$rust_source/src/lib.rs"
src="$work/llvm-source"
kandelo_package_stage_primary_source rust-profiler-runtime "$src" "$work"
profile="$src/compiler-rt/lib/profile"
mkdir -p "$work/objects" "$out/lib" "$out/lib/rustlib/wasm32-unknown-kandelo-std/lib"

# Use the pinned Rust runtime's source list, including the platform files
# whose own preprocessor guards select Wasm. Do not impersonate Linux/WASI.
python3 - "$rust_source/build.rs" "$work/sources.txt" <<'PY'
from pathlib import Path
import re, sys
text = Path(sys.argv[1]).read_text()
body = text.split('let profile_sources = vec![', 1)[1].split('];', 1)[0]
files = re.findall(r'^\s*"([A-Za-z0-9_]+\.(?:c|cpp))",', body, re.MULTILINE)
if not files or len(files) > 64 or len(files) != len(set(files)):
    raise SystemExit('unexpected pinned profiler source list')
Path(sys.argv[2]).write_text('\n'.join(files) + '\n')
PY
flags=(
  -O2 -fno-builtin -fomit-frame-pointer -fvisibility=hidden
  -DCOMPILER_RT_HAS_UNAME=1 -DCOMPILER_RT_HAS_FCNTL_LCK=1
  -DCOMPILER_RT_HAS_ATOMICS=1
  -I"$profile" -I"$src/compiler-rt/include" -I"$src/compiler-rt/lib"
  "-ffile-prefix-map=$repo=/kandelo/source"
  "-ffile-prefix-map=$work=/kandelo/build/rust-profiler-runtime"
)
while IFS= read -r file; do
  object="$work/objects/$file.o"
  if [[ "$file" == *.cpp ]]; then
    wasm32posix-c++ "${flags[@]}" -fno-exceptions -fno-rtti -c "$profile/$file" -o "$object"
  else
    wasm32posix-cc "${flags[@]}" -c "$profile/$file" -o "$object"
  fi
done < "$work/sources.txt"
archive="$out/lib/libclang_rt.profile.a"
wasm32posix-ar crs "$archive" "$work"/objects/*.o
llvm-readobj --file-headers "$archive" > "$work/archive-headers.txt"
awk '
  /^Format: / { count++; if ($0 != "Format: WASM") bad = 1 }
  /^Arch: / { widths++; if ($0 != "Arch: wasm32") bad = 1 }
  END { exit (!count || count != widths || bad) }
' "$work/archive-headers.txt"

# profiler_builtins is upstream's no_core profiler_runtime crate. Building
# it by the installed target NAME preserves the target identity without a
# dependency on any std/core build, or on the large guest compiler package.
# The static runtime is bundled into the rlib through normal rustc linking.
private_sysroot="$work/rust-sysroot"
target_lib="lib/rustlib/wasm32-unknown-kandelo-std"
mkdir -p "$private_sysroot/$target_lib/lib"
cp "$repo/sdk/rust/wasm32-unknown-kandelo-std.json" "$private_sysroot/$target_lib/target.json"
rustc --sysroot "$private_sysroot" -Zunstable-options \
  --target wasm32-unknown-kandelo-std --crate-name profiler_builtins \
  --crate-type rlib --edition=2024 -Copt-level=3 -Cpanic=abort \
  -Cembed-bitcode=yes -Zforce-unstable-if-unmarked \
  -L "native=$out/lib" -l 'static:+verbatim=libclang_rt.profile.a' \
  "$rust_source/src/lib.rs" -o "$out/$target_lib/lib/libprofiler_builtins.rlib"
