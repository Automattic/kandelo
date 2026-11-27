#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
source "$root/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$here"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
out="$KANDELO_PACKAGE_OUT_DIR"
src="$work/amaro-source"
source "$root/sdk/activate.sh"
kandelo_package_stage_verified_source node-amaro "$src" "${WASM_POSIX_DEP_SOURCE_DIR:-}" \
  "$WASM_POSIX_DEP_SOURCE_URL" "$WASM_POSIX_DEP_SOURCE_SHA256" "$work"
for patch_file in "$here"/patches/*.patch; do
  patch --batch -F0 -p1 -d "$src" < "$patch_file"
done
cp "$here/src/kandelo_native.rs" "$here/src/kandelo_values.rs" "$src/deps/swc/bindings/binding_typescript_wasm/src/"
# This is the exact dependency already pinned in upstream Cargo.lock. Preserve
# its complete de/ser algorithms; adapt JS import operations, not Options.
kandelo_package_stage_source_dependency node-amaro-serde-source "$work/serde-source" "$work"
python3 "$here/prepare-native-serde.py" "$work/serde-source" \
  "$src/deps/swc/bindings/kandelo_serde_values" "$here/src/kandelo_js.rs"
# The native profile changes only the backend input to the whole wrapper.
cp "$here/src/native-backend.js" "$src/lib/wasm.js"
# Restrict workspace build roots, retaining all original dependency declarations
# and their original path sources. The upstream lockfile remains the version pin.
python3 - "$src/deps/swc/Cargo.toml" <<'PY'
import pathlib,re,sys,tomllib
p=pathlib.Path(sys.argv[1]);s=p.read_text();old=tomllib.loads(s)
s,n=re.subn(r'(?m)^members = \[.*?^\]', 'members = ["bindings/binding_typescript_wasm"]', s, count=1, flags=re.S)
assert n==1
new=tomllib.loads(s);expected={**old,'workspace':{**old['workspace'],'members':['bindings/binding_typescript_wasm']}}
assert new==expected
p.write_text(s)
PY
(
  export CARGO_PROFILE_RELEASE_PANIC=unwind
  export CARGO_PROFILE_RELEASE_LTO=false
  export CARGO_ENCODED_RUSTFLAGS=$'-Crelocation-model=pic\037-Ctarget-feature=+exception-handling\037-Cllvm-args=-wasm-use-legacy-eh=false'
  source "$root/scripts/package-rust-build-env.sh"
  kandelo_package_rust_build_env "$root" "$src/deps/swc" "$work" "$here/rust-patches"
  export CC_wasm32_unknown_kandelo_std=wasm32posix-cc AR_wasm32_unknown_kandelo_std=llvm-ar
  export CFLAGS="${CFLAGS:-} -fPIC"
  cd "$src/deps/swc"
  cargo tree --locked -p binding_typescript_wasm --features kandelo-native \
    --edges normal,build --target wasm32-unknown-kandelo-std
  cargo build --locked --release -p binding_typescript_wasm --features kandelo-native \
    --target wasm32-unknown-kandelo-std --target-dir "$work/target"
)
exports=(kandelo_amaro_transform_values kandelo_amaro_abi_version kandelo_amaro_transform kandelo_amaro_result_bytes kandelo_amaro_result_release)
flags=()
for name in "${exports[@]}"; do flags+=("-Wl,--export=$name"); done
wasm32posix-cc -shared -Wl,--no-export-dynamic "${flags[@]}" \
  "$work/target/wasm32-unknown-kandelo-std/release/libbinding_typescript_wasm.a" -o "$work/libnode-amaro.raw.so"
node "$here/native-imports.mjs" "$work/libnode-amaro.raw.so" "$work/native-imports.json"
"$root/scripts/run-wasm-fork-instrument.sh" "$work/libnode-amaro.raw.so" -o "$work/libnode-amaro.so"
(cd "$root" && cargo xtask stamp-abi-contract "$work/libnode-amaro.so")
mkdir -p "$out/lib" "$out/include" "$out/share/kandelo/amaro" "$out/share/licenses/node-amaro"
install -m644 "$work/libnode-amaro.so" "$out/lib/libnode-amaro.so"
install -m644 "$here/src/kandelo_amaro.h" "$here/src/kandelo_amaro_values.h" "$out/include/"
install -m644 "$work/native-imports.json" "$out/share/kandelo/amaro/native-imports.json"
# Normal dependency build tooling, pinned by this checkout's package lock.
"$root/node_modules/.bin/esbuild" "$src/src/index.ts" --bundle --platform=node \
  --target=node22 --outfile="$out/share/kandelo/amaro/index.js"
install -m644 "$src/LICENSE.md" "$out/share/licenses/node-amaro/LICENSE.amaro"
install -m644 "$src/deps/swc/LICENSE" "$out/share/licenses/node-amaro/LICENSE.swc"
install -m644 "$work/serde-source/LICENSE" "$out/share/licenses/node-amaro/LICENSE.serde-wasm-bindgen"
