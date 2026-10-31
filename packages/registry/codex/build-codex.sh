#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
source "$REPO_ROOT/sdk/activate.sh"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/codex-src"
kandelo_package_stage_primary_source codex "$SRC_DIR" "$WORK_DIR"
patch --batch --forward --fuzz=0 -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/kandelo.patch"

(
    export KANDELO_RUST_DIR="$WORK_DIR/rust"
    bash "$REPO_ROOT/scripts/build-rust-sysroot.sh"
    export RUSTC="$KANDELO_RUST_DIR/rustc-kandelo"
    export RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1
    export CC_wasm32_unknown_kandelo_std=wasm32posix-cc
    export AR_wasm32_unknown_kandelo_std=wasm32posix-ar
    export CXX_wasm32_unknown_kandelo_std=wasm32posix-c++
    # Strict C11 builds need explicit POSIX declarations from musl.
    export CFLAGS_wasm32_unknown_kandelo_std="-D_POSIX_C_SOURCE=200809L -D_DEFAULT_SOURCE=1"
    export CARGO_TARGET_WASM32_UNKNOWN_KANDELO_STD_RUSTFLAGS='--check-cfg=cfg(target_os,values("kandelo"))'
    export OPENSSL_DIR="${WASM_POSIX_DEP_OPENSSL_DIR:?declare openssl in depends_on}"
    export OPENSSL_STATIC=1
    export OPENSSL_NO_VENDOR=1
    # Rust build scripts must query target metadata, not Nix host .pc files.
    export PKG_CONFIG="$(command -v wasm32posix-pkg-config)"
    export PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:-}"
    export PKG_CONFIG_ALLOW_CROSS=1
    export PKG_CONFIG_ALL_STATIC=1
    # Use the C sources pinned inside these locked crates. Their default
    # autodetection can otherwise select unrelated host compression libraries.
    export LZMA_API_STATIC=1
    export BZIP2_NO_PKG_CONFIG=1
    export CARGO_TARGET_DIR="$WORK_DIR/target"
    export CARGO_BUILD_JOBS="${WASM_POSIX_LOCAL_BUILD_JOBS:-8}"
    cd "$SRC_DIR/codex-rs"
    # Match the libc crate used by Kandelo's prebuilt standard library.
    python3 - "$KANDELO_RUST_DIR/libc-kandelo" <<'PY'
import pathlib, sys
p = pathlib.Path("Cargo.toml")
s = p.read_text()
needle = "[patch.crates-io]\n"
assert s.count(needle) == 1
p.write_text(s.replace(needle, needle + 'libc = { path = "' + sys.argv[1] + '" }\n'))
PY
    libc_version="$(python3 - "$KANDELO_RUST_DIR/libc-kandelo/Cargo.toml" Cargo.lock <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as source:
    version = tomllib.load(source)["package"]["version"]
with open(sys.argv[2], "rb") as source:
    locked = [p["version"] for p in tomllib.load(source)["package"] if p["name"] == "libc"]
if locked != [version]:
    raise SystemExit(f"Codex locks libc {locked}; align the SDK bindings rather than changing the lock")
print(version)
PY
)"
    cargo update -p libc --precise "$libc_version"
    source "$SCRIPT_DIR/prepare-rust-deps.sh"
    cargo build --locked --keep-going --release --target wasm32-unknown-kandelo-std \
        -p codex-cli --bin codex
)

# Upstream keeps DWARF until packaging. Remove only debug sections: Wasm
# function names and compiler facts must survive for diagnostics and forking.
llvm-strip --strip-debug "$WORK_DIR/target/wasm32-unknown-kandelo-std/release/codex.wasm" \
    -o "$WORK_DIR/codex.wasm"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary codex "$WORK_DIR/codex.wasm" codex.wasm
install_local_runtime_file codex "$SCRIPT_DIR/system-config.toml" config.toml
install_local_runtime_file codex "$SCRIPT_DIR/credential-requests.json" credential-requests.json
