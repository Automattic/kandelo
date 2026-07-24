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

nix_store="${NIX_STORE:-/nix/store}"
for tool in cc c++ cmake make; do
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

# Resolving a compiler from the Nix store is not enough: an unwrapped clang can
# still lack the host C++ standard library. Exercise the contract required by
# native package-generator builds without producing an artifact.
if ! printf '#include <memory>\nint main() { return 0; }\n' \
    | c++ -x c++ -fsyntax-only - >/dev/null 2>&1; then
    echo "ERROR: declared host C++ compiler cannot include <memory>" >&2
    exit 1
fi
