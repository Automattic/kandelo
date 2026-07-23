#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bash scripts/test-pages-publish-size.sh
bash scripts/test-pages-run-freshness.sh
bash scripts/test-pages-deployment-contract.sh
npx tsx scripts/ci-check-browser-assets.ts
