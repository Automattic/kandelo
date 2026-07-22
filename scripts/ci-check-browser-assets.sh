#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bash scripts/ci-check-pages-deployment.sh
npx tsx scripts/ci-check-browser-assets.ts
