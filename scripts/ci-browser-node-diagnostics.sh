#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="${1:-${RUNNER_TEMP:-$REPO_ROOT}/browser-node-diagnostics}"
REPEAT="${2:-5}"
mkdir -p "$OUT_DIR"

log_section() {
    printf '\n== %s ==\n' "$1"
}

record_environment() {
    {
        log_section "time"
        date -u

        log_section "git"
        git rev-parse HEAD
        git status --short || true

        log_section "runner"
        uname -a
        cat /etc/os-release || true
        printf 'RUNNER_OS=%s\n' "${RUNNER_OS:-}"
        printf 'RUNNER_ARCH=%s\n' "${RUNNER_ARCH:-}"
        printf 'RUNNER_NAME=%s\n' "${RUNNER_NAME:-}"
        printf 'ImageOS=%s\n' "${ImageOS:-}"
        printf 'ImageVersion=%s\n' "${ImageVersion:-}"
        printf 'ImageName=%s\n' "${ImageName:-}"
        lscpu || true

        log_section "limits"
        ulimit -a || true
        free -h || true
        df -h / /dev/shm || true
        mount | grep -E ' / | /dev/shm |cgroup' || true

        log_section "tool versions"
        which node || true
        node --version || true
        which npm || true
        npm --version || true
        which rustc || true
        rustc -vV || true
        which cargo || true
        cargo -V || true
        which clang || true
        clang --version || true
        which npx || true
        npx playwright --version || true

        log_section "selected environment"
        env | sort | grep -E '^(CI|GITHUB_ACTIONS|GITHUB_EVENT_NAME|GITHUB_REF|GITHUB_REF_NAME|GITHUB_REPOSITORY|GITHUB_RUN_ID|GITHUB_SHA|RUNNER_|Image|WASM_POSIX_|SYNTH)' || true
    } | tee "$OUT_DIR/environment.txt"
}

record_node_assets() {
    local label="$1"
    {
        log_section "node assets: $label"
        for path in \
            local-binaries/kernel.wasm \
            local-binaries/programs/wasm32/node.wasm \
            local-binaries/programs/wasm32/spidermonkey-node.wasm \
            local-binaries/programs/wasm32/node-vfs.vfs.zst \
            binaries/programs/wasm32/node.wasm \
            binaries/programs/wasm32/spidermonkey-node.wasm \
            binaries/programs/wasm32/node-vfs.vfs.zst \
            binaries/programs/wasm32/spidermonkey.wasm \
            apps/browser-demos/public/node-vfs.vfs.zst
        do
            printf '\n-- %s --\n' "$path"
            if [ -e "$path" ] || [ -L "$path" ]; then
                ls -l "$path"
                real="$(readlink -f "$path" 2>/dev/null || true)"
                if [ -n "$real" ]; then
                    printf 'realpath: %s\n' "$real"
                    if [ -f "$real" ]; then
                        sha256sum "$real" || true
                        file "$real" || true
                        ls -lh "$real" || true
                    fi
                fi
            else
                echo "missing"
            fi
        done

        log_section "node package revisions"
        for file in \
            packages/registry/node/build.toml \
            packages/registry/spidermonkey-node/build.toml \
            packages/registry/spidermonkey/build.toml
        do
            printf '\n-- %s --\n' "$file"
            grep -E '^(name|version|revision|cache_key_sha|archive_sha)' "$file" || true
        done
    } | tee -a "$OUT_DIR/node-assets.txt"
}

record_environment
record_node_assets "before prepare-browser"

log_section "install root and host npm deps"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund 2>&1 | tee "$OUT_DIR/npm-root.log"
(
    cd host
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
) 2>&1 | tee "$OUT_DIR/npm-host.log"

log_section "prepare-browser"
./run.sh prepare-browser 2>&1 | tee "$OUT_DIR/prepare-browser.log"
record_node_assets "after prepare-browser"

log_section "install browser demo deps and chromium"
(
    cd apps/browser-demos
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
    npx playwright install chromium
    node - <<'NODE'
const { chromium } = require('@playwright/test');
console.log('chromium executable:', chromium.executablePath());
NODE
    chromium_path="$(node - <<'NODE'
const { chromium } = require('@playwright/test');
process.stdout.write(chromium.executablePath());
NODE
)"
    "$chromium_path" --version || true
) 2>&1 | tee "$OUT_DIR/playwright-install.log"

log_section "focused shell+node browser repeat"
set +e
(
    cd apps/browser-demos
    KANDELO_PLAYWRIGHT_PORT="${KANDELO_PLAYWRIGHT_PORT:-5581}" \
        npx playwright test test/kandelo-merge-gate.spec.ts \
            --grep "Kandelo shell demo|Kandelo Node.js demo" \
            --project=chromium \
            --workers=1 \
            --repeat-each="$REPEAT" \
            --trace=on \
            --output "$OUT_DIR/playwright-output"
) 2>&1 | tee "$OUT_DIR/playwright-repeat.log"
test_rc="${PIPESTATUS[0]}"
set -e

record_node_assets "after playwright"

exit "$test_rc"
