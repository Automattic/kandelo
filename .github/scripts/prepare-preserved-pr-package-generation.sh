#!/usr/bin/env bash
# Preserve one exact, same-run package closure without admitting it as a
# main-compatible package generation. The filename is retained because public
# workflow history refers to it; canonical Force rebuilds are supported too.
set -euo pipefail

SOURCE_TAG=""
SOURCE_RUN_ID=""
PACKAGE_SOURCE_ROOT=""
PACKAGE_SOURCE_SHA=""
AUTHORITY_SHA=""
EXPECTED_ABI=""
ROOT_PACKAGE="rootfs"
ARCH="wasm32"
REPOSITORY=""
OUTPUT_DIR=""
AUTHORITY_XTASK=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-tag) SOURCE_TAG="$2"; shift 2 ;;
    --source-run-id) SOURCE_RUN_ID="$2"; shift 2 ;;
    --package-source-root) PACKAGE_SOURCE_ROOT="$2"; shift 2 ;;
    --package-source-sha) PACKAGE_SOURCE_SHA="$2"; shift 2 ;;
    --authority-sha) AUTHORITY_SHA="$2"; shift 2 ;;
    --expected-abi) EXPECTED_ABI="$2"; shift 2 ;;
    --root-package) ROOT_PACKAGE="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --repository) REPOSITORY="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --authority-xtask) AUTHORITY_XTASK="$2"; shift 2 ;;
    *)
      echo "prepare-preserved-pr-package-generation: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$SOURCE_TAG" =~ ^(pr-[1-9][0-9]*-staging(-run-[1-9][0-9]*-attempt-[1-9][0-9]*)?|binaries-abi-v[1-9][0-9]*)$ ]] ||
   ! [[ "$SOURCE_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$PACKAGE_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$ROOT_PACKAGE" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
   ! [[ "$ARCH" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
   [ "$REPOSITORY" != "Automattic/kandelo" ] ||
   [ ! -d "$PACKAGE_SOURCE_ROOT" ] || [ -L "$PACKAGE_SOURCE_ROOT" ] ||
   [ ! -f "$AUTHORITY_XTASK" ] || [ -L "$AUTHORITY_XTASK" ] ||
   [ ! -x "$AUTHORITY_XTASK" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ]; then
  echo "prepare-preserved-pr-package-generation: exact source tag/run/SHA, authority, ABI, package selection, repository, checkout, xtask, and output are required" \
    >&2
  exit 2
fi
if [ -e "$OUTPUT_DIR" ] || [ -L "$OUTPUT_DIR" ]; then
  echo "prepare-preserved-pr-package-generation: output already exists: $OUTPUT_DIR" >&2
  exit 2
fi
if [ "${GITHUB_SERVER_URL:-https://github.com}" != "https://github.com" ]; then
  echo "prepare-preserved-pr-package-generation: only github.com identities are supported" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTHORITY_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
if [ "$(git -C "$AUTHORITY_ROOT" rev-parse HEAD)" != "$AUTHORITY_SHA" ]; then
  echo "prepare-preserved-pr-package-generation: current authority checkout is not the declared SHA" \
    >&2
  exit 2
fi
if [ "$(git -C "$PACKAGE_SOURCE_ROOT" rev-parse HEAD)" != "$PACKAGE_SOURCE_SHA" ] ||
   [ -n "$(git -C "$PACKAGE_SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "prepare-preserved-pr-package-generation: package-source checkout is not the exact clean SHA" \
    >&2
  exit 2
fi
if [[ "$SOURCE_TAG" =~ ^binaries-abi-v ]] &&
   ! git -C "$AUTHORITY_ROOT" merge-base --is-ancestor \
     "$PACKAGE_SOURCE_SHA" "$AUTHORITY_SHA"; then
  # WHY: a canonical Force rebuild is trusted as historical main output only
  # while protected current main still contains its exact producer. The v2
  # release targets current authority to avoid GitHub's historical-workflow
  # write restriction; its manifest continues to bind the older producer.
  echo "prepare-preserved-pr-package-generation: canonical producer is not an ancestor of current authority" >&2
  exit 1
fi
grep -Fxq "pub const ABI_VERSION: u32 = $EXPECTED_ABI;" \
  "$PACKAGE_SOURCE_ROOT/crates/shared/src/lib.rs" || {
  echo "prepare-preserved-pr-package-generation: package-source checkout does not declare the selected ABI" \
    >&2
  exit 1
}

PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$PARENT"
TMP_ROOT="$(mktemp -d "$PARENT/.preserved-package-generation.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir "$TMP_ROOT/release-archives" "$TMP_ROOT/run-archives" "$TMP_ROOT/supporting"

run_authority_xtask_without_credentials() {
  # WHY: the producer checkout is untrusted inert input. Only the
  # reviewed current-main authority computes identities and parses archives;
  # it runs with the producer checkout only as its data root and never receives
  # the token used to read GitHub metadata and artifacts.
  (
    cd "$AUTHORITY_ROOT"
    env -u GH_TOKEN -u GITHUB_TOKEN \
      -u HOMEBREW_GITHUB_API_TOKEN \
      -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
      -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_URL \
      -u ACTIONS_RUNTIME_TOKEN \
      "$AUTHORITY_XTASK" "$@"
  )
}

run_authority_xtask_without_credentials staging-reuse scan-source \
  --source-root "$PACKAGE_SOURCE_ROOT" \
  --expected-abi "$EXPECTED_ABI" \
  --arch "$ARCH" \
  --root-package "$ROOT_PACKAGE" \
  --projection-output "$TMP_ROOT/projection.json" \
  --expected-output "$TMP_ROOT/expected.json"
fetch_source_state() {
  local prefix="$1" release_id root_job_id
  gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG" \
    >"$TMP_ROOT/$prefix-release.json"
  release_id="$(jq -er '.id | select(type == "number" and . > 0)' \
    "$TMP_ROOT/$prefix-release.json")"
  gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG" \
    >"$TMP_ROOT/$prefix-tag.json"
  gh api --paginate --slurp \
    "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100" \
    >"$TMP_ROOT/$prefix-release-asset-pages.json"
  jq -e 'type == "array" and all(.[]; type == "array")' \
    "$TMP_ROOT/$prefix-release-asset-pages.json" >/dev/null
  jq '[.[][]]' "$TMP_ROOT/$prefix-release-asset-pages.json" \
    >"$TMP_ROOT/$prefix-release-assets.json"

  gh api "/repos/$REPOSITORY/actions/runs/$SOURCE_RUN_ID" \
    >"$TMP_ROOT/$prefix-run.json"
  gh api --paginate --slurp \
    "/repos/$REPOSITORY/actions/runs/$SOURCE_RUN_ID/jobs?per_page=100" \
    >"$TMP_ROOT/$prefix-job-pages.json"
  jq -e 'type == "array" and all(.[]; .jobs | type == "array")' \
    "$TMP_ROOT/$prefix-job-pages.json" >/dev/null
  jq '[.[].jobs[]]' "$TMP_ROOT/$prefix-job-pages.json" \
    >"$TMP_ROOT/$prefix-jobs.json"
  gh api --paginate --slurp \
    "/repos/$REPOSITORY/actions/runs/$SOURCE_RUN_ID/artifacts?per_page=100" \
    >"$TMP_ROOT/$prefix-artifact-pages.json"
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
  gh api "/repos/$REPOSITORY/actions/jobs/$root_job_id/logs" \
    >"$TMP_ROOT/$prefix-root-package-job.log"
}

fetch_source_state before

PYTHONDONTWRITEBYTECODE=1 \
  python3 "$SCRIPT_DIR/package-generation.py" select-source-assets \
    --source-tag "$SOURCE_TAG" \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --release-assets "$TMP_ROOT/before-release-assets.json" \
    --snapshot-out "$TMP_ROOT/snapshot.json" \
    --selected-assets-out "$TMP_ROOT/selected-release-assets.json"

while IFS=$'\t' read -r asset_id asset_name; do
  gh api "/repos/$REPOSITORY/releases/assets/$asset_id" \
    -H "Accept: application/octet-stream" \
    >"$TMP_ROOT/release-archives/$asset_name"
done < <(
  jq -r '.[] | [.id,.name] | @tsv' "$TMP_ROOT/selected-release-assets.json"
)

while IFS= read -r artifact_name; do
  mkdir "$TMP_ROOT/run-archives/$artifact_name"
  gh run download "$SOURCE_RUN_ID" \
    --repo "$REPOSITORY" \
    --name "$artifact_name" \
    --dir "$TMP_ROOT/run-archives/$artifact_name"
done < <(
  jq -r '.entries[] | "\(.package)-\(.arch)"' \
    "$TMP_ROOT/projection.json"
)

capture_source() {
  local prefix="$1" output="$2"
  PYTHONDONTWRITEBYTECODE=1 \
    python3 "$SCRIPT_DIR/package-generation.py" capture-source \
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
      --capture-out "$output"
}

capture_source before "$TMP_ROOT/source-capture-before.json"

# Current authority validates the complete selected ledger and every archive
# manifest while treating the producer checkout only as inert registry data.
# Both preparation and the writer require exact repository+commit producer
# provenance.
run_authority_xtask_without_credentials staging-reuse validate-archives \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/snapshot.json" \
  --archives-dir "$TMP_ROOT/release-archives" \
  --scope all \
  --expected-source-repository "https://github.com/$REPOSITORY" \
  --expected-source-commit "$PACKAGE_SOURCE_SHA"

# WHY: a mutable source index contains unrelated matrix entries. Rebuilding
# an index from only the validated archives makes the preserved closure
# independent of later unrelated uploads.
run_authority_xtask_without_credentials build-index \
  --abi "$EXPECTED_ABI" \
  --generator "Preserved package closure from $PACKAGE_SOURCE_SHA" \
  --archives-dir "$TMP_ROOT/release-archives" \
  --out "$TMP_ROOT/minimal-index.toml" \
  --generated-at "1970-01-01T00:00:00Z"

if grep -E '^fallback_[A-Za-z0-9_]*[[:space:]]*=' \
     "$TMP_ROOT/minimal-index.toml" >/dev/null ||
   grep -F "$SOURCE_TAG" "$TMP_ROOT/minimal-index.toml" >/dev/null ||
   grep -E '^archive_url = "([^"]*[/]|https?:)' \
     "$TMP_ROOT/minimal-index.toml" >/dev/null; then
  echo "prepare-preserved-pr-package-generation: minimal index retained a non-local archive URL" >&2
  exit 1
fi

# Re-fetch only the selected source anchors. Unrelated matrix jobs and release
# assets may continue changing; they are intentionally outside this closure.
fetch_source_state after
capture_source after "$TMP_ROOT/source-capture-after.json"
if ! cmp \
  "$TMP_ROOT/source-capture-before.json" \
  "$TMP_ROOT/source-capture-after.json" >/dev/null; then
  echo "prepare-preserved-pr-package-generation: selected source identity changed during validation" \
    >&2
  exit 1
fi

source_capture_format="$(jq -er .format \
  "$TMP_ROOT/source-capture-after.json")"
case "$source_capture_format" in
  kandelo-preserved-pr-source-capture-v1)
    supporting_log_name="rootfs-job.log"
    ;;
  kandelo-preserved-package-source-capture-v2)
    supporting_log_name="root-package-job.log"
    ;;
  *)
    echo "prepare-preserved-pr-package-generation: unsupported source capture format" >&2
    exit 1
    ;;
esac
cp "$TMP_ROOT/after-root-package-job.log" \
  "$TMP_ROOT/supporting/$supporting_log_name"
PYTHONDONTWRITEBYTECODE=1 \
  python3 "$SCRIPT_DIR/package-generation.py" prepare-preserved \
    --repository "$REPOSITORY" \
    --package-source-sha "$PACKAGE_SOURCE_SHA" \
    --authority-sha "$AUTHORITY_SHA" \
    --source-capture "$TMP_ROOT/source-capture-after.json" \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/snapshot.json" \
    --localized-index "$TMP_ROOT/minimal-index.toml" \
    --archives-dir "$TMP_ROOT/release-archives" \
    --supporting-assets-dir "$TMP_ROOT/supporting" \
    --output-dir "$TMP_ROOT/output"

mv "$TMP_ROOT/output" "$OUTPUT_DIR"
rm -rf "$TMP_ROOT"
trap - EXIT
echo "prepare-preserved-pr-package-generation: prepared $(jq -r .tag "$OUTPUT_DIR/generation.json")"
