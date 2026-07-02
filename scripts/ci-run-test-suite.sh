#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

suite="${1:-}"
if [ -z "$suite" ]; then
    echo "usage: $0 <cargo-kernel|cargo-xtask|fork-instrument|vitest|browser|libc|posix|sortix>" >&2
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

run_timed() {
    local limit="$1"
    local label="$2"
    shift 2

    echo "::group::$label"
    set +e
    if command -v timeout >/dev/null 2>&1; then
        timeout --kill-after=30s "$limit" "$@"
    else
        "$@"
    fi
    local status=$?
    set -e
    if [ "$status" -ne 0 ]; then
        echo "::error::$label failed with status $status"
    fi
    echo "::endgroup::"
    return "$status"
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
    cargo-xtask)
        # Package-system automation unit tests (tools/xtask/**): package
        # resolver, binaries-dir placement, and archive staging/naming. Pure
        # host-target cargo tests; no wasm sysroots or prepared workspace needed.
        HOST_TARGET="$(host_target)"
        cargo test -p xtask --target "$HOST_TARGET"
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
                run_timed 30m "Install Playwright browsers" \
                    env PATH="/usr/bin:/bin:$PATH" \
                    npx playwright install --with-deps chromium firefox webkit
            else
                run_timed 30m "Install Playwright browsers" \
                    npx playwright install chromium firefox webkit
            fi
            run_timed 20m "Run Chromium browser demo smoke suite" \
                npx playwright test --grep-invert "@slow|@trap-signal" \
                    --project=chromium
            run_timed 10m "Run cross-browser contract smoke suite" \
                npx playwright test \
                    test/coi.spec.ts \
                    test/browser-kernel-lazy-registration.spec.ts \
                    test/wasm-trap-signal.spec.ts \
                    --project=chromium --project=firefox --project=webkit
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
