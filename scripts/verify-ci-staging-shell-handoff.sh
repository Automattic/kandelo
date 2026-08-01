#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

receipt="${1:-}"
image="${2:-}"
report="${3:-}"
expected_base="${4:-}"
expected_head="${5:-}"
expected_tree="${6:-}"
expected_run_id="${7:-}"
if [ "$#" -ne 7 ]; then
    echo "usage: $0 <receipt.json> <shell.vfs.zst> <report.json> <expected-base-sha> <expected-head-sha> <expected-tree-sha> <expected-run-id>" >&2
    exit 2
fi

require_regular_file() {
    local label="$1"
    local path="$2"
    if [ ! -f "$path" ] || [ -L "$path" ]; then
        echo "verify-ci-staging-shell-handoff: $label must be a regular non-symlink file: $path" >&2
        exit 1
    fi
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

require_regular_file receipt "$receipt"
require_regular_file "shell image" "$image"
require_regular_file report "$report"
if ! [[ "$expected_base" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$expected_head" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$expected_tree" =~ ^[0-9a-f]{40}$ ]]; then
    echo "verify-ci-staging-shell-handoff: expected Git identity is not a full lowercase SHA" >&2
    exit 2
fi
if ! [[ "$expected_run_id" =~ ^[1-9][0-9]*$ ]]; then
    echo "verify-ci-staging-shell-handoff: expected run ID is not a positive integer" >&2
    exit 2
fi

abi="$(
    grep -oE 'ABI_VERSION: u32 = [0-9]+' \
        crates/shared/src/lib.rs | awk '{print $4}'
)"
if ! [[ "$abi" =~ ^[0-9]+$ ]]; then
    echo "verify-ci-staging-shell-handoff: could not read the current ABI" >&2
    exit 1
fi
repository="${GITHUB_REPOSITORY:-Automattic/kandelo}"

# WHY: the report's Kandelo commit identifies the older producer that built
# reusable bottle bytes. It is not the PR checkout that composed and tested
# this shell. The receipt separately names the immutable producer head/tree
# and the current validation base. Requiring the producer tree to equal the
# synthetic-merge tree proves that the tested bytes match this checkout
# without pretending GitHub's mutable PR projection is historical evidence.
if ! jq -e \
    --arg repository "$repository" \
    --argjson abi "$abi" '
      type == "object" and
      .schema == 1 and
      .image == "main-shell.vfs.zst" and
      .metadata.kandelo_repository == $repository and
      .metadata.kandelo_abi == $abi and
      (.package_deferred_trees | type == "array" and length > 0) and
      any(.package_deferred_trees[];
        .state == "deferred" and
        (.package.name | type == "string" and length > 0)
      ) and
      (.bottle_mirror.assets | type == "array" and length > 0)
    ' "$report" >/dev/null; then
    echo "verify-ci-staging-shell-handoff: report is not a bottle-composed shell contract" >&2
    exit 1
fi

if ! jq -e \
    --arg repository "$repository" \
    --arg base "$expected_base" \
    --arg head "$expected_head" \
    --arg tree "$expected_tree" \
    --argjson run_id "$expected_run_id" '
      type == "object" and
      (keys | sort) == ([
        "artifact", "image", "kind", "producer_head_sha",
        "producer_tree_sha", "report", "repository", "run_id", "schema",
        "validation_base_sha", "validation_pull_request_number", "workflow"
      ] | sort) and
      .schema == 1 and
      .kind == "kandelo-ci-staging-shell-handoff" and
      .repository == $repository and
      .workflow == ".github/workflows/staging-build.yml" and
      .validation_base_sha == $base and
      .producer_head_sha == $head and
      .producer_tree_sha == $tree and
      (.validation_pull_request_number |
        type == "number" and . >= 1 and floor == .) and
      .run_id == $run_id and
      (.artifact | type == "object") and
      (.artifact | keys | sort) == ([
        "archive_sha256", "bytes", "id", "name"
      ] | sort) and
      (.artifact.id | type == "number" and . >= 1 and floor == .) and
      .artifact.name == "homebrew-main-shell-closure" and
      (.artifact.archive_sha256 |
        type == "string" and test("^[0-9a-f]{64}$")) and
      (.artifact.bytes | type == "number" and . >= 1 and floor == .) and
      (.image | type == "object") and
      (.image | keys | sort) == ["bytes", "sha256"] and
      (.image.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.image.bytes | type == "number" and . >= 1 and floor == .) and
      (.report | type == "object") and
      (.report | keys | sort) == ["bytes", "sha256"] and
      (.report.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.report.bytes | type == "number" and . >= 1 and floor == .)
    ' "$receipt" >/dev/null; then
    echo "verify-ci-staging-shell-handoff: receipt does not match the expected staging run" >&2
    exit 1
fi

expected_image_sha="$(jq -er '.image.sha256' "$receipt")"
expected_image_bytes="$(jq -er '.image.bytes' "$receipt")"
actual_image_sha="$(sha256_file "$image")"
actual_image_bytes="$(wc -c <"$image" | tr -d '[:space:]')"
if [ "$actual_image_sha" != "$expected_image_sha" ] ||
   [ "$actual_image_bytes" != "$expected_image_bytes" ]; then
    echo "verify-ci-staging-shell-handoff: shell image differs from its receipt" >&2
    exit 1
fi

expected_report_sha="$(jq -er '.report.sha256' "$receipt")"
expected_report_bytes="$(jq -er '.report.bytes' "$receipt")"
actual_report_sha="$(sha256_file "$report")"
actual_report_bytes="$(wc -c <"$report" | tr -d '[:space:]')"
if [ "$actual_report_sha" != "$expected_report_sha" ] ||
   [ "$actual_report_bytes" != "$expected_report_bytes" ]; then
    echo "verify-ci-staging-shell-handoff: report differs from its receipt" >&2
    exit 1
fi

echo "Verified exact staging shell from run $expected_run_id at $expected_head"
