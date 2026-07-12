#!/usr/bin/env bash
# Resolve exact package archives inherited through a same-repository PR stack.
#
# The caller supplies the current checkout's unresolved package requirements.
# This script authenticates every open base PR, snapshots matching release
# assets by immutable asset id, verifies their workflow provenance and archive
# contents, and writes them as <package>-<arch>/<archive>.tar.zst. Requirements
# that no authenticated staging release satisfies are intentionally omitted;
# staging-build turns those omissions into ordinary matrix rebuilds.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: resolve-stacked-pr-baseline.sh \
  --repo <owner/name> --current-pr <number> --head-sha <sha> \
  --base-ref <branch> --base-sha <sha> --default-branch <branch> \
  --abi <number> --requirements <requirements.json> \
  --output <archive-dir> --xtask <xtask-binary>
EOF
}

die() {
  echo "::error::stacked baseline: $*" >&2
  exit 1
}

notice() {
  echo "stacked baseline: $*"
}

REPO=""
CURRENT_PR=""
HEAD_SHA=""
BASE_REF=""
BASE_SHA=""
DEFAULT_BRANCH=""
ABI=""
REQUIREMENTS=""
OUTPUT=""
XTASK=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --current-pr) CURRENT_PR="${2:-}"; shift 2 ;;
    --head-sha) HEAD_SHA="${2:-}"; shift 2 ;;
    --base-ref) BASE_REF="${2:-}"; shift 2 ;;
    --base-sha) BASE_SHA="${2:-}"; shift 2 ;;
    --default-branch) DEFAULT_BRANCH="${2:-}"; shift 2 ;;
    --abi) ABI="${2:-}"; shift 2 ;;
    --requirements) REQUIREMENTS="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --xtask) XTASK="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

for value in REPO CURRENT_PR HEAD_SHA BASE_REF BASE_SHA DEFAULT_BRANCH ABI REQUIREMENTS OUTPUT XTASK; do
  [ -n "${!value}" ] || { usage; exit 2; }
done
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid repository $REPO"
[[ "$CURRENT_PR" =~ ^[1-9][0-9]*$ ]] || die "invalid current PR number $CURRENT_PR"
[[ "$ABI" =~ ^[1-9][0-9]*$ ]] || die "invalid ABI $ABI"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40,64}$ ]] || die "invalid current head SHA $HEAD_SHA"
[[ "$BASE_SHA" =~ ^[0-9a-f]{40,64}$ ]] || die "invalid current base SHA $BASE_SHA"
git check-ref-format --branch "$BASE_REF" >/dev/null 2>&1 || die "invalid base ref $BASE_REF"
git check-ref-format --branch "$DEFAULT_BRANCH" >/dev/null 2>&1 || die "invalid default branch $DEFAULT_BRANCH"
[ -f "$REQUIREMENTS" ] || die "requirements file not found: $REQUIREMENTS"
[ -x "$XTASK" ] || die "xtask binary is not executable: $XTASK"
if [ "$OUTPUT" = "/" ] || [ "$OUTPUT" = "." ] || [ "$OUTPUT" = ".." ]; then
  die "refusing unsafe output path $OUTPUT"
fi
[ ! -e "$OUTPUT" ] || die "output path already exists: $OUTPUT"
command -v jq >/dev/null 2>&1 || die "jq is required"

GH_BIN="${GH_BIN:-gh}"
SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
SELECTOR="${STACKED_BASELINE_SELECTOR:-.github/scripts/stacked_pr_baseline.py}"
PYTHON_BIN="${STACKED_BASELINE_PYTHON:-python3}"
API_ATTEMPTS="${STACKED_BASELINE_API_ATTEMPTS:-4}"
RETRY_SECONDS="${STACKED_BASELINE_RETRY_SECONDS:-2}"
OWNER="${REPO%%/*}"
[ -f "$SELECTOR" ] || die "structured index selector not found: $SELECTOR"
[[ "$API_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "invalid API attempt count $API_ATTEMPTS"
[[ "$RETRY_SECONDS" =~ ^[0-9]+$ ]] || die "invalid retry delay $RETRY_SECONDS"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/releases" "$TMP/runs" "$TMP/output"
printf '[]\n' > "$TMP/selections.json"

api_json() {
  local endpoint="$1"
  local output="$2"
  local attempt delay error_file tmp_output
  delay="$RETRY_SECONDS"
  error_file="${output}.error"
  tmp_output="${output}.tmp"
  for attempt in $(seq 1 "$API_ATTEMPTS"); do
    if "$GH_BIN" api "$endpoint" > "$tmp_output" 2> "$error_file"; then
      mv "$tmp_output" "$output"
      rm -f "$error_file"
      return 0
    fi
    if [ "$attempt" -eq "$API_ATTEMPTS" ]; then
      cat "$error_file" >&2
      rm -f "$tmp_output" "$error_file"
      return 1
    fi
    echo "::warning::GitHub API request failed for $endpoint; retrying in ${delay}s (attempt $attempt/$API_ATTEMPTS)" >&2
    sleep "$delay"
    delay=$((delay * 2))
  done
}

require_ancestor() {
  local base="$1"
  local head="$2"
  local context="$3"
  local compare="$TMP/compare-${base}-${head}.json"
  api_json "/repos/$REPO/compare/${base}...${head}" "$compare" \
    || die "could not compare $context ($base...$head)"
  local status
  status="$(jq -r '.status // ""' "$compare")"
  case "$status" in
    ahead|identical) ;;
    *) die "$context is not an ancestor relation (GitHub compare status: ${status:-missing})" ;;
  esac
}

build_chain() {
  local output="$1"
  local current="$TMP/current-pr.json"
  api_json "/repos/$REPO/pulls/$CURRENT_PR" "$current" \
    || die "could not read current PR #$CURRENT_PR"

  jq -e \
    --arg repo "$REPO" \
    --argjson number "$CURRENT_PR" \
    --arg head "$HEAD_SHA" \
    --arg base_ref "$BASE_REF" \
    --arg base_sha "$BASE_SHA" '
      .number == $number and
      .state == "open" and
      .head.repo.full_name == $repo and
      .base.repo.full_name == $repo and
      .head.sha == $head and
      .base.ref == $base_ref and
      .base.sha == $base_sha
    ' "$current" >/dev/null \
    || die "current PR #$CURRENT_PR advanced, closed, or no longer matches the event base/head"

  local expected_ref="$BASE_REF"
  local expected_sha="$BASE_SHA"
  local child_sha="$HEAD_SHA"
  local depth=0
  local chain='[]'
  while true; do
    depth=$((depth + 1))
    [ "$depth" -le 32 ] || die "base PR chain exceeds 32 entries"
    require_ancestor "$expected_sha" "$child_sha" "base $expected_ref for child $child_sha"
    if [ "$expected_ref" = "$DEFAULT_BRANCH" ]; then
      break
    fi

    local encoded_head pages matches count pr_json
    encoded_head="$(jq -rn --arg value "$OWNER:$expected_ref" '$value | @uri')"
    pages="$TMP/open-pulls-${depth}.json"
    "$GH_BIN" api --paginate --slurp \
      "/repos/$REPO/pulls?state=open&head=${encoded_head}&per_page=100" > "$pages" \
      || die "could not find the open PR owning base ref $expected_ref"
    matches="$TMP/open-pulls-${depth}-matches.json"
    jq --arg repo "$REPO" --arg ref "$expected_ref" '
      [ .[][] | select(.head.repo.full_name == $repo and .head.ref == $ref) ]
    ' "$pages" > "$matches"
    count="$(jq 'length' "$matches")"
    [ "$count" -eq 1 ] \
      || die "base ref $expected_ref must belong to exactly one open same-repo PR; found $count"
    pr_json="$TMP/base-pr-${depth}.json"
    jq '.[0]' "$matches" > "$pr_json"

    jq -e \
      --arg repo "$REPO" \
      --arg ref "$expected_ref" \
      --arg sha "$expected_sha" '
        .state == "open" and
        .head.repo.full_name == $repo and
        .base.repo.full_name == $repo and
        .head.ref == $ref and
        .head.sha == $sha and
        (.number | type == "number") and
        (.base.ref | type == "string") and
        (.base.sha | test("^[0-9a-f]{40,64}$"))
      ' "$pr_json" >/dev/null \
      || die "base PR for $expected_ref advanced or crossed the same-repo trust boundary"

    local pr_number
    pr_number="$(jq -r '.number' "$pr_json")"
    if jq -e --argjson number "$pr_number" 'any(.[]; .number == $number)' <<< "$chain" >/dev/null; then
      die "cycle detected at base PR #$pr_number"
    fi
    chain="$(jq -c --argjson entry "$(jq '{number, head_ref:.head.ref, head_sha:.head.sha, base_ref:.base.ref, base_sha:.base.sha}' "$pr_json")" '. + [$entry]' <<< "$chain")"
    child_sha="$expected_sha"
    expected_ref="$(jq -r '.base.ref' "$pr_json")"
    expected_sha="$(jq -r '.base.sha' "$pr_json")"
    git check-ref-format --branch "$expected_ref" >/dev/null 2>&1 \
      || die "base PR #$pr_number has invalid parent ref $expected_ref"
  done
  jq -S . <<< "$chain" > "$output"
}

release_snapshot() {
  jq -S '{
    id,
    tag_name,
    prerelease,
    draft,
    assets: ([.assets[] | {id, name, size, digest, updated_at}] | sort_by(.id))
  }' "$1"
}

download_asset() {
  local asset_id="$1"
  local output="$2"
  local tmp_output="${output}.tmp"
  local attempt delay error_file
  delay="$RETRY_SECONDS"
  error_file="${output}.error"
  for attempt in $(seq 1 "$API_ATTEMPTS"); do
    if "$GH_BIN" api \
      -H 'Accept: application/octet-stream' \
      "/repos/$REPO/releases/assets/$asset_id" > "$tmp_output" 2> "$error_file"
    then
      mv "$tmp_output" "$output"
      rm -f "$error_file"
      return 0
    fi
    if [ "$attempt" -eq "$API_ATTEMPTS" ]; then
      cat "$error_file" >&2
      rm -f "$tmp_output" "$error_file"
      die "could not download release asset id $asset_id"
    fi
    echo "::warning::release asset $asset_id download failed; retrying in ${delay}s (attempt $attempt/$API_ATTEMPTS)" >&2
    sleep "$delay"
    delay=$((delay * 2))
  done
}

validate_asset_size() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(wc -c < "$file" | tr -d '[:space:]')"
  [ "$actual" = "$expected" ] \
    || die "asset $(basename "$file") has size $actual, expected $expected"
}

validate_built_by_run() {
  local built_by="$1"
  local pr_number="$2"
  local pr_head_ref="$3"
  local pr_head_sha="$4"
  local prefix="${SERVER_URL%/}/$REPO/actions/runs/"
  [[ "$built_by" == "$prefix"* ]] \
    || die "base PR #$pr_number entry has foreign built_by URL $built_by"
  local run_id="${built_by#"$prefix"}"
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] \
    || die "base PR #$pr_number entry has invalid built_by run id $run_id"
  local validation_stamp="$TMP/runs/$run_id.pr-$pr_number.$pr_head_sha.valid"
  if [ -f "$validation_stamp" ]; then
    return 0
  fi

  local run_json="$TMP/runs/$run_id.json"
  if [ ! -f "$run_json" ]; then
    api_json "/repos/$REPO/actions/runs/$run_id" "$run_json" \
      || die "could not read built_by run $run_id"
  fi
  jq -e \
    --arg repo "$REPO" \
    --arg branch "$pr_head_ref" \
    --argjson pr "$pr_number" '
      .id != null and
      .event == "pull_request" and
      .path == ".github/workflows/staging-build.yml" and
      .repository.full_name == $repo and
      .head_repository.full_name == $repo and
      .head_branch == $branch and
      any(.pull_requests[]?; .number == $pr) and
      (.head_sha | test("^[0-9a-f]{40,64}$"))
    ' "$run_json" >/dev/null \
    || die "built_by run $run_id is not a same-repo staging-build run for base PR #$pr_number"
  local run_sha
  run_sha="$(jq -r '.head_sha' "$run_json")"
  require_ancestor "$run_sha" "$pr_head_sha" "built_by run $run_id for base PR #$pr_number"
  : > "$validation_stamp"
}

remove_selected_requirements() {
  local requirements="$1"
  local selected="$2"
  local output="$3"
  jq --slurpfile selected "$selected" '
    . as $requirements
    | $selected[0] as $matches
    | [
        $requirements[] as $requirement
        | select(
            ($matches | any(.package == $requirement.package and
                            .arch == $requirement.arch and
                            .sha == $requirement.sha))
            | not
          )
        | $requirement
      ]
  ' "$requirements" > "$output"
}

build_chain "$TMP/chain-before.json"
cp "$REQUIREMENTS" "$TMP/remaining.json"
jq -e 'type == "array"' "$TMP/remaining.json" >/dev/null \
  || die "requirements must be a JSON array"

while IFS= read -r encoded_entry; do
  [ "$(jq 'length' "$TMP/remaining.json")" -gt 0 ] || break
  entry="$(printf '%s' "$encoded_entry" | base64 --decode)"
  pr_number="$(jq -r '.number' <<< "$entry")"
  pr_head_ref="$(jq -r '.head_ref' <<< "$entry")"
  pr_head_sha="$(jq -r '.head_sha' <<< "$entry")"
  tag="pr-${pr_number}-staging"
  release_json="$TMP/releases/$tag.json"
  release_error="$TMP/releases/$tag.error"
  if ! "$GH_BIN" api "/repos/$REPO/releases/tags/$tag" > "$release_json" 2> "$release_error"; then
    if grep -Eqi 'HTTP 404' "$release_error"; then
      notice "$tag does not exist; unresolved keys will be rebuilt"
      continue
    fi
    cat "$release_error" >&2
    die "could not inspect $tag"
  fi
  jq -e --arg tag "$tag" '
    .tag_name == $tag and .prerelease == true and .draft == false and (.id | type == "number")
  ' "$release_json" >/dev/null \
    || die "$tag is not the expected published prerelease"

  index_count="$(jq '[.assets[] | select(.name == "index.toml")] | length' "$release_json")"
  if [ "$index_count" -eq 0 ]; then
    notice "$tag has no index.toml; unresolved keys will be rebuilt"
    continue
  fi
  [ "$index_count" -eq 1 ] || die "$tag has duplicate index.toml assets"
  index_id="$(jq -r '.assets[] | select(.name == "index.toml") | .id' "$release_json")"
  index_size="$(jq -r '.assets[] | select(.name == "index.toml") | .size' "$release_json")"
  index_path="$TMP/releases/$tag.index.toml"
  download_asset "$index_id" "$index_path"
  validate_asset_size "$index_path" "$index_size"
  index_sha="$(sha256sum "$index_path" | awk '{print $1}')"
  index_digest="$(jq -r '.assets[] | select(.name == "index.toml") | .digest // ""' "$release_json")"
  [ "$index_digest" = "sha256:$index_sha" ] \
    || die "$tag index.toml asset digest does not match downloaded bytes"

  candidates="$TMP/releases/$tag.candidates.json"
  "$PYTHON_BIN" "$SELECTOR" select \
    --index "$index_path" \
    --requirements "$TMP/remaining.json" \
    --output "$candidates" \
    --expected-abi "$ABI" \
    || die "$tag index validation failed"
  [ "$(jq 'length' "$candidates")" -gt 0 ] || continue

  release_snapshot "$release_json" > "$TMP/releases/$tag.snapshot.json"
  printf '[]\n' > "$TMP/releases/$tag.selected.json"
  while IFS= read -r encoded_candidate; do
    candidate="$(printf '%s' "$encoded_candidate" | base64 --decode)"
    package="$(jq -r '.package' <<< "$candidate")"
    arch="$(jq -r '.arch' <<< "$candidate")"
    archive_name="$(jq -r '.archive_name' <<< "$candidate")"
    archive_sha="$(jq -r '.archive_sha256' <<< "$candidate")"
    built_by="$(jq -r '.built_by' <<< "$candidate")"
    [[ "$package" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] \
      || die "invalid package name in $tag: $package"
    [[ "$arch" == "wasm32" || "$arch" == "wasm64" ]] \
      || die "invalid architecture in $tag: $arch"

    asset_count="$(jq --arg name "$archive_name" '[.assets[] | select(.name == $name)] | length' "$release_json")"
    if [ "$asset_count" -eq 0 ]; then
      notice "$tag is missing $archive_name; $package/$arch will be rebuilt"
      continue
    fi
    [ "$asset_count" -eq 1 ] || die "$tag has duplicate assets named $archive_name"
    validate_built_by_run "$built_by" "$pr_number" "$pr_head_ref" "$pr_head_sha"

    asset_id="$(jq -r --arg name "$archive_name" '.assets[] | select(.name == $name) | .id' "$release_json")"
    asset_size="$(jq -r --arg name "$archive_name" '.assets[] | select(.name == $name) | .size' "$release_json")"
    asset_digest="$(jq -r --arg name "$archive_name" '.assets[] | select(.name == $name) | .digest // ""' "$release_json")"
    [ "$asset_digest" = "sha256:$archive_sha" ] \
      || die "$tag asset digest for $archive_name does not match index sha256 $archive_sha"
    archive_dir="$TMP/output/${package}-${arch}"
    mkdir -p "$archive_dir"
    archive_path="$archive_dir/$archive_name"
    download_asset "$asset_id" "$archive_path"
    validate_asset_size "$archive_path" "$asset_size"
    actual_archive_sha="$(sha256sum "$archive_path" | awk '{print $1}')"
    [ "$actual_archive_sha" = "$archive_sha" ] \
      || die "$tag downloaded bytes for $archive_name do not match index sha256 $archive_sha"
    validation_index="$TMP/releases/$tag.${package}.${arch}.validation-index.toml"
    printf 'abi_version = %s\ngenerated_at = "stacked-baseline"\ngenerator = "stacked-baseline"\n' \
      "$ABI" > "$validation_index"
    "$XTASK" index-update \
      --index-path "$validation_index" \
      --status success \
      --package "$package" \
      --version "$(jq -r '.version' <<< "$candidate")" \
      --revision "$(jq -r '.revision' <<< "$candidate")" \
      --arch "$arch" \
      --archive-path "$archive_path" \
      --archive-name "$archive_name" \
      --cache-key-sha "$(jq -r '.sha' <<< "$candidate")" \
      --expected-abi "$ABI" \
      --built-at "stacked-baseline" \
      --built-by "$built_by" \
      || die "$tag archive validation failed for $archive_name"

    enriched="$(jq -c \
      --argjson source_pr "$pr_number" \
      --arg source_tag "$tag" \
      --argjson release_id "$(jq '.id' "$release_json")" \
      --argjson index_asset_id "$index_id" \
      --arg index_sha256 "$index_sha" \
      --argjson asset_id "$asset_id" \
      '. + {
        source_pr: $source_pr,
        source_tag: $source_tag,
        release_id: $release_id,
        index_asset_id: $index_asset_id,
        index_sha256: $index_sha256,
        asset_id: $asset_id
      }' <<< "$candidate")"
    jq --argjson entry "$enriched" '. + [$entry]' \
      "$TMP/releases/$tag.selected.json" > "$TMP/releases/$tag.selected.next.json"
    mv "$TMP/releases/$tag.selected.next.json" "$TMP/releases/$tag.selected.json"
    jq --argjson entry "$enriched" '. + [$entry]' \
      "$TMP/selections.json" > "$TMP/selections.next.json"
    mv "$TMP/selections.next.json" "$TMP/selections.json"
    notice "accepted $package/$arch from base PR #$pr_number run ${built_by##*/}"
  done < <(jq -r '.[] | @base64' "$candidates")

  if [ "$(jq 'length' "$TMP/releases/$tag.selected.json")" -gt 0 ]; then
    release_after="$TMP/releases/$tag.after.json"
    api_json "/repos/$REPO/releases/tags/$tag" "$release_after" \
      || die "$tag was deleted while its assets were being resolved"
    release_snapshot "$release_after" > "$TMP/releases/$tag.after.snapshot.json"
    cmp -s "$TMP/releases/$tag.snapshot.json" "$TMP/releases/$tag.after.snapshot.json" \
      || die "$tag mutated while its assets were being resolved"
    remove_selected_requirements \
      "$TMP/remaining.json" \
      "$TMP/releases/$tag.selected.json" \
      "$TMP/remaining.next.json"
    mv "$TMP/remaining.next.json" "$TMP/remaining.json"
  fi
done < <(jq -r '.[] | @base64' "$TMP/chain-before.json")

# Re-read every trust root after downloading. A base push, close, release
# replacement, or index mutation during this operation invalidates the whole
# snapshot instead of quietly mixing states from different moments.
build_chain "$TMP/chain-after.json"
cmp -s "$TMP/chain-before.json" "$TMP/chain-after.json" \
  || die "base PR chain changed while archives were being resolved"
while IFS= read -r snapshot; do
  tag="$(basename "$snapshot" .snapshot.json)"
  release_after="$TMP/releases/$tag.final.json"
  api_json "/repos/$REPO/releases/tags/$tag" "$release_after" \
    || die "$tag was deleted before the baseline snapshot completed"
  release_snapshot "$release_after" > "$TMP/releases/$tag.final.snapshot.json"
  cmp -s "$snapshot" "$TMP/releases/$tag.final.snapshot.json" \
    || die "$tag mutated before the baseline snapshot completed"
done < <(find "$TMP/releases" -maxdepth 1 -name 'pr-*-staging.snapshot.json' -type f | sort)

cp "$TMP/selections.json" "$TMP/output/selections.json"
[ ! -e "$OUTPUT" ] || die "output path appeared while the baseline was being resolved: $OUTPUT"
mkdir -p "$(dirname "$OUTPUT")"
mv "$TMP/output" "$OUTPUT"
notice "resolved $(jq 'length' "$OUTPUT/selections.json") inherited archive(s); $(jq 'length' "$TMP/remaining.json") requirement(s) remain for matrix rebuild"
