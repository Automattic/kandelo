#!/usr/bin/env bash
set -euo pipefail

# CI-shaped suite runner. The optional group selects deterministic natural
# shards for the two longest conformance suites:
#   libc:   functional-regression | math
#   sortix: include | basic | runtime
# Omitting the group preserves the complete local suite behavior.
# Set PREPARE_BROWSER_ASSETS=1 when the caller supplied an already-materialized
# binaries/ artifact but intentionally deferred local browser asset generation.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

host_target() {
    rustc -vV | awk '/^host/ {print $2}'
}

# Prepared CI workspaces transport fetched programs as relative links into a
# repo-local copy of the exact content-addressed cache generations. Point both
# the Rust and TypeScript resolvers at that identity before any suite can read
# `binaries/`; otherwise the copied cache would look like an unrelated tier.
portable_cache="$REPO_ROOT/.ci-test-binary-cache"
if [ -d "$portable_cache/programs" ]; then
    export WASM_POSIX_BINARY_CACHE_ROOT="$portable_cache"
    prepared_xtask="$REPO_ROOT/target/$(host_target)/release/xtask"
    if [ ! -f "$prepared_xtask" ] || [ ! -x "$prepared_xtask" ]; then
        echo "ci-run-test-suite: missing executable prepared package checker: $prepared_xtask" >&2
        exit 1
    fi
    # WHY: each conformance case starts a fresh Node resolver under a short
    # timeout. Without the packed checker path, every process may start Cargo
    # preparation and leave later cases waiting on its build lock.
    export WASM_POSIX_XTASK_BIN="$prepared_xtask"
fi

suite="${1:-}"
if [ -z "$suite" ]; then
    echo "usage: $0 <cargo-kernel|fork-instrument|vitest|browser|libc|posix|sortix> [group]" >&2
    exit 2
fi
group="${2:-${TEST_GROUP:-all}}"

invalid_group() {
    echo "unknown $suite test group: $group" >&2
    exit 2
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

CI_HOMEBREW_BROWSER_MIRROR=""
CI_HOMEBREW_BROWSER_REPORT_ROOT=""

cleanup_ci_homebrew_browser_mirror() {
    local status="$?"
    trap - EXIT
    if [ -n "$CI_HOMEBREW_BROWSER_MIRROR" ]; then
        rm -rf -- "$CI_HOMEBREW_BROWSER_MIRROR"
    fi
    if [ -n "$CI_HOMEBREW_BROWSER_REPORT_ROOT" ]; then
        rm -rf -- "$CI_HOMEBREW_BROWSER_REPORT_ROOT"
    fi
    exit "$status"
}

prepare_ci_homebrew_browser_mirror() {
    local state="$REPO_ROOT/.ci-homebrew-browser-mirror-state.json"
    local mirror="$REPO_ROOT/apps/browser-demos/public/homebrew-main-shell-bottles"
    local mirror_required
    local image
    local report
    local publication_blockers="$REPO_ROOT/.ci-test-publication-blockers.json"

    if [ ! -f "$state" ]; then
        echo "ci-run-test-suite: prepared browser workspace lacks Homebrew mirror state: $state" >&2
        return 1
    fi
    if [ ! -f "$publication_blockers" ]; then
        echo "ci-run-test-suite: prepared browser workspace lacks its publication blocker report: $publication_blockers" >&2
        return 1
    fi
    image="$(bash scripts/resolve-binary.sh programs/shell.vfs.zst)"
    bash scripts/ci-homebrew-browser-mirror-state.sh \
        validate consumer "$state" "$publication_blockers" "$image"
    mirror_required="$(jq -r '.mirror_required' "$state")"
    [ "$mirror_required" = "true" ] || return 0
    if [ -e "$mirror" ] || [ -L "$mirror" ]; then
        echo "ci-run-test-suite: closed Homebrew browser mirror already exists: $mirror" >&2
        return 1
    fi

    CI_HOMEBREW_BROWSER_REPORT_ROOT="$(
        mktemp -d "${RUNNER_TEMP:-/tmp}/kandelo-ci-homebrew-browser.XXXXXX"
    )"
    report="$CI_HOMEBREW_BROWSER_REPORT_ROOT/recovery.json"
    CI_HOMEBREW_BROWSER_MIRROR="$mirror"
    trap cleanup_ci_homebrew_browser_mirror EXIT

    # WHY: an expected-ledger identity absent from the immutable canonical
    # package index names final bottle URLs that cannot exist until this exact
    # Kandelo commit reaches main. Recover the same digest-bound layers
    # anonymously from their public source packages for pre-merge browser
    # validation instead of publishing early or weakening the candidate
    # image's production transport identity.
    npx tsx scripts/recover-homebrew-bottle-mirror.ts \
        --image "$image" \
        --out "$mirror" \
        --report "$report"
    [ -f "$mirror/kandelo-homebrew-bottle-mirror-plan.json" ] &&
        [ -f "$report" ] || {
        echo "ci-run-test-suite: closed Homebrew browser mirror is incomplete" >&2
        return 1
    }
    export KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT=/homebrew-main-shell-bottles
    export KANDELO_PLAYWRIGHT_VITE_MODE=homebrew-closed-acceptance
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
        # [JSC-TERMINATE-ATOMICS-WAIT-LEAK] Re-run the teardown-reclamation tests
        # on JSC (Bun) as well as V8, since the workaround exists for JSC (Safari
        # and Bun) and is a no-op on V8. `bun` comes from the flake dev shell.
        # See docs/jsc-terminate-atomics-wait-workaround.md.
        (cd host && bun x vitest run test/teardown-reclaim.test.ts test/pthread.test.ts)
        ;;
    browser)
        install_node_deps
        if [ "${PREPARE_BROWSER_ASSETS:-false}" = "true" ] || \
            [ "${PREPARE_BROWSER_ASSETS:-0}" = "1" ]; then
            # Publication-pending packages are deliberately absent from the
            # prepared release ledger. Materialize their exact PR recipes as
            # local test generations before the ordinary fetch-only browser
            # pass proves that every browser dependency is now resolvable.
            bash scripts/materialize-ci-publication-blockers.sh
            ./run.sh --already-materialized --fetch-only prepare-browser
            prepare_ci_homebrew_browser_mirror
        fi
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
                    test/boot-current-boundary.spec.ts \
                    test/coi.spec.ts \
                    test/package-deferred-tree-browser.spec.ts \
                    test/vfs-import-seal-boundary.spec.ts \
                    test/wasm-trap-signal.spec.ts \
                    --project=chromium --project=firefox --project=webkit
        )
        ;;
    libc)
        install_node_deps
        case "$group" in
            all)                   bash scripts/run-libc-tests.sh ;;
            functional-regression) bash scripts/run-libc-tests.sh functional regression ;;
            math)                  bash scripts/run-libc-tests.sh math ;;
            *)                     invalid_group ;;
        esac
        ;;
    posix)
        install_node_deps
        bash scripts/run-posix-tests.sh
        ;;
    sortix)
        install_node_deps
        case "$group" in
            all)     bash scripts/run-sortix-tests.sh --all ;;
            include) bash scripts/run-sortix-tests.sh include ;;
            basic)   bash scripts/run-sortix-tests.sh basic ;;
            runtime) bash scripts/run-sortix-tests.sh limits malloc stdio io signal process paths udp ;;
            *)       invalid_group ;;
        esac
        ;;
    *)
        echo "unknown CI test suite: $suite" >&2
        exit 2
        ;;
esac
