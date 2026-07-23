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
export SEALED_REAL_LN
SEALED_REAL_LN="$(command -v ln)"
printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'case "${SEALED_LN_ATTACK:-}" in' \
    '  fail)' \
    '    exit 91' \
    '    ;;' \
    '  replace-stage)' \
    '    "$SEALED_REAL_LN" "$@"' \
    '    rm -f "$1"' \
    '    printf "replacement-stage\\n" >"$1"' \
    '    ;;' \
    '  modify-backup)' \
    '    "$SEALED_REAL_LN" "$@"' \
    '    printf "changed-backup-contents\\n" >"$(dirname "$1")/backup"' \
    '    ;;' \
    '  *)' \
    '    exec "$SEALED_REAL_LN" "$@"' \
    '    ;;' \
    'esac' >"$fake_bin/ln"
chmod +x "$fake_bin/ln"

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

# Nested destination ancestors are never followed.
attack_out="$work/attack-output"
outside="$work/outside"
mkdir -p "$attack_out" "$outside"
printf 'outside-sentinel\n' >"$outside/sentinel"
ln -s "$outside" "$attack_out/share"
if (
    source "$fake_repo/scripts/install-local-binary.sh"
    WASM_POSIX_DEP_OUT_DIR="$attack_out" \
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        install_local_runtime_file \
            cpython "$source_dir/python-runtime.zip" share/runtime.zip
) >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: followed a nested destination symlink" >&2
    exit 1
fi
[ "$(cat "$outside/sentinel")" = "outside-sentinel" ]
[ ! -e "$outside/runtime.zip" ]

# The authorized root itself may not be a symlink.
linked_out="$work/linked-output"
ln -s "$outside" "$linked_out"
if (
    source "$fake_repo/scripts/install-local-binary.sh"
    WASM_POSIX_DEP_OUT_DIR="$linked_out" \
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        install_local_runtime_file \
            cpython "$source_dir/python-runtime.zip" runtime.zip
) >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: accepted a symlink output root" >&2
    exit 1
fi
[ ! -e "$outside/runtime.zip" ]

# The packaging-only shell path is intentionally scoped to a caller-owned,
# single-writer scratch tree. A group/other-writable output root is rejected
# before a transaction or destination can be created.
shared_out="$work/shared-output"
mkdir "$shared_out"
chmod 0777 "$shared_out"
if (
    source "$fake_repo/scripts/install-local-binary.sh"
    PATH="$fake_bin:$PATH" \
    WASM_POSIX_DEP_OUT_DIR="$shared_out" \
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        install_local_runtime_file \
            cpython "$source_dir/python-runtime.zip" runtime.zip
) >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: accepted a shared-writer output root" >&2
    exit 1
fi
[ ! -e "$shared_out/runtime.zip" ]
[ -z "$(find "$shared_out" -mindepth 1 -maxdepth 1 -print -quit)" ]
chmod 0700 "$shared_out"

# A failed create-once publication restores an unchanged previous destination.
# The failed transaction remains as evidence instead of using recursive or
# unverified cleanup.
rollback_out="$work/rollback-output"
mkdir "$rollback_out"
printf 'previous-runtime\n' >"$rollback_out/runtime.zip"
if (
    source "$fake_repo/scripts/install-local-binary.sh"
    export PATH="$fake_bin:$PATH"
    export SEALED_LN_ATTACK=fail
    export WASM_POSIX_DEP_OUT_DIR="$rollback_out"
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    install_local_runtime_file \
        cpython "$source_dir/python-runtime.zip" runtime.zip
) >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: ignored a publication failure" >&2
    exit 1
fi
[ "$(cat "$rollback_out/runtime.zip")" = "previous-runtime" ]
rollback_transactions=("$rollback_out"/.kandelo-install.*)
[ "${#rollback_transactions[@]}" -eq 1 ]
[ -f "${rollback_transactions[0]}/stage" ]

# If another same-user process violates the single-writer contract and swaps
# the staged pathname after linking it, identity checks refuse to delete the
# replacement. This is defense in depth around the documented contract.
stage_attack_out="$work/stage-attack-output"
mkdir "$stage_attack_out"
if (
    source "$fake_repo/scripts/install-local-binary.sh"
    export PATH="$fake_bin:$PATH"
    export SEALED_LN_ATTACK=replace-stage
    export WASM_POSIX_DEP_OUT_DIR="$stage_attack_out"
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    install_local_runtime_file \
        cpython "$source_dir/python-runtime.zip" runtime.zip
) >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: accepted a substituted staged path" >&2
    exit 1
fi
stage_attack_transactions=("$stage_attack_out"/.kandelo-install.*)
[ "${#stage_attack_transactions[@]}" -eq 1 ]
[ "$(cat "${stage_attack_transactions[0]}/stage")" = "replacement-stage" ]
cmp "$source_dir/python-runtime.zip" "$stage_attack_out/runtime.zip"

# Content checks are independent of inode checks: mutating a quarantined
# regular file in place is detected and the changed bytes are preserved.
backup_attack_out="$work/backup-attack-output"
mkdir "$backup_attack_out"
printf 'previous-runtime\n' >"$backup_attack_out/runtime.zip"
if (
    source "$fake_repo/scripts/install-local-binary.sh"
    export PATH="$fake_bin:$PATH"
    export SEALED_LN_ATTACK=modify-backup
    export WASM_POSIX_DEP_OUT_DIR="$backup_attack_out"
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    install_local_runtime_file \
        cpython "$source_dir/python-runtime.zip" runtime.zip
) >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: deleted a changed quarantine" >&2
    exit 1
fi
backup_attack_transactions=("$backup_attack_out"/.kandelo-install.*)
[ "${#backup_attack_transactions[@]}" -eq 1 ]
[ "$(cat "${backup_attack_transactions[0]}/backup")" = "changed-backup-contents" ]
cmp "$source_dir/python-runtime.zip" "$backup_attack_out/runtime.zip"

# Sealed executable installs require an explicit reviewed policy.
if (
    source "$fake_repo/scripts/install-local-binary.sh"
    WASM_POSIX_DEP_OUT_DIR="$out_dir" \
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        install_local_binary cpython "$source_dir/python.wasm"
) >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: accepted an implicit sealed fork policy" >&2
    exit 1
fi

# Source symlinks are rejected before any destination is touched.
linked_source="$work/linked-source.wasm"
ln -s "$source_dir/python.wasm" "$linked_source"
if (
    source "$fake_repo/scripts/install-local-binary.sh"
    WASM_POSIX_DEP_OUT_DIR="$out_dir" \
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary cpython "$linked_source"
) >/dev/null 2>&1; then
    echo "test-install-local-binary-sealed.sh: accepted a symlink source" >&2
    exit 1
fi

echo "test-install-local-binary-sealed.sh: ok"
