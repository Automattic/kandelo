#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

suite="${1:-}"
if [ -z "$suite" ]; then
    echo "usage: $0 <cargo-workspace|vitest|browser|libc|posix|sortix>" >&2
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
    cargo-workspace)
        # Host-run unit + integration tests for every workspace crate EXCEPT
        # xtask: kandelo (kernel), fork-instrument, wasm-posix-shared,
        # wasm-posix-userspace, wasm-local-root-spill. `--workspace` is
        # closed-by-default: a new crate under crates/ is gated with no
        # allow-list edit, and each crate's integration tests run too (no
        # `--lib`, which would silently run 0 tests for a bin-only crate such
        # as wasm-local-root-spill). xtask is excluded because it is gated
        # separately as the always-run `cargo-xtask` suite -- it lives under
        # tools/ (outside the kernel change-scope) and its regressions are
        # independent of kernel changes. `--target <host>` is REQUIRED: the
        # default wasm32-unknown-unknown target has no host test runner, and
        # host-only deps (getrandom; xtask's ring/zstd) do not cross-compile.
        HOST_TARGET="$(host_target)"
        cargo test --workspace --exclude xtask --target "$HOST_TARGET"
        ;;
    vitest)
        install_node_deps
        npx --prefix host playwright install chromium
        (cd host && npx vitest run)
        # [JSC-TERMINATE-ATOMICS-WAIT-LEAK] Re-run the teardown-reclamation tests
        # on JSC (Bun) as well as V8, since the workaround exists for JSC (Safari
        # and Bun) and is a no-op on V8. `bun` comes from the flake dev shell.
        # See docs/jsc-terminate-atomics-wait-workaround.md.
        (cd host && bun x vitest run test/teardown-reclaim.test.ts test/pthread.test.ts)
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
