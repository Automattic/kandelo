#!/usr/bin/env bash

# Fail when the canonical Nix dev shell resolves declared build tools from the
# ambient host. This is especially important on Darwin, where user-profile,
# /usr/bin, and other ambient host package-manager paths can precede mkShell
# package bins unless the shell hook deliberately restores the declared
# package order.

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

# `cargo xtask <verb>` is written throughout this tree -- 178 places when
# this check was added -- docs,
# tools/xtask's own source, and messages host-native prints to an operator
# debugging a stale artifact. It resolves only because the dev shell puts
# `scripts/bin` on PATH (flake.nix), the same way it does `sdk/bin`. There is
# no cargo alias that can stand in: `[build] target` would build a host tool
# for wasm, and cargo cannot override that from inside an alias.
#
# Nothing else in the tree would notice if that prepend were dropped: the 178
# citations would go back to answering "no such command: `xtask`", quietly.
resolved="$(command -v cargo-xtask || true)"
case "$resolved" in
    */scripts/bin/cargo-xtask)
        [ -x "$resolved" ] || {
            echo "ERROR: cargo-xtask is on PATH but not executable: $resolved" >&2
            exit 1
        }
        ;;
    *)
        echo "ERROR: cargo-xtask did not resolve to this repository's scripts/bin," >&2
        echo "       so \`cargo xtask <verb>\` will not run: ${resolved:-<missing>}" >&2
        exit 1
        ;;
esac

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
