#!/usr/bin/env bash
# Fail if any build path links an executable with --allow-undefined.
#
# Since ABI 46 an executable may leave undefined only the imports the host
# supplies, listed in the generated libc/glue/kandelo-host-imports.txt and
# passed with --allow-undefined-file. --allow-undefined accepts every missing
# function, which made configure checks lie and let programs ship calls that
# trap at run time. Tests that assert on the flag are not links and are
# skipped. Side modules may keep it — their symbols are resolved by
# the dynamic loader at dlopen — on a line marked
#   side-module: dynamic linking resolves at dlopen
#
#   check-no-allow-undefined.sh [repo-root]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
hits="$(
    cd "$ROOT" &&
    grep -rnE -- '--allow-undefined([^-]|$)' \
        --include='*.sh' --include='*.ts' --include='*.rs' --include='*.cmake' \
        --include='*.toml' --include='*.mjs' --include='*.js' --include='*.py' \
        --include='wasm32posix-*' --include='wasm64posix-*' --include='config.site*' \
        --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target \
        --exclude-dir='*-src' --exclude-dir='*-build' --exclude-dir='*-install' \
        scripts sdk packages tools images 2>/dev/null |
    grep -vE ':[0-9]+:[[:space:]]*(#|//|\*)' |
    grep -vE '(\.test\.ts|/test-[^/:]*\.sh):[0-9]+:' |
    grep -v 'side-module: dynamic linking resolves at dlopen' |
    grep -v 'check-no-allow-undefined' || true
)"
if [ -n "$hits" ]; then
    echo "check-no-allow-undefined: executables must link with --allow-undefined-file=<glue>/kandelo-host-imports.txt:" >&2
    printf '%s\n' "$hits" >&2
    exit 1
fi
echo "check-no-allow-undefined: ok"
