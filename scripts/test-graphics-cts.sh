#!/usr/bin/env bash
# Run a complete bounded upstream group through normal admitted browser artifacts.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "${PWDEBUG:-}" && "${PWDEBUG}" != 0 ]]; then
    echo "Graphics CTS requires PWDEBUG unset or 0 to keep browser checks headless." >&2
    exit 2
fi
config_arguments=(--config playwright.graphics-cts.config.ts)
for argument in "$@"; do
    case "$argument" in
        --headed|--headed=*|--ui|--ui=*|--debug)
            echo "Graphics CTS uses headless Playwright; interactive launch flags are unsupported." >&2
            exit 2
            ;;
        --config|--config=*|-c)
            config_arguments=()
            ;;
    esac
done
node --test "$repo_root/tests/graphics/cts-qpa.test.mjs" "$repo_root/tests/graphics/cts-retirement.test.mjs" \
    "$repo_root/tests/graphics/cts-plan.test.mjs" "$repo_root/tests/graphics/cts-accounting.test.mjs"
cd "$repo_root/apps/browser-demos"
exec node node_modules/@playwright/test/cli.js test \
    test/graphics-cts-gles2.spec.ts --workers 1 --retries 0 \
    "${config_arguments[@]}" "$@"
