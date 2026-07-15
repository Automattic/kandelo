#!/usr/bin/env bash
#
# Resolve a binary relative to the binaries/ tree. Priority:
#   1. $REPO/local-binaries/<rel>   (user override unless it is a legacy
#                                    fork artifact and fetched release is fresh)
#   2. $REPO/binaries/<rel>         (fetched release)
#
# Prints the absolute path on stdout, or prints a helpful error to
# stderr and exits 1.
#
# This is the shell-script equivalent of host/src/binary-resolver.ts.
# Keep them in sync.
#
# Usage:
#   $(scripts/resolve-binary.sh kernel.wasm)
#   $(scripts/resolve-binary.sh programs/dash.wasm)
#   $(scripts/resolve-binary.sh vfs/shell.vfs.zst)

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/wasm-artifact-guards.sh"

if [ $# -ne 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    sed -n '3,18p' "$0"
    exit 0
fi

rel="$1"
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
    # Fall back to walking up from $PWD looking for the workspace
    # Cargo.toml + abi/snapshot.json (a unique pair only present at
    # this repo's root).
    dir="$(pwd)"
    while [ "$dir" != "/" ]; do
        if [ -f "$dir/Cargo.toml" ] && [ -f "$dir/abi/snapshot.json" ]; then
            repo_root="$dir"
            break
        fi
        dir="$(dirname "$dir")"
    done
fi
if [ -z "$repo_root" ]; then
    echo "ERROR: could not find repo root" >&2
    exit 1
fi

# Default-arch shim: callers historically pass `programs/<x>` without
# an arch segment (run.sh has 30+ `has_resolvable programs/<name>.wasm`
# checks). After the per-arch layout refactor, those files live at
# `programs/wasm32/<x>` (or `wasm64/<x>`). Inject `wasm32/` when the
# caller's path starts with `programs/` and the next segment isn't
# already `wasm32` or `wasm64`. Mirrors the same shim in
# host/src/binary-resolver.ts (applyDefaultArch).
adjusted="$rel"
case "$rel" in
    programs/wasm32/*|programs/wasm64/*) ;;  # explicit arch — pass through
    programs/*)
        adjusted="programs/wasm32/${rel#programs/}"
        ;;
esac

local_path="$repo_root/local-binaries/$adjusted"
fetched_path="$repo_root/binaries/$adjusted"
current_abi="$(wasm_current_abi_version "$repo_root" || true)"

fork_instrumentation_for_rel() {
    local rel="$1"
    case "$rel" in
        programs/wasm32/*) rel="${rel#programs/wasm32/}" ;;
        programs/wasm64/*) rel="${rel#programs/wasm64/}" ;;
        programs/*) rel="${rel#programs/}" ;;
        *) echo none; return 0 ;;
    esac

    local manifest policy
    for manifest in "$repo_root"/packages/registry/*/package.toml; do
        [ -f "$manifest" ] || continue
        policy="$(awk -v target="$rel" '
            function val(s) {
                sub(/^[^=]*=[ \t]*"/, "", s)
                sub(/".*$/, "", s)
                return s
            }
            function ext(path, parts, n, base, dot) {
                n = split(path, parts, "/")
                base = parts[n]
                dot = index(base, ".")
                return dot ? substr(base, dot) : ""
            }
            function flush() {
                if (!in_output) return
                count++
                output_name[count] = out_name
                output_wasm[count] = out_wasm
                output_policy[count] = out_policy
                out_name = ""
                out_wasm = ""
                out_policy = ""
                in_output = 0
            }
            $0 ~ /^\[\[outputs\]\]/ {
                flush()
                in_output = 1
                in_root = 0
                next
            }
            in_output && $0 ~ /^\[/ {
                flush()
                in_root = 0
                next
            }
            !in_output && $0 ~ /^\[/ {
                in_root = 0
                next
            }
            BEGIN {
                in_root = 1
            }
            in_root && $0 ~ /^kind[ \t]*=/ { kind = val($0); next }
            in_root && $0 ~ /^name[ \t]*=/ { pkg = val($0); next }
            in_output && $0 ~ /^name[ \t]*=/ { out_name = val($0); next }
            in_output && $0 ~ /^wasm[ \t]*=/ { out_wasm = val($0); next }
            in_output && $0 ~ /^fork_instrumentation[ \t]*=/ { out_policy = val($0); next }
            END {
                flush()
                if (kind != "program" || pkg == "") exit
                for (i = 1; i <= count; i++) {
                    if (output_name[i] == "" || output_wasm[i] == "") continue
                    dest = output_name[i] ext(output_wasm[i])
                    if (count > 1) dest = pkg "/" dest
                    if (dest == target && output_policy[i] == "disabled") {
                        print "disabled"
                        exit
                    }
                }
            }
        ' "$manifest")"
        if [ "$policy" = "disabled" ]; then
            echo disabled
            return 0
        fi
    done
    echo auto
}

fork_instrumentation="$(fork_instrumentation_for_rel "$adjusted")"

kernel_required_exports=(
    __abi_version
    kernel_alloc_scratch
    kernel_create_process
    kernel_create_process_with_stdio
    kernel_get_parent_pid
    kernel_get_process_state
    kernel_handle_channel
    kernel_has_sa_nocldstop
    kernel_host_adapter_manifest_len
    kernel_host_adapter_manifest_ptr
    kernel_mark_process_signaled
    kernel_reap_exited_child
    kernel_remove_process
    kernel_wait_child_poll
)

executable_program_required_exports=(
    __abi_version
    _start
)

is_executable_program_wasm_rel() {
    case "$adjusted" in
        programs/wasm32/*.wasm|programs/wasm32/*/*.wasm|programs/wasm64/*.wasm|programs/wasm64/*/*.wasm)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

is_stale_wasm_artifact() {
    # Declared data/archive outputs are resolved through the program tree but
    # do not carry Wasm ABI sections or exports. VFS images deliberately
    # continue through the existing conservative guard until the shell
    # resolver has an equivalent of the TypeScript resolver's metadata check.
    case "$adjusted" in
        *.wasm|*.vfs|*.vfs.zst) ;;
        *) return 1 ;;
    esac

    wasm_has_legacy_asyncify "$1" ||
        wasm_has_stale_abi "$1" "$current_abi" ||
        { [ "$adjusted" = "kernel.wasm" ] && wasm_has_missing_exports "$1" "${kernel_required_exports[@]}"; } ||
        { is_executable_program_wasm_rel && wasm_has_missing_exports "$1" "${executable_program_required_exports[@]}"; } ||
        case "$fork_instrumentation" in
            none)
                false
                ;;
            disabled)
                wasm_has_any_wpk_fork_export "$1"
                ;;
            *)
                wasm_has_missing_fork_instrumentation "$1"
                ;;
        esac
}

if [ -e "$local_path" ]; then
    if [ -e "$fetched_path" ] \
        && is_stale_wasm_artifact "$local_path" \
        && ! is_stale_wasm_artifact "$fetched_path"; then
        echo "$fetched_path"
        exit 0
    fi
    if is_stale_wasm_artifact "$local_path"; then
        echo "ERROR: stale wasm artifact ignored: $local_path" >&2
        echo "       Rebuild it for ABI ${current_abi:-current}, fetch a fresh release, or remove the stale local override." >&2
        exit 1
    fi
    echo "$local_path"
    exit 0
fi
if [ -e "$fetched_path" ]; then
    if is_stale_wasm_artifact "$fetched_path"; then
        echo "ERROR: stale wasm artifact ignored: $fetched_path" >&2
        echo "       Rebuild it for ABI ${current_abi:-current} or fetch a fresh release." >&2
        exit 1
    fi
    echo "$fetched_path"
    exit 0
fi

cat >&2 <<EOF
ERROR: binary not found: $rel
  checked: $local_path
  checked: $fetched_path
  Run scripts/fetch-binaries.sh or place a file at local-binaries/$adjusted.
EOF
exit 1
