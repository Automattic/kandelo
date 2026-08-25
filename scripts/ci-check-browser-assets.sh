#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bash scripts/test-pages-publish-size.sh
# The production Pages workflow and its freshness/deployment contracts are
# dormant with the retired ABI/Homebrew publication stack. Keep checking the
# consumer-owned site size and browser assets, but do not make the active
# browser suite execute contracts for an intentionally disabled workflow.
npx tsx scripts/check-browser-memory64-example-fixtures.ts
npx tsx scripts/ci-check-browser-assets.ts
