#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/prepare-merge.yml"

grep -Fq 'name: Reject durable publication from a stacked PR' "$WORKFLOW"
grep -Fq 'if: github.event.pull_request.base.ref != github.event.repository.default_branch' "$WORKFLOW"
grep -Fq 'durable package releases may only be published from a PR targeting the default branch' "$WORKFLOW"
grep -Fq 'if: failure() && github.event.pull_request.base.ref == github.event.repository.default_branch' "$WORKFLOW"

echo 'prepare-merge default-base policy test passed'
