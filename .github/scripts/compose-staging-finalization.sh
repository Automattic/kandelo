#!/usr/bin/env bash
# Compose one complete PR-staging release from a verified canonical snapshot
# and the immutable package artifacts produced by this workflow run.
set -euo pipefail

TARGET_TAG=""
EXPECTED_LEDGER=""
MATRIX=""
ARTIFACTS_DIR=""
BASELINE_DIR=""
OUTPUT_DIR=""
XTASK=""
ABI=""
BUILT_AT=""
BUILT_BY=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-tag) TARGET_TAG="$2"; shift 2 ;;
    --expected-ledger) EXPECTED_LEDGER="$2"; shift 2 ;;
    --matrix) MATRIX="$2"; shift 2 ;;
    --artifacts-dir) ARTIFACTS_DIR="$2"; shift 2 ;;
    --baseline-dir) BASELINE_DIR="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --xtask) XTASK="$2"; shift 2 ;;
    --abi) ABI="$2"; shift 2 ;;
    --built-at) BUILT_AT="$2"; shift 2 ;;
    --built-by) BUILT_BY="$2"; shift 2 ;;
    *) echo "compose-staging-finalization: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$TARGET_TAG" =~ ^pr-[1-9][0-9]*-staging$ ]] ||
   [ ! -f "$EXPECTED_LEDGER" ] || [ ! -f "$MATRIX" ] ||
   [ ! -d "$ARTIFACTS_DIR" ] || [ ! -x "$XTASK" ] ||
   ! [[ "$ABI" =~ ^[1-9][0-9]*$ ]] ||
   [ -z "$BUILT_AT" ] || [ -z "$BUILT_BY" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ] || [ -e "$OUTPUT_DIR" ]; then
  echo "compose-staging-finalization: valid target, ledgers, artifacts, xtask, ABI, provenance, and new output are required" >&2
  exit 2
fi
if [ -n "$BASELINE_DIR" ] &&
   { [ ! -f "$BASELINE_DIR/archives/index.toml" ] || [ ! -d "$BASELINE_DIR/archives" ]; }; then
  echo "compose-staging-finalization: --baseline-dir must be a materialized verified snapshot" >&2
  exit 2
fi

if ! jq -e '
    type == "array" and
    all(.[];
      (.package | type == "string" and test("^[A-Za-z0-9._+-]+$")) and
      (.arch == "wasm32" or .arch == "wasm64") and
      (.sha | type == "string" and test("^[0-9a-f]{64}$")) and
      (.version | type == "string" and length > 0) and
      (.revision | type == "number" and . >= 1 and floor == .))
  ' "$MATRIX" >/dev/null; then
  echo "compose-staging-finalization: matrix is malformed" >&2
  exit 2
fi
if [ "$(jq 'length' "$MATRIX")" != "$(jq 'unique_by([.package, .arch]) | length' "$MATRIX")" ]; then
  echo "compose-staging-finalization: matrix contains duplicate package/arch entries" >&2
  exit 2
fi
if ! jq -e --slurpfile matrix "$MATRIX" '
    .entries as $expected |
    all($matrix[0][];
      . as $selected |
      any($expected[];
        .package == $selected.package and
        .arch == $selected.arch and
        .version == $selected.version and
        .revision == $selected.revision and
        .cache_key_sha == $selected.sha))
  ' "$EXPECTED_LEDGER" >/dev/null; then
  echo "compose-staging-finalization: matrix identity differs from the current expected ledger" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR/archives"
INDEX="$OUTPUT_DIR/index.toml"
if [ -n "$BASELINE_DIR" ]; then
  "$XTASK" staging-reuse trim-index \
    --expected-ledger "$EXPECTED_LEDGER" \
    --index "$BASELINE_DIR/archives/index.toml" \
    --output "$INDEX"
  # WHY: only the final asset plan is published. Copying the verified
  # baseline bytes locally lets the validator select legitimate current or
  # fallback references without making every canonical asset part of the PR.
  find "$BASELINE_DIR/archives" -maxdepth 1 -type f -name '*.tar.zst' -print0 |
    while IFS= read -r -d '' archive; do
      cp "$archive" "$OUTPUT_DIR/archives/$(basename "$archive")"
    done
else
  cat >"$INDEX" <<EOF
abi_version = $ABI
generated_at = "$BUILT_AT"
generator = "compose-staging-finalization empty baseline"
EOF
fi

STATUS_ENTRIES="$OUTPUT_DIR/status-entries.jsonl"
: >"$STATUS_ENTRIES"
HAD_FAILURES=0

while IFS= read -r selected; do
  package="$(jq -r .package <<<"$selected")"
  arch="$(jq -r .arch <<<"$selected")"
  sha="$(jq -r .sha <<<"$selected")"
  version="$(jq -r .version <<<"$selected")"
  revision="$(jq -r .revision <<<"$selected")"
  artifact_name="${package}-${arch}"
  expected_name="${package}-${version}-rev${revision}-abi${ABI}-${arch}-${sha:0:8}.tar.zst"
  artifact_dir="$ARTIFACTS_DIR/$artifact_name"
  error=""
  source_archive=""

  if [ -d "$artifact_dir" ]; then
    candidate_count="$(
      find "$artifact_dir" -maxdepth 1 -type f -name '*.tar.zst' -print |
        wc -l | tr -d '[:space:]'
    )"
    if [ "$candidate_count" -eq 1 ]; then
      source_archive="$(
        find "$artifact_dir" -maxdepth 1 -type f -name '*.tar.zst' -print -quit
      )"
      if [ "$(basename "$source_archive")" != "$expected_name" ]; then
        error="workflow artifact filename does not match the preflight identity"
      fi
    elif [ "$candidate_count" -eq 0 ]; then
      error="workflow artifact contains no package archive"
    else
      error="workflow artifact contains multiple package archives"
    fi
  else
    error="matrix build produced no workflow artifact"
  fi

  if [ -z "$error" ]; then
    cp "$source_archive" "$OUTPUT_DIR/archives/$expected_name"
    update_error="$OUTPUT_DIR/.index-update-${package}-${arch}.log"
    if "$XTASK" index-update \
        --index-path "$INDEX" \
        --package "$package" \
        --version "$version" \
        --revision "$revision" \
        --arch "$arch" \
        --status success \
        --archive-path "$OUTPUT_DIR/archives/$expected_name" \
        --archive-name "$expected_name" \
        --cache-key-sha "$sha" \
        --expected-abi "$ABI" \
        --replace-package-version true \
        --built-at "$BUILT_AT" \
        --built-by "$BUILT_BY" 2>"$update_error"; then
      rm -f "$update_error"
      jq -nc --arg name "$package" --arg arch "$arch" --arg sha "$sha" \
        '{name:$name,arch:$arch,status:"built",sha:$sha}' >>"$STATUS_ENTRIES"
      continue
    fi
    error="archive failed exact identity or provenance validation: $(tr '\n' ' ' <"$update_error")"
    rm -f "$update_error" "$OUTPUT_DIR/archives/$expected_name"
  fi

  HAD_FAILURES=1
  "$XTASK" index-update \
    --index-path "$INDEX" \
    --package "$package" \
    --version "$version" \
    --revision "$revision" \
    --arch "$arch" \
    --status failed \
    --error "$error" \
    --expected-abi "$ABI" \
    --replace-package-version true \
    --built-at "$BUILT_AT" \
    --built-by "$BUILT_BY"
  jq -nc --arg name "$package" --arg arch "$arch" --arg error "$error" \
    '{name:$name,arch:$arch,status:"failed",error:$error}' >>"$STATUS_ENTRIES"
done < <(jq -c 'sort_by(.package, .arch)[]' "$MATRIX")

"$XTASK" staging-reuse finalize-validate \
  --expected-ledger "$EXPECTED_LEDGER" \
  --index "$INDEX" \
  --archives-dir "$OUTPUT_DIR/archives" \
  --allow-failed true \
  --output-assets "$OUTPUT_DIR/assets.json"

jq -s --argjson abi "$ABI" --arg tag "$TARGET_TAG" \
  '{abi_version:$abi,release_tag:$tag,packages:.}' \
  "$STATUS_ENTRIES" >"$OUTPUT_DIR/publish-status.json"
rm -f "$STATUS_ENTRIES"
printf '%s\n' "$HAD_FAILURES" >"$OUTPUT_DIR/had-failures"

echo "compose-staging-finalization: composed $(jq 'length' "$OUTPUT_DIR/assets.json") referenced assets for $TARGET_TAG"
