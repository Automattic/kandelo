#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="${1:-${RUNNER_TEMP:-$REPO_ROOT}/browser-node-diagnostics}"
REPEAT="${2:-5}"
prepared_workspace=0
if [ "${3:-}" = "--prepared-workspace" ]; then
    prepared_workspace=1
elif [ -n "${3:-}" ]; then
    echo "unknown browser Node diagnostics option: $3" >&2
    exit 2
fi
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

if [ "$prepared_workspace" = "1" ]; then
    log_section "verify prepared browser workspace"
    bash scripts/ci-verify-browser-workspace.sh 2>&1 | tee "$OUT_DIR/prepare-browser.log"
else
    log_section "prepare-browser"
    ./run.sh prepare-browser 2>&1 | tee "$OUT_DIR/prepare-browser.log"
fi
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

log_section "targeted browser node diagnostics"
cat > apps/browser-demos/test/browser-node-diagnostics.generated.spec.ts <<'TS'
import { expect, test, type Page } from "@playwright/test";

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function waitForTerminalContent(page: Page, expected: RegExp, timeout = 120_000) {
  await expect.poll(() => terminalText(page), { timeout }).toMatch(expected);
}

async function runTerminalCommand(page: Page, command: string, expected: RegExp, timeout = 120_000) {
  await page.locator(".kshell-host").first().click();
  const terminalInput = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await terminalInput.count()) {
    await terminalInput.focus();
  }
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForTerminalContent(page, expected, timeout);
}

function nodeEval(source: string): string {
  return `node -e ${JSON.stringify(source)}`;
}

function statusPattern(name: string): RegExp {
  return new RegExp(`DIAG_STATUS_${name}:\\d+[\\s\\S]*spidermonkey-node\\$ ?`);
}

async function runNodeStatusCase(page: Page, name: string, source: string, timeout = 120_000): Promise<number> {
  await runTerminalCommand(
    page,
    `${nodeEval(source)} ; echo DIAG_STATUS_${name}:$?`,
    statusPattern(name),
    timeout,
  );
  const text = await terminalText(page);
  const match = text.match(new RegExp(`DIAG_STATUS_${name}:(\\d+)`));
  if (!match) {
    throw new Error(`missing DIAG_STATUS_${name}`);
  }
  const status = Number(match[1]);
  console.log(`DIAG_RESULT ${name} ${status}`);
  return status;
}

function workerSource(options: { terminate: boolean; exitListener: boolean }): string {
  return [
    "const {Worker}=require('worker_threads');",
    "const sab=new SharedArrayBuffer(8);",
    "const view=new Int32Array(sab);",
    "const worker=new Worker('const view=new Int32Array(workerData); Atomics.store(view,0,42); Atomics.store(view,1,1); Atomics.notify(view,1);',{eval:true,workerData:sab});",
    "if(Atomics.load(view,1)===0) Atomics.wait(view,1,0,5000);",
    "if(Atomics.load(view,1)!==1) throw new Error('worker did not finish');",
    "console.log('DIAG_WORKER_VALUE', Atomics.load(view,0));",
    options.exitListener ? "worker.on('exit', code => console.log('DIAG_WORKER_EXIT', code));" : "",
    options.terminate ? "console.log('DIAG_TERMINATE_BEFORE');" : "",
    options.terminate ? "const terminateResult=worker.terminate();" : "",
    options.terminate ? "console.log('DIAG_TERMINATE_AFTER', terminateResult);" : "",
    "console.log('DIAG_WORKER_DONE');",
  ].filter(Boolean).join(" ");
}

test("browser Node worker crash matrix", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/?demo=node", { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => document.body.innerText), { timeout: 180_000 }).toContain("Ready");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(
    page,
    /(worker\s+42|Segmentation fault)[\s\S]*spidermonkey-node\$ ?/,
    240_000,
  );

  const cases: Array<[string, string]> = [
    ["SIMPLE", "console.log('DIAG_SIMPLE_BODY')"],
    ["SAB_ONLY", "const sab=new SharedArrayBuffer(8); console.log('DIAG_SAB_ONLY', sab.byteLength);"],
    ["SAB_STORE", "const sab=new SharedArrayBuffer(8); const view=new Int32Array(sab); Atomics.store(view,0,42); console.log('DIAG_SAB_STORE', Atomics.load(view,0));"],
    ["SAB_NOTIFY", "const sab=new SharedArrayBuffer(8); const view=new Int32Array(sab); Atomics.store(view,1,1); Atomics.notify(view,1); console.log('DIAG_SAB_NOTIFY');"],
    ["WORKER_NO_TERMINATE", workerSource({ terminate: false, exitListener: false })],
    ["WORKER_TERMINATE", workerSource({ terminate: true, exitListener: false })],
    ["WORKER_TERMINATE_LISTENER", workerSource({ terminate: true, exitListener: true })],
  ];

  const results: Array<{ name: string; status: number }> = [];
  for (const [name, source] of cases) {
    results.push({ name, status: await runNodeStatusCase(page, name, source, 120_000) });
  }

  console.log(`DIAG_SUMMARY ${JSON.stringify(results)}`);
  expect(results.filter((result) => result.status !== 0)).toEqual([]);

  console.log(await terminalText(page));
});
TS
trap 'rm -f apps/browser-demos/test/browser-node-diagnostics.generated.spec.ts' EXIT

set +e
(
    cd apps/browser-demos
    KANDELO_PLAYWRIGHT_PORT="${KANDELO_PLAYWRIGHT_PORT:-5581}" \
        npx playwright test test/browser-node-diagnostics.generated.spec.ts \
            --project=chromium \
            --workers=1 \
            --trace=on \
            --output "$OUT_DIR/playwright-targeted-output"
) 2>&1 | tee "$OUT_DIR/playwright-targeted.log"
targeted_rc="${PIPESTATUS[0]}"
set -e

record_node_assets "after targeted playwright"

if [ "$targeted_rc" -ne 0 ]; then
    exit "$targeted_rc"
fi

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
repeat_rc="${PIPESTATUS[0]}"
set -e

record_node_assets "after playwright"

exit "$repeat_rc"
