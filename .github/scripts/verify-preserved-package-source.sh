#!/usr/bin/env bash
# Reconstruct one preserved generation's selected source evidence using only
# current-authority code and read-only GitHub APIs. Historical v1 bundles use
# PR-specific field names; new v2 bundles use neutral source-release names.
set -euo pipefail

BUNDLE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2 ;;
    *)
      echo "verify-preserved-package-source: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$BUNDLE" ] || [ -L "$BUNDLE" ]; then
  echo "verify-preserved-package-source: a regular bundle is required" >&2
  exit 2
fi
if [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  echo "verify-preserved-package-source: a GitHub token is required" >&2
  exit 2
fi
if [ "${GITHUB_SERVER_URL:-https://github.com}" != "https://github.com" ]; then
  echo "verify-preserved-package-source: only github.com is supported" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$BUNDLE/generation.json"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir "$TMP_ROOT/release-archives" "$TMP_ROOT/run-archives"
RETRY_DELAY="${PACKAGE_GENERATION_RETRY_DELAY_SECONDS:-2}"
if ! [[ "$RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  echo "verify-preserved-package-source: retry delay must be non-negative" >&2
  exit 2
fi

retry_to_file() {
  local output="$1" attempt temporary
  shift
  for attempt in 1 2 3 4; do
    temporary="$output.attempt-$attempt"
    if "$@" >"$temporary"; then
      mv "$temporary" "$output"
      return 0
    fi
    rm -f "$temporary"
    if [ "$attempt" -lt 4 ] && [ "$RETRY_DELAY" -gt 0 ]; then
      sleep "$RETRY_DELAY"
    fi
  done
  echo "verify-preserved-package-source: read failed after four attempts" >&2
  return 1
}

retry_run_artifact() {
  local artifact="$1" destination="$2" attempt temporary
  for attempt in 1 2 3 4; do
    temporary="$TMP_ROOT/run-download-$artifact-$attempt"
    mkdir "$temporary"
    if gh run download "$SOURCE_RUN_ID" \
        --repo "$REPOSITORY" \
        --name "$artifact" \
        --dir "$temporary"; then
      mv "$temporary" "$destination"
      return 0
    fi
    rm -r "$temporary"
    if [ "$attempt" -lt 4 ] && [ "$RETRY_DELAY" -gt 0 ]; then
      sleep "$RETRY_DELAY"
    fi
  done
  echo "verify-preserved-package-source: artifact download failed: $artifact" >&2
  return 1
}

run_authority_python_without_credentials() {
  # WHY: current authority validates already-downloaded evidence; it never
  # needs the token used by this shell to perform read-only GitHub requests.
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    PYTHONDONTWRITEBYTECODE=1 \
    python3 "$SCRIPT_DIR/package-generation.py" "$@"
}

run_authority_python_without_credentials validate \
  --bundle "$BUNDLE" >/dev/null
MANIFEST_FORMAT="$(jq -r .format "$MANIFEST")"
if [ "$MANIFEST_FORMAT" != "kandelo-preserved-pr-package-generation-v1" ] &&
   [ "$MANIFEST_FORMAT" != "kandelo-preserved-package-generation-v2" ]; then
  echo "verify-preserved-package-source: bundle is not a preserved package generation" >&2
  exit 2
fi

REPOSITORY="$(jq -er .identity.repository "$MANIFEST")"
PACKAGE_SOURCE_SHA="$(jq -er .identity.package_source_sha "$MANIFEST")"
SOURCE_TAG="$(jq -er \
  '.identity.source_capture | (.source_release // .source_staging).tag' \
  "$MANIFEST")"
SOURCE_CAPTURE_FORMAT="$(jq -er .identity.source_capture.format "$MANIFEST")"
SOURCE_RUN_ID="$(jq -er .identity.source_capture.source_run.id "$MANIFEST")"
ROOT_PACKAGE="$(jq -er .identity.projection.root_package "$MANIFEST")"
ARCH="$(jq -er .identity.projection.arch "$MANIFEST")"
if [ -n "${GITHUB_REPOSITORY:-}" ] &&
   [ "$GITHUB_REPOSITORY" != "$REPOSITORY" ]; then
  echo "verify-preserved-package-source: workflow repository differs from bundle" >&2
  exit 2
fi

jq -S .identity.projection "$MANIFEST" >"$TMP_ROOT/projection.json"
jq -S .identity.expected_ledger "$MANIFEST" >"$TMP_ROOT/expected.json"
jq -S .identity.validated_snapshot "$MANIFEST" >"$TMP_ROOT/snapshot.json"

fetch_source_state() {
  local prefix="$1" release_id root_job_id
  retry_to_file "$TMP_ROOT/$prefix-release.json" \
    gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG"
  release_id="$(jq -er '.id | select(type == "number" and . > 0)' \
    "$TMP_ROOT/$prefix-release.json")"
  retry_to_file "$TMP_ROOT/$prefix-tag.json" \
    gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG"
  retry_to_file "$TMP_ROOT/$prefix-release-asset-pages.json" \
    gh api --paginate --slurp \
      "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100"
  jq -e 'type == "array" and all(.[]; type == "array")' \
    "$TMP_ROOT/$prefix-release-asset-pages.json" >/dev/null
  jq '[.[][]]' "$TMP_ROOT/$prefix-release-asset-pages.json" \
    >"$TMP_ROOT/$prefix-release-assets.json"

  retry_to_file "$TMP_ROOT/$prefix-run.json" \
    gh api "/repos/$REPOSITORY/actions/runs/$SOURCE_RUN_ID"
  retry_to_file "$TMP_ROOT/$prefix-job-pages.json" \
    gh api --paginate --slurp \
      "/repos/$REPOSITORY/actions/runs/$SOURCE_RUN_ID/jobs?per_page=100"
  jq -e 'type == "array" and all(.[]; .jobs | type == "array")' \
    "$TMP_ROOT/$prefix-job-pages.json" >/dev/null
  jq '[.[].jobs[]]' "$TMP_ROOT/$prefix-job-pages.json" \
    >"$TMP_ROOT/$prefix-jobs.json"
  retry_to_file "$TMP_ROOT/$prefix-artifact-pages.json" \
    gh api --paginate --slurp \
      "/repos/$REPOSITORY/actions/runs/$SOURCE_RUN_ID/artifacts?per_page=100"
  jq -e 'type == "array" and all(.[]; .artifacts | type == "array")' \
    "$TMP_ROOT/$prefix-artifact-pages.json" >/dev/null
  jq '[.[].artifacts[]]' "$TMP_ROOT/$prefix-artifact-pages.json" \
    >"$TMP_ROOT/$prefix-run-artifacts.json"

  root_job_id="$(jq -er \
    --arg arch "$ARCH" \
    --arg package "$ROOT_PACKAGE" \
    --arg source_tag "$SOURCE_TAG" '
      [.[] |
        select(
          (if ($source_tag | startswith("binaries-abi-v")) then
             (.name | test(
               "^matrix-build-level-(0|[1-9][0-9]*) \\(" + $arch + ","
             ))
           else
             (.name | startswith("matrix-build (" + $arch + ","))
           end) and
          (.name | contains(", " + $package + ","))
        )
      ] |
      if length == 1 then .[0].id else empty end
    ' "$TMP_ROOT/$prefix-jobs.json")"
  retry_to_file "$TMP_ROOT/$prefix-root-package-job.log" \
    gh api "/repos/$REPOSITORY/actions/jobs/$root_job_id/logs"
}

capture_source() {
  local prefix="$1" output="$2"
  run_authority_python_without_credentials capture-source \
    --repository "$REPOSITORY" \
    --package-source-sha "$PACKAGE_SOURCE_SHA" \
    --source-tag "$SOURCE_TAG" \
    --run-id "$SOURCE_RUN_ID" \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/snapshot.json" \
    --release "$TMP_ROOT/$prefix-release.json" \
    --tag-ref "$TMP_ROOT/$prefix-tag.json" \
    --release-assets "$TMP_ROOT/$prefix-release-assets.json" \
    --run "$TMP_ROOT/$prefix-run.json" \
    --jobs "$TMP_ROOT/$prefix-jobs.json" \
    --run-artifacts "$TMP_ROOT/$prefix-run-artifacts.json" \
    --archives-dir "$TMP_ROOT/release-archives" \
    --run-archives-dir "$TMP_ROOT/run-archives" \
    --root-job-log "$TMP_ROOT/$prefix-root-package-job.log" \
    --capture-format "$SOURCE_CAPTURE_FORMAT" \
    --capture-out "$output"
}

fetch_source_state before
run_authority_python_without_credentials select-source-assets \
  --source-tag "$SOURCE_TAG" \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --release-assets "$TMP_ROOT/before-release-assets.json" \
  --snapshot-out "$TMP_ROOT/live-snapshot.json" \
  --selected-assets-out "$TMP_ROOT/selected-release-assets.json"
if ! jq -e --slurp '.[0] == .[1]' \
    "$TMP_ROOT/live-snapshot.json" "$TMP_ROOT/snapshot.json" >/dev/null; then
  echo "verify-preserved-package-source: selected release snapshot moved" >&2
  exit 1
fi

while IFS=$'\t' read -r asset_id asset_name; do
  retry_to_file "$TMP_ROOT/release-archives/$asset_name" \
    gh api "/repos/$REPOSITORY/releases/assets/$asset_id" \
      -H "Accept: application/octet-stream"
  if ! cmp -s \
      "$TMP_ROOT/release-archives/$asset_name" \
      "$BUNDLE/$asset_name"; then
    echo "verify-preserved-package-source: release bytes differ for $asset_name" >&2
    exit 1
  fi
done < <(
  jq -r '.[] | [.id,.name] | @tsv' "$TMP_ROOT/selected-release-assets.json"
)

while IFS= read -r artifact_name; do
  retry_run_artifact \
    "$artifact_name" "$TMP_ROOT/run-archives/$artifact_name"
done < <(
  jq -r '.entries[] | "\(.package)-\(.arch)"' "$TMP_ROOT/projection.json"
)

capture_source before "$TMP_ROOT/source-capture-before.json"
run_authority_python_without_credentials compare-source-capture \
  --generation-manifest "$MANIFEST" \
  --source-capture "$TMP_ROOT/source-capture-before.json" >/dev/null

# WHY: downloads take time while the PR staging release remains mutable.
# Re-read only the selected identity afterward so a concurrent selected
# replacement fails closed without coupling this proof to unrelated jobs.
fetch_source_state after
capture_source after "$TMP_ROOT/source-capture-after.json"
if ! cmp -s \
    "$TMP_ROOT/source-capture-before.json" \
    "$TMP_ROOT/source-capture-after.json"; then
  echo "verify-preserved-package-source: selected source identity moved" >&2
  exit 1
fi
run_authority_python_without_credentials compare-source-capture \
  --generation-manifest "$MANIFEST" \
  --source-capture "$TMP_ROOT/source-capture-after.json" >/dev/null

echo "verify-preserved-package-source: verified selected source evidence"
