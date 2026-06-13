#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

suite="${1:-}"
if [ -z "$suite" ]; then
    echo "usage: $0 <cargo-kernel|fork-instrument|vitest|browser|libc|posix|sortix>" >&2
    exit 2
fi

host_target() {
    rustc -vV | awk '/^host/ {print $2}'
}

install_node_deps() {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
    (
        cd host
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
    )
}

case "$suite" in
    cargo-kernel)
        HOST_TARGET="$(host_target)"
        cargo test -p kandelo --target "$HOST_TARGET" --lib
        ;;
    fork-instrument)
        HOST_TARGET="$(host_target)"
        cargo test -p fork-instrument --target "$HOST_TARGET"
        ;;
    vitest)
        install_node_deps
        npx --prefix host playwright install chromium
        (cd host && npx vitest run)
        ;;
    browser)
        install_node_deps
        bash scripts/ci-check-browser-assets.sh
        (
            cd apps/browser-demos
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
            if [ "$(uname -s)" = "Linux" ]; then
                PATH="/usr/bin:/bin:$PATH" npx playwright install --with-deps chromium firefox
            else
                npx playwright install chromium firefox
            fi
            npx playwright test --grep-invert "@slow|@trap-signal" --project=chromium
            npx playwright test wasm-trap-signal.spec.ts --project=chromium --project=firefox
        )
        ;;
    libc)
        install_node_deps
        bash scripts/run-libc-tests.sh
        ;;
    posix)
        install_node_deps
        bash scripts/run-posix-tests.sh
        ;;
    sortix)
        install_node_deps
        bash scripts/run-sortix-tests.sh --all
        ;;
    *)
        echo "unknown CI test suite: $suite" >&2
        exit 2
        ;;
esac
