#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# The adapter owns this sole library build. Its Rust dependency still includes
# the original fork instrumenter and C boundary; no second archive is built.
kandelo_package_build_ffi_adapter() {
    local here="$1" crate=kandelo-ffi-adapter archive=libkandelo-ffi-adapter.a
    local root work out src triple=wasm32-unknown-kandelo-std member
    root="$(cd "$here/../../.." && pwd)"
    source "$root/scripts/package-build-roots.sh"
    kandelo_package_prepare_build_roots "$here" wasm32
    work="$KANDELO_PACKAGE_WORK_DIR"
    out="$KANDELO_PACKAGE_OUT_DIR"
    src="$work/src"
    source "$root/sdk/activate.sh"
    local digest host
    # Use the same canonical digest producer as the installed Rust SDK.
    # Pass this checkout's snapshot explicitly to a relocated xtask.
    if [ -n "${WASM_POSIX_XTASK_BIN:-}" ]; then
        digest=$("$WASM_POSIX_XTASK_BIN" abi-program-digest "$root/abi/snapshot.json")
    else
        host=$(rustc -vV | sed -n 's/^host: //p')
        digest=$(cd "$root" && CC=clang CXX=clang++ cargo run --locked --quiet \
            -p xtask --target "$host" -- abi-program-digest "$root/abi/snapshot.json")
    fi
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid SDK ABI digest: $digest" >&2; return 1; }
    export KANDELO_GUEST_PROGRAM_ABI_DIGEST="$digest"
    local -a crates=(fork-instrument-capi fork-instrument program-abi wasm-artifact kandelo-ffi-adapter)
    mkdir -p "$src/crates"
    for member in "${crates[@]}"; do
        cp -R "$root/crates/$member" "$src/crates/$member"
        # Keep every production dependency, excluding only fixture parsers.
        awk '/^\[dev-dependencies\]/ { skip = 1; next } /^\[/ { skip = 0 } !skip' \
            "$root/crates/$member/Cargo.toml" > "$src/crates/$member/Cargo.toml"
    done
    cp "$root/Cargo.lock" "$src/Cargo.lock"
    mkdir -p "$src/tools/xtask/src" "$src/abi"
    cp "$root/tools/xtask/src/local_abi_identity.rs" "$src/tools/xtask/src/"
    cp "$root/abi/snapshot.json" "$src/abi/"
    {
        printf '[workspace]\nresolver = "2"\nexclude = [".kandelo-rust", ".kandelo-patched-crates", ".kandelo-vendor"]\nmembers = [\n'
        for member in "${crates[@]}"; do printf '  "crates/%s",\n' "$member"; done
        printf ']\n\n'
        sed -n '/^\[workspace.package\]/,/^$/p' "$root/Cargo.toml"
        sed -n '/^\[profile.release\]/,/^$/p' "$root/Cargo.toml"
    } > "$src/Cargo.toml"
    (
        source "$root/scripts/package-rust-build-env.sh"
        kandelo_package_rust_build_env "$root" "$src" "$work" \
            "$root/packages/registry/wasm-fork-instrument/patches"
        export CARGO_PROFILE_RELEASE_LTO=false
        export CC_wasm32_unknown_kandelo_std=wasm32posix-cc
        export AR_wasm32_unknown_kandelo_std=llvm-ar
        cd "$src"
        cargo build --locked --release -p "$crate" --lib \
            --target "$triple" --target-dir "$work/target"
    )
    mkdir -p "$out/lib" "$out/include"
    install -m644 "$work/target/$triple/release/lib${crate//-/_}.a" "$out/lib/$archive"
    install -m644 "$src/crates/fork-instrument-capi/include/kandelo_fork_instrument.h" "$out/include/"
    install -m644 "$src/crates/kandelo-ffi-adapter/include/kandelo_ffi_adapter.h" "$out/include/"
    mkdir -p "$out/lib/pkgconfig"
    cat > "$out/lib/pkgconfig/kandelo-ffi-adapter.pc" <<'PC'
prefix=${pcfiledir}/../..
libdir=${prefix}/lib
includedir=${prefix}/include

Name: kandelo-ffi-adapter
Description: Typed guest FFI adapters with original in-process fork instrumentation
Version: 0.1.0
Libs: -L${libdir} -lkandelo-ffi-adapter
Cflags: -I${includedir}
PC
}

kandelo_package_build_ffi_adapter "$here"
