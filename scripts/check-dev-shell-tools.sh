#!/usr/bin/env bash

# Fail when the canonical Nix dev shell resolves declared build tools from the
# ambient host. This is especially important on Darwin, where user-profile,
# /usr/bin, and Homebrew paths can precede mkShell package bins unless the
# shell hook deliberately restores the declared package order.

set -euo pipefail

if [ -z "${IN_NIX_SHELL:-}" ]; then
    echo "ERROR: check-dev-shell-tools.sh must run through scripts/dev-shell.sh" >&2
    exit 1
fi

case "${KANDELO_NIX_BIN:-}" in
    /*)
        [ -x "$KANDELO_NIX_BIN" ] || {
            echo "ERROR: KANDELO_NIX_BIN is not executable: $KANDELO_NIX_BIN" >&2
            exit 1
        }
        ;;
    *)
        echo "ERROR: dev shell did not retain the exact Nix executable" >&2
        exit 1
        ;;
esac

nix_store="${NIX_STORE:-/nix/store}"
for tool in cmake make; do
    resolved="$(command -v "$tool" || true)"
    case "$resolved" in
        "$nix_store"/*/bin/"$tool") ;;
        *)
            echo "ERROR: $tool resolved outside the declared Nix tool set: ${resolved:-<missing>}" >&2
            exit 1
            ;;
    esac
    "$tool" --version >/dev/null
done

for tool_path in "${AR:-}" "${RANLIB:-}"; do
    case "$tool_path" in
        "$nix_store"/*/bin/llvm-ar | "$nix_store"/*/bin/llvm-ranlib) ;;
        *)
            echo "ERROR: archive tool resolved outside the declared LLVM tool set: ${tool_path:-<missing>}" >&2
            exit 1
            ;;
    esac
    "$tool_path" --version >/dev/null
done
