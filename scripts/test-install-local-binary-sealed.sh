#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v wasm-objdump >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: missing required tool: wasm-objdump" >&2
    exit 1
fi

work="$(mktemp -d)"
cleanup() {
    chmod -R u+w "$work" 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT

fake_repo="$work/read-only-repo"
source_dir="$work/read-only-source"
out_dir="$work/output"
fake_bin="$work/fake-bin"
probe_marker="$work/rust-probed"
mkdir -p "$fake_repo/scripts" "$source_dir" "$out_dir" "$fake_bin"
cp "$REPO_ROOT/scripts/install-local-binary.sh" "$fake_repo/scripts/"
cp "$REPO_ROOT/scripts/wasm-artifact-guards.sh" "$fake_repo/scripts/"

# A valid empty Wasm module is enough to exercise the ordinary no-fork policy.
printf '\000asm\001\000\000\000' > "$source_dir/python.wasm"
printf 'complete runtime tree\n' > "$source_dir/python-runtime.zip"
binary_sha_before="$(shasum -a 256 "$source_dir/python.wasm" | awk '{print $1}')"
runtime_sha_before="$(shasum -a 256 "$source_dir/python-runtime.zip" | awk '{print $1}')"

for tool in rustc cargo; do
    printf '%s\n' \
        '#!/usr/bin/env bash' \
        'printf "%s\n" "$0" >> "$SEALED_PROBE_MARKER"' \
        'exit 97' > "$fake_bin/$tool"
    chmod +x "$fake_bin/$tool"
done

chmod -R a-w "$fake_repo" "$source_dir"

(
    source "$fake_repo/scripts/install-local-binary.sh"
    export PATH="$fake_bin:$PATH"
    export SEALED_PROBE_MARKER="$probe_marker"
    export WASM_POSIX_DEP_OUT_DIR="$out_dir"
    export WASM_POSIX_DEP_TARGET_ARCH=wasm32
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto

    install_local_binary cpython "$source_dir/python.wasm"
    install_local_runtime_file cpython \
        "$source_dir/python-runtime.zip" \
        runtime/python-runtime.zip
)

[ ! -e "$probe_marker" ] || {
    echo "test-install-local-binary-sealed.sh: sealed install probed rustc/cargo" >&2
    exit 1
}
[ ! -e "$fake_repo/local-binaries" ] || {
    echo "test-install-local-binary-sealed.sh: sealed install wrote into its checkout" >&2
    exit 1
}
cmp "$source_dir/python.wasm" "$out_dir/python.wasm"
cmp "$source_dir/python-runtime.zip" "$out_dir/runtime/python-runtime.zip"
[ "$binary_sha_before" = "$(shasum -a 256 "$source_dir/python.wasm" | awk '{print $1}')" ]
[ "$runtime_sha_before" = "$(shasum -a 256 "$source_dir/python-runtime.zip" | awk '{print $1}')" ]

if (
    source "$fake_repo/scripts/install-local-binary.sh"
    WASM_POSIX_DEP_OUT_DIR="$out_dir" \
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        install_local_runtime_file cpython "$source_dir/python-runtime.zip" ../escape.zip
) >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: accepted an escaping runtime artifact" >&2
    exit 1
fi
[ ! -e "$work/escape.zip" ]

echo "test-install-local-binary-sealed.sh: ok"
